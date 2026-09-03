import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Activity, Bot, Check, ChevronRight, CircleAlert, ListChecks, LoaderCircle, Send, Settings, Sparkles, Volume2, VolumeX, X } from 'lucide-react';
import { CapabilityMapper, MockAgentProvider, PermissionEngine, RepeatedToolCallGuard, normalizeAgentDecisionOrRejection, type AgentProvider } from '@buddy/agent-core';
import { detectLocale, directionFor, messages } from '@buddy/localization';
import { AGENT_LIMITS, AgentServiceError, DEFAULT_RULES, safeJson, type ActivityItem, type AgentDecision, type AgentObservation, type AgentRules, type BuddyState, type Locale, type PendingApproval, type PlanStep, type WebMCPTool } from '@buddy/shared';
import { RealtimeVoiceClient, type RealtimeDiagnostics, type RealtimeSessionProvider, type RealtimeVoiceState, type VoiceToolControls, type VoiceToolResult } from './realtime';

export { RealtimeVoiceClient, microphoneConstraints, parseBuddyToolRequest, supportsOpenAIRealtime } from './realtime';
export type { RealtimeBootstrapResult, RealtimeDiagnostics, RealtimeSessionProvider, RealtimeVoiceState, VoiceToolResult, VoiceTranscriptUpdate } from './realtime';

type Tab = 'chat' | 'activity' | 'capabilities' | 'settings';
export type VoiceSubmissionMode = 'review' | 'auto';
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string }
export interface AvatarPosition { x: number; y: number }
export interface StoredSettings { locale: Locale | 'auto'; muted: boolean; theme: 'light' | 'dark' | 'system'; developerMode: boolean; voiceSubmissionMode: VoiceSubmissionMode; rules: AgentRules; position?: AvatarPosition }
type ToolCall = Extract<AgentDecision, { kind: 'tool_call' }>;
interface RunContext { id: number; sessionId: string; goal: string; expectedRevision: number; nextTurn: number; observations: AgentObservation[]; guard: RepeatedToolCallGuard; repairAttempts: Map<string, number>; controller: AbortController; pending: ToolCall | undefined; lastDecision?: AgentDecision['kind']; lastTool?: string; convergenceReason?: string; voice: { resolve: (result: VoiceToolResult) => void; controls: VoiceToolControls } | undefined }

class SiteActionExecutionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The site could not complete that action.', { cause });
    this.name = 'SiteActionExecutionError';
  }
}

export interface BuddyAdapter {
  isSupported(): boolean;
  getTools(): Promise<WebMCPTool[]>;
  subscribe(callback: (tools: WebMCPTool[]) => void): () => void;
  getRevision(): number;
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal, expectedRevision?: number): Promise<unknown>;
}

export interface BuddySettingsStore {
  load(): Promise<Partial<StoredSettings>>;
  save(value: StoredSettings): Promise<void>;
}

const defaults: StoredSettings = { locale: 'auto', muted: true, theme: 'system', developerMode: false, voiceSubmissionMode: 'review', rules: DEFAULT_RULES };
const AVATAR_SIZE = 72;
const VIEWPORT_MARGIN = 12;

function developerErrorSuffix(error: unknown): string {
  if (!(error instanceof AgentServiceError)) return '';
  const detail = error.details;
  return ` [${[detail.status ? `HTTP ${detail.status}` : undefined, detail.code, detail.validationStage, detail.toolName ? `tool ${detail.toolName}` : undefined, `request ${error.requestId}`].filter(Boolean).join(' · ')}]`;
}

function clampPosition(position: AvatarPosition): AvatarPosition {
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(position.x, Math.max(VIEWPORT_MARGIN, innerWidth - AVATAR_SIZE - VIEWPORT_MARGIN))),
    y: Math.max(VIEWPORT_MARGIN, Math.min(position.y, Math.max(VIEWPORT_MARGIN, innerHeight - AVATAR_SIZE - VIEWPORT_MARGIN))),
  };
}

const browserSettingsStore: BuddySettingsStore = {
  async load() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const result = await chrome.storage.local.get('buddySettings'); return result.buddySettings as Partial<StoredSettings> | undefined ?? {};
    }
    try { return JSON.parse(localStorage.getItem('buddySettings') ?? '{}') as Partial<StoredSettings>; } catch { return {}; }
  },
  async save(value) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) await chrome.storage.local.set({ buddySettings: value });
    else localStorage.setItem('buddySettings', JSON.stringify(value));
  },
};

async function loadSettings(store: BuddySettingsStore): Promise<StoredSettings> {
  const stored = await store.load();
  return { ...defaults, ...stored, rules: { ...DEFAULT_RULES, ...stored.rules } };
}

function boundedResult(value: unknown): unknown {
  const serialized = safeJson(value, AGENT_LIMITS.maxResultCharacters);
  try { return JSON.parse(serialized) as unknown; } catch { return serialized; }
}

function sanitizeDiagnosticValue(value: unknown, key = '', depth = 0): unknown {
  if (/password|secret|token|authorization|cookie|credential|credit.?card|ssn|passport|medical|health/i.test(key)) return '[redacted]';
  if (depth > 4) return '[bounded]';
  if (typeof value === 'string') return `[string:${value.length}]`;
  if (typeof value === 'number') return '[number]';
  if (typeof value === 'boolean') return '[boolean]';
  if (value === null) return '[null]';
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeDiagnosticValue(item, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 24).map(([nestedKey, nested]) => [nestedKey, sanitizeDiagnosticValue(nested, nestedKey, depth + 1)]));
  return undefined;
}

function summarizeObservation(observation: AgentObservation | undefined): string {
  if (!observation) return 'none';
  if (observation.outcome !== 'success') return `${observation.outcome}:${(observation.error ?? '').slice(0, 120)}`;
  const result = observation.result;
  if (Array.isArray(result)) return `success:array(${result.length})`;
  if (result && typeof result === 'object') return `success:object(${Object.keys(result).slice(0, 12).join(',')})`;
  return `success:${typeof result}`;
}

export function upsertVoiceTranscript(items: ChatMessage[], update: { key: string; role: ChatMessage['role']; text: string; final: boolean }): ChatMessage[] {
  const id = `voice-${update.role}-${update.key}`;
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return [...items, { id, role: update.role, text: update.text }];
  const next = [...items]; const current = next[index];
  if (current) next[index] = { ...current, text: update.final ? update.text : `${current.text}${update.text}` };
  return next;
}

export function createApprovalSnapshot(args: Record<string, unknown>): { args: Record<string, unknown>; argumentsJson: string } {
  const compact = JSON.stringify(args);
  if (!compact) throw new Error('Buddy could not prepare these action arguments for review.');
  const snapshot = JSON.parse(compact) as unknown;
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) throw new Error('Buddy could not prepare these action arguments for review.');
  return { args: snapshot as Record<string, unknown>, argumentsJson: JSON.stringify(snapshot, null, 2) };
}

export interface ApprovalArgumentRow { label: string; value: string }

const humanizeArgumentKey = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (character) => character.toUpperCase());

export function createApprovalActionLabel(label: string, toolName: string): string {
  const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutTechnicalName = label.replace(new RegExp(escapedToolName, 'gi'), ' ').replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return withoutTechnicalName || humanizeArgumentKey(toolName);
}

export function createApprovalArgumentRows(args: Record<string, unknown>): ApprovalArgumentRow[] {
  const rows: ApprovalArgumentRow[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      if (!value.length) rows.push({ label: path.join(' › '), value: 'None' });
      else value.forEach((item, index) => visit(item, [...path, `Item ${index + 1}`]));
      return;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) rows.push({ label: path.join(' › '), value: 'None' });
      else entries.forEach(([key, nested]) => visit(nested, [...path, humanizeArgumentKey(key)]));
      return;
    }
    rows.push({ label: path.join(' › '), value: value === null ? 'None' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value) });
  };
  Object.entries(args).forEach(([key, value]) => visit(value, [humanizeArgumentKey(key)]));
  return rows.length ? rows : [{ label: 'Arguments', value: 'None' }];
}

export interface SpeechToTextProvider { supported: boolean; listen(locale: Locale): Promise<string>; stop(): void }
export interface TextToSpeechProvider { supported: boolean; speak(text: string, locale: Locale): void; stop(): void }

class BrowserSpeechToText implements SpeechToTextProvider {
  private recognition: { start(): void; stop(): void } | undefined;
  supported = 'webkitSpeechRecognition' in globalThis || 'SpeechRecognition' in globalThis;
  listen(locale: Locale): Promise<string> {
    return new Promise((resolve, reject) => {
      const scope = globalThis as unknown as { webkitSpeechRecognition?: new () => any; SpeechRecognition?: new () => any };
      const Constructor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
      if (!Constructor) { reject(new Error('Voice input is unavailable in this browser.')); return; }
      const recognition = new Constructor(); this.recognition = recognition; recognition.lang = locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US';
      recognition.interimResults = false; recognition.maxAlternatives = 1;
      recognition.onresult = (event: any) => resolve(String(event.results[0][0].transcript));
      recognition.onerror = (event: any) => reject(new Error(event.error === 'not-allowed' ? 'Microphone permission was denied.' : 'I could not hear that clearly.'));
      recognition.onend = () => { this.recognition = undefined; }; recognition.start();
    });
  }
  stop() { this.recognition?.stop(); }
}

class BrowserTextToSpeech implements TextToSpeechProvider {
  supported = 'speechSynthesis' in globalThis;
  speak(text: string, locale: Locale) { if (!this.supported) return; speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US'; utterance.rate = 0.96; speechSynthesis.speak(utterance); }
  stop() { if (this.supported) speechSynthesis.cancel(); }
}

function Mascot({ state, onActivate, onPointerDown, onPointerMove, onPointerUp, onKeyDown, label, buttonRef, position }: {
  state: BuddyState; onActivate: () => void; onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void; onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void; label: string; buttonRef: RefObject<HTMLButtonElement | null>; position?: AvatarPosition | undefined;
}) {
  const style = position ? ({ '--buddy-x': `${position.x}px`, '--buddy-y': `${position.y}px` } as CSSProperties) : undefined;
  return <button ref={buttonRef} className={`buddy-mascot buddy-state-${state.toLowerCase()}`} style={style} onClick={onActivate} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onKeyDown} aria-label={`${label}. Drag to move, or use arrow keys.`} title={label}>
    <span className="buddy-shell"><span className="buddy-face"><span className="buddy-eye buddy-eye-left"/><span className="buddy-eye buddy-eye-right"/><span className="buddy-mouth"/></span><span className="buddy-status-dot"/></span>
  </button>;
}

function ApprovalCard({ approval, locale, developerMode, onApprove, onCancel }: { approval: PendingApproval; locale: Locale; developerMode: boolean; onApprove: () => void; onCancel: () => void }) {
  const t = messages[locale];
  const argumentRows = createApprovalArgumentRows(approval.step.args);
  return <section className="buddy-approval" aria-labelledby="buddy-approval-title">
    <div className="buddy-approval-heading"><CircleAlert size={18}/><h3 id="buddy-approval-title">{t.approvalTitle}</h3></div>
    <dl><div><dt>What</dt><dd>{approval.what}</dd></div><div><dt>Why</dt><dd>{approval.why}</dd></div><div><dt>Site</dt><dd>{approval.site}</dd></div><div><dt>Risk</dt><dd>{approval.risk.replaceAll('_', ' ')}</dd></div>{developerMode && <div><dt>Tool</dt><dd><code>{approval.step.toolName}</code></dd></div>}</dl>
    <div className="buddy-approval-values" aria-label="Action details">{argumentRows.map((row, index) => <div key={`${row.label}-${index}`}><span>{row.label}</span><strong>{row.value}</strong></div>)}</div>
    {developerMode && <details className="buddy-approval-technical"><summary>Raw arguments</summary><pre><code>{approval.argumentsJson}</code></pre></details>}
    <div className="buddy-approval-actions"><button className="buddy-secondary" onClick={onCancel}>{t.cancel}</button><button className="buddy-primary" onClick={onApprove}>{t.approve}</button></div>
  </section>;
}

export interface BuddyAppProps { adapter: BuddyAdapter; provider?: AgentProvider; realtimeProvider?: RealtimeSessionProvider; siteName?: string; demoOpen?: boolean; speechProvider?: SpeechToTextProvider; voiceProvider?: TextToSpeechProvider; settingsStore?: BuddySettingsStore }

export function BuddyApp({ adapter, provider = new MockAgentProvider(), realtimeProvider, siteName = location.hostname, demoOpen = false, speechProvider, voiceProvider, settingsStore = browserSettingsStore }: BuddyAppProps) {
  const [tools, setTools] = useState<WebMCPTool[]>([]); const [state, setState] = useState<BuddyState>('SLEEPING');
  const [open, setOpen] = useState(demoOpen); const [tab, setTab] = useState<Tab>('chat'); const [input, setInput] = useState('');
  const [settings, setSettings] = useState<StoredSettings>(defaults); const [settingsLoaded, setSettingsLoaded] = useState(false); const [position, setPosition] = useState<AvatarPosition>();
  const [activity, setActivity] = useState<ActivityItem[]>([]); const [approval, setApproval] = useState<PendingApproval>();
  const [messagesList, setMessagesList] = useState<ChatMessage[]>([]); const [showNotice, setShowNotice] = useState(false);
  const [voiceState, setVoiceState] = useState<RealtimeVoiceState>('IDLE'); const [voiceMode, setVoiceMode] = useState<'off' | 'realtime' | 'browser-fallback'>('off');
  const [voiceDiagnostics, setVoiceDiagnostics] = useState<RealtimeDiagnostics>({ voiceMode: 'realtime', connectionState: 'IDLE', microphoneState: 'inactive', reconnectAttempt: 0 }); const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null); const mascotRef = useRef<HTMLButtonElement>(null); const activeRun = useRef<RunContext | undefined>(undefined); const runSequence = useRef(0); const suppressClick = useRef(false);
  const realtimeRef = useRef<RealtimeVoiceClient | undefined>(undefined); const voiceToolHandler = useRef<((request: string, controls: VoiceToolControls) => Promise<VoiceToolResult>) | undefined>(undefined); const voiceModeRef = useRef(voiceMode);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: AvatarPosition; moved: boolean } | undefined>(undefined);
  const speech = useMemo(() => speechProvider ?? new BrowserSpeechToText(), [speechProvider]); const voice = useMemo(() => voiceProvider ?? new BrowserTextToSpeech(), [voiceProvider]);
  const locale = settings.locale === 'auto' ? detectLocale() : settings.locale; const t = messages[locale]; const capabilities = useMemo(() => new CapabilityMapper().map(tools), [tools]);

  useEffect(() => { voiceModeRef.current = voiceMode; }, [voiceMode]);
  useEffect(() => {
    if (!realtimeProvider) return;
    const client = new RealtimeVoiceClient({
      provider: realtimeProvider,
      onState: setVoiceState,
      onDiagnostics: setVoiceDiagnostics,
      onMicrophoneLevel: setMicrophoneLevel,
      onError: (message, code) => {
        setMessagesList((items) => [...items, { id: crypto.randomUUID(), role: 'assistant', text: message }]);
        setVoiceDiagnostics((current) => ({ ...current, lastSafeErrorCode: code }));
      },
      onTranscript: ({ key, role, text, final }) => {
        setMessagesList((items) => upsertVoiceTranscript(items, { key, role, text, final }));
      },
      onToolRequest: (request, controls) => voiceToolHandler.current?.(request, controls) ?? Promise.resolve({ status: 'failed', message: 'Buddy could not safely prepare that site action.' }),
    });
    realtimeRef.current = client;
    return () => { client.stop(); if (realtimeRef.current === client) realtimeRef.current = undefined; };
  }, [realtimeProvider]);
  useEffect(() => {
    const stopVoiceForPageExit = () => realtimeRef.current?.stop();
    addEventListener('pagehide', stopVoiceForPageExit);
    return () => removeEventListener('pagehide', stopVoiceForPageExit);
  }, []);

  useEffect(() => { void loadSettings(settingsStore).then((loaded) => { setSettings(loaded); if (loaded.position) setPosition(clampPosition(loaded.position)); setSettingsLoaded(true); }); }, [settingsStore]);
  useEffect(() => { if (settingsLoaded) void settingsStore.save({ ...settings, ...(position ? { position } : {}) }); }, [position, settings, settingsLoaded, settingsStore]);
  useEffect(() => { const onResize = () => setPosition((current) => current ? clampPosition(current) : current); addEventListener('resize', onResize); return () => removeEventListener('resize', onResize); }, []);
  useEffect(() => {
    let unsubscribe: () => void = () => undefined; let active = true;
    const applyTools = (found: WebMCPTool[], changed: boolean) => {
      if (!active) return;
      if (changed && activeRun.current) { activeRun.current.voice?.resolve({ status: 'canceled', message: 'The site actions changed, so Buddy canceled the request.' }); activeRun.current.controller.abort(); activeRun.current = undefined; setApproval(undefined); }
      setTools(found);
      if (!found.length) { realtimeRef.current?.stop(); setVoiceMode('off'); setOpen(false); setShowNotice(false); setState('SLEEPING'); return; }
      setState('DETECTED'); setShowNotice(true);
    };
    const detect = async () => {
      try { applyTools(adapter.isSupported() ? await adapter.getTools() : [], false); unsubscribe = adapter.subscribe((updated) => applyTools(updated, true)); }
      catch { applyTools([], false); }
    };
    void detect(); return () => { active = false; unsubscribe(); activeRun.current?.controller.abort(); realtimeRef.current?.stop(); };
  }, [adapter]);
  useEffect(() => { if (state === 'DETECTED') { const timer = setTimeout(() => setState('IDLE'), 900); return () => clearTimeout(timer); } }, [state]);
  useEffect(() => { if (showNotice) { const timer = setTimeout(() => setShowNotice(false), 4_000); return () => clearTimeout(timer); } }, [showNotice]);
  useEffect(() => { if (!messagesList.length && tools.length) setMessagesList([{ id: crypto.randomUUID(), role: 'assistant', text: `${t.detected} ${t.found(capabilities.length)} ${t.welcome}` }]); }, [tools.length, capabilities.length, messagesList.length, t]);
  useEffect(() => {
    if (!tools.length) return;
    let frame = 0;
    const track = (event: PointerEvent) => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { const rect = mascotRef.current?.getBoundingClientRect(); if (!rect || !rootRef.current) return; const dx = event.clientX - (rect.left + rect.width / 2); const dy = event.clientY - (rect.top + rect.height / 2); const distance = Math.max(1, Math.hypot(dx, dy)); rootRef.current.style.setProperty('--buddy-look-x', `${Math.max(-3, Math.min(3, dx / distance * 3))}px`); rootRef.current.style.setProperty('--buddy-look-y', `${Math.max(-2, Math.min(2, dy / distance * 2))}px`); }); };
    document.addEventListener('pointermove', track, { passive: true }); return () => { cancelAnimationFrame(frame); document.removeEventListener('pointermove', track); };
  }, [tools.length]);

  const addMessage = (role: ChatMessage['role'], text: string) => { setMessagesList((items) => [...items, { id: crypto.randomUUID(), role, text }]); if (role === 'assistant' && !settings.muted && voiceModeRef.current !== 'realtime') voice.speak(text, locale); };
  const updateActivity = (id: string, patch: Partial<ActivityItem>) => setActivity((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const stopRun = (run: RunContext) => { if (activeRun.current?.id === run.id) activeRun.current = undefined; };

  const logIteration = (run: RunContext, turn: number, decision: AgentDecision, executionStatus: string, repeatedCall: boolean) => {
    if (!settings.developerMode) return;
    console.debug('buddy_agent_iteration', {
      sessionId: run.sessionId,
      turn,
      decisionKind: decision.kind,
      toolName: 'toolName' in decision ? decision.toolName : undefined,
      sanitizedArgs: 'args' in decision ? sanitizeDiagnosticValue(decision.args) : undefined,
      executionStatus,
      observationKind: run.observations.at(-1)?.outcome ?? 'none',
      observationSummary: summarizeObservation(run.observations.at(-1)),
      repeatedCall,
      toolInventoryRevision: run.expectedRevision,
    });
  };

  const executeCall = async (run: RunContext, call: ToolCall): Promise<{ text: string; repeatedResult: boolean }> => {
    const started = performance.now(); setState('EXECUTING'); updateActivity(call.callId, { status: 'running' });
    try {
      const result = await adapter.execute(call.toolName, call.args, run.controller.signal, run.expectedRevision);
      const step: PlanStep = { id: call.callId, toolName: call.toolName, args: call.args, label: call.label, risk: call.risk };
      const text = await provider.interpretToolResult(step, result);
      updateActivity(call.callId, { status: 'done', detail: text, technical: { tool: call.toolName, durationMs: Math.round(performance.now() - started), request: call.args, response: result } });
      const bounded = boundedResult(result);
      run.observations.push({ callId: call.callId, toolName: call.toolName, args: call.args, outcome: 'success', result: bounded });
      return { text, repeatedResult: run.guard.recordSuccess(call, bounded) };
    } catch (error) {
      if (run.controller.signal.aborted) throw error;
      const text = error instanceof Error ? error.message : 'The site could not complete that action.';
      updateActivity(call.callId, { status: 'failed', detail: 'That site action could not be completed.', technical: { tool: call.toolName, durationMs: Math.round(performance.now() - started), request: call.args, response: text } }); run.observations.push({ callId: call.callId, toolName: call.toolName, args: call.args, outcome: 'error', error: text });
      setState('ERROR'); throw new SiteActionExecutionError(error);
    }
  };

  const continueRun = async (run: RunContext) => {
    try {
      while (run.nextTurn < AGENT_LIMITS.maxTurns && activeRun.current?.id === run.id && !run.controller.signal.aborted) {
        setState('THINKING');
        const turn = run.nextTurn; run.nextTurn += 1;
        const raw = await provider.next({ sessionId: run.sessionId, turn, goal: run.goal, tools, observations: run.observations }, run.controller.signal);
        if (adapter.getRevision() !== run.expectedRevision) throw new Error('The site actions changed. Please review a fresh request.');
        const decision = normalizeAgentDecisionOrRejection(raw, tools);
        run.lastDecision = decision.kind; if ('toolName' in decision) run.lastTool = decision.toolName;
        if (decision.kind === 'final' || decision.kind === 'needs_input') {
          logIteration(run, turn, decision, 'not_applicable', false);
          if (run.voice) { run.voice.resolve({ status: 'completed', message: decision.message }); run.voice = undefined; }
          else addMessage('assistant', decision.message);
          setState(decision.kind === 'final' ? 'SUCCESS' : 'IDLE'); stopRun(run); return;
        }
        if (decision.kind === 'rejected_tool_call') {
          const repairs = (run.repairAttempts.get(decision.toolName) ?? 0) + 1;
          run.repairAttempts.set(decision.toolName, repairs);
          run.observations.push({ callId: decision.callId, toolName: decision.toolName, args: decision.args, outcome: 'rejected', error: decision.message });
          setActivity((items) => [...items, { id: decision.callId, label: 'Correct invalid action details', status: 'failed', detail: 'Buddy rejected invalid arguments and asked the AI to correct them.', technical: { tool: decision.toolName, request: decision.args, response: decision.message } }]);
          logIteration(run, turn, decision, 'validation_rejected', repairs > 1);
          if (repairs > 1) {
            run.convergenceReason = 'schema repair failed twice';
            const message = "I couldn't safely prepare valid action details after one correction attempt, so I stopped without executing it.";
            if (run.voice) { run.voice.resolve({ status: 'failed', message }); run.voice = undefined; } else addMessage('assistant', message);
            setState('IDLE'); stopRun(run); return;
          }
          continue;
        }
        try { run.guard.assertNew(decision); }
        catch {
          run.convergenceReason = 'semantically repeated tool call';
          logIteration(run, turn, decision, 'not_executed', true);
          const message = 'I already tried that site action with the same details. I stopped the loop safely; the previous result is still available above.';
          if (run.voice) { run.voice.resolve({ status: 'completed', message }); run.voice = undefined; } else addMessage('assistant', message);
          setState('SUCCESS'); stopRun(run); return;
        }
        const actionLabel = createApprovalActionLabel(decision.label, decision.toolName);
        const displayCall = { ...decision, label: actionLabel };
        setActivity((items) => [...items, { id: decision.callId, label: actionLabel, status: 'pending' }]);
        const permission = new PermissionEngine().evaluate(decision, settings.rules);
        if (permission === 'BLOCK') {
          const message = `I stopped before “${actionLabel}” because your rules block this action.`;
          updateActivity(decision.callId, { status: 'canceled', detail: 'Blocked by your Buddy rules.' });
          if (run.voice) { run.voice.resolve({ status: 'blocked', message }); run.voice = undefined; } else addMessage('assistant', message);
          setState('IDLE'); stopRun(run); return;
        }
        if (permission === 'ASK') {
          const reviewed = createApprovalSnapshot(decision.args);
          const reviewedCall = { ...displayCall, args: reviewed.args };
          run.pending = reviewedCall; setApproval({ step: { id: reviewedCall.callId, toolName: reviewedCall.toolName, args: reviewedCall.args, label: reviewedCall.label, risk: reviewedCall.risk }, what: reviewedCall.label, why: reviewedCall.reason, argumentsJson: reviewed.argumentsJson, site: siteName, risk: reviewedCall.risk }); setState('WAITING_FOR_APPROVAL'); run.voice?.controls.announceApprovalRequired(); return;
        }
        const execution = await executeCall(run, displayCall);
        logIteration(run, turn, decision, 'success', execution.repeatedResult);
        if (execution.repeatedResult) {
          run.convergenceReason = 'same tool returned the same semantic result';
          const message = `${execution.text} The site returned the same information again, so I stopped repeating the search.`;
          if (run.voice) { run.voice.resolve({ status: 'completed', message }); run.voice = undefined; } else addMessage('assistant', message);
          setState('SUCCESS'); stopRun(run); return;
        }
      }
      if (!run.controller.signal.aborted && activeRun.current?.id === run.id) {
        run.convergenceReason ??= 'the provider did not return final before the hard safety ceiling';
        const normalMessage = "I couldn't finish because the site actions did not produce a conclusive answer. I stopped safely and made no further changes.";
        const diagnostic = settings.developerMode ? ` [last decision: ${run.lastDecision ?? 'none'} · last tool: ${run.lastTool ?? 'none'} · last observation: ${run.observations.at(-1)?.outcome ?? 'none'} · reason: ${run.convergenceReason}]` : '';
        const message = `${normalMessage}${diagnostic}`;
        if (run.voice) { run.voice.resolve({ status: 'failed', message }); run.voice = undefined; } else addMessage('assistant', message);
        setState('ERROR'); stopRun(run); return;
      }
    } catch (error) {
      if (!run.controller.signal.aborted) {
        setState('ERROR');
        const siteActionFailed = error instanceof SiteActionExecutionError;
        const suffix = settings.developerMode ? developerErrorSuffix(error) : '';
        const technical = siteActionFailed && settings.developerMode ? ` [${error.message}]` : '';
        const message = siteActionFailed
          ? `That site action could not be completed, so Buddy stopped safely.${technical}`
          : `${error instanceof Error ? error.message : 'The agent stopped unexpectedly.'}${suffix} No further action was taken.`;
        if (run.voice) { run.voice.resolve({ status: 'failed', message }); run.voice = undefined; } else addMessage('assistant', message);
      }
      stopRun(run);
    }
  };

  const sendGoal = async (goal: string, voiceControls?: VoiceToolControls): Promise<VoiceToolResult> => {
    const cleanGoal = goal.trim(); if (!cleanGoal || !tools.length) return { status: 'failed', message: 'This site does not currently expose an action Buddy can use.' };
    activeRun.current?.voice?.resolve({ status: 'canceled', message: 'A newer request replaced this one.' }); activeRun.current?.controller.abort(); setApproval(undefined);
    if (!voiceControls) addMessage('user', cleanGoal); setInput('');
    let resolveVoice: ((result: VoiceToolResult) => void) | undefined;
    const result = voiceControls ? new Promise<VoiceToolResult>((resolve) => { resolveVoice = resolve; }) : undefined;
    const run: RunContext = { id: ++runSequence.current, sessionId: crypto.randomUUID(), goal: cleanGoal, expectedRevision: adapter.getRevision(), nextTurn: 0, observations: [], guard: new RepeatedToolCallGuard(), repairAttempts: new Map(), controller: new AbortController(), pending: undefined, voice: voiceControls && resolveVoice ? { resolve: resolveVoice, controls: voiceControls } : undefined };
    activeRun.current = run; void continueRun(run);
    if (result) return result;
    return { status: 'completed', message: 'Buddy finished the text request.' };
  };
  voiceToolHandler.current = (request, controls) => sendGoal(request, controls);
  const submit = (event: FormEvent) => { event.preventDefault(); void sendGoal(input); };
  const approve = async () => {
    const run = activeRun.current; const call = run?.pending; if (!run || !call) return;
    if (adapter.getRevision() !== run.expectedRevision) { run.controller.abort(); setApproval(undefined); setState('ERROR'); const message = 'The site actions changed before approval. I canceled the action.'; if (run.voice) { run.voice.resolve({ status: 'canceled', message }); run.voice = undefined; } else addMessage('assistant', message); stopRun(run); return; }
    run.pending = undefined; setApproval(undefined);
    try { await executeCall(run, call); await continueRun(run); } catch { stopRun(run); }
  };
  const cancelApproval = () => {
    const run = activeRun.current; const call = run?.pending; if (call) updateActivity(call.callId, { status: 'canceled', detail: 'Canceled by you. Nothing was executed.' });
    const wasVoice = Boolean(run?.voice);
    if (run) { if (run.voice) { run.voice.resolve({ status: 'canceled', message: 'Canceled. I did not perform that action.' }); run.voice = undefined; } run.controller.abort(); stopRun(run); } setApproval(undefined); setState('IDLE'); if (!wasVoice) addMessage('assistant', 'Canceled. I did not perform that action.');
  };
  const listen = async () => {
    if (!speech.supported) { addMessage('assistant', 'Voice input is unavailable here, but you can type your goal.'); return; }
    setState('LISTENING'); try { const transcript = await speech.listen(locale); setState('IDLE'); if (settings.voiceSubmissionMode === 'auto') await sendGoal(transcript); else setInput(transcript); } catch (error) { setState('ERROR'); addMessage('assistant', error instanceof Error ? error.message : 'Voice input failed.'); }
  };
  const stopVoice = () => { realtimeRef.current?.stop(); speech.stop(); voice.stop(); setVoiceMode('off'); setVoiceState('IDLE'); };
  const toggleVoice = async () => {
    if (voiceMode === 'realtime') { stopVoice(); return; }
    if (voiceMode === 'browser-fallback') { await listen(); return; }
    if (realtimeProvider?.supported && realtimeRef.current) {
      setVoiceMode('realtime');
      try { await realtimeRef.current.start(locale); return; }
      catch (error) {
        const reason = error instanceof DOMException && error.name === 'NotAllowedError' ? 'microphone-permission-denied' : error instanceof Error ? error.message : 'realtime-unavailable';
        if (reason === 'microphone-permission-denied') { setVoiceMode('off'); return; }
        setVoiceMode('browser-fallback'); setVoiceDiagnostics((current) => ({ ...current, voiceMode: 'browser-fallback', fallbackReason: reason }));
        addMessage('assistant', 'Realtime voice is unavailable, so Buddy switched to browser voice fallback.');
        await listen();
        return;
      }
    }
    setVoiceMode('browser-fallback'); setVoiceDiagnostics((current) => ({ ...current, voiceMode: 'browser-fallback', fallbackReason: 'webrtc-unsupported' }));
    addMessage('assistant', 'Realtime voice is unavailable, so Buddy is using browser voice fallback.');
    await listen();
  };

  const onDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => { const rect = event.currentTarget.getBoundingClientRect(); drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { x: rect.left, y: rect.top }, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => { const current = drag.current; if (!current || current.pointerId !== event.pointerId) return; const dx = event.clientX - current.startX; const dy = event.clientY - current.startY; if (Math.hypot(dx, dy) > 5) current.moved = true; if (current.moved) setPosition(clampPosition({ x: current.origin.x + dx, y: current.origin.y + dy })); };
  const onDragEnd = (event: ReactPointerEvent<HTMLButtonElement>) => { const current = drag.current; if (!current || current.pointerId !== event.pointerId) return; suppressClick.current = current.moved; drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const onMascotActivate = () => { if (suppressClick.current) { suppressClick.current = false; return; } setOpen((value) => { if (value) stopVoice(); return !value; }); };
  const onMascotKey = (event: KeyboardEvent<HTMLButtonElement>) => { const offsets: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }; const offset = offsets[event.key]; if (!offset) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setPosition(clampPosition({ x: (position?.x ?? rect.left) + offset[0], y: (position?.y ?? rect.top) + offset[1] })); };

  if (!tools.length) return null;
  const tooltip = `${t.detected} ${t.found(capabilities.length)}`; const busy = state === 'EXECUTING' || state === 'THINKING';
  const voiceActive = voiceMode === 'realtime' && voiceState !== 'IDLE' && voiceState !== 'ERROR';
  const voiceConnecting = ['VOICE_CONNECTING', 'MIC_ACQUIRED', 'PEER_CONNECTING', 'PEER_CONNECTED'].includes(voiceState);
  const voiceStatus: Partial<Record<RealtimeVoiceState, string>> = { VOICE_CONNECTING: 'Starting Voice Mode…', MIC_ACQUIRED: 'Microphone ready…', PEER_CONNECTING: 'Connecting…', PEER_CONNECTED: 'Voice connected…', DATA_CHANNEL_OPEN: 'Voice channel ready…', LISTENING: 'Listening…', SPEECH_STARTED: 'Hearing you…', SPEECH_STOPPED: 'Speech received…', USER_TRANSCRIPT: 'Transcript ready…', MODEL_PROCESSING: 'Thinking…', ASSISTANT_AUDIO_STARTED: 'Speaking…', ASSISTANT_AUDIO_FINISHED: 'Finished speaking', WAITING_FOR_APPROVAL: 'Waiting for approval…', RECONNECTING: 'Reconnecting…', STOPPING: 'Ending voice…', ERROR: 'Voice unavailable' };
  const rootStyle = ({ '--buddy-voice-level': microphoneLevel.toFixed(2) } as CSSProperties);
  return <div ref={rootRef} className={`buddy-root buddy-theme-${settings.theme}`} style={rootStyle} dir={directionFor(locale)} data-buddy-state={state} data-voice-state={voiceState}>
    {showNotice && !open && <div className="buddy-wake-notice" role="status">{t.detected}<span>{t.found(capabilities.length)}</span></div>}
    {open && <aside className="buddy-panel" aria-label="Buddy companion panel">
      <header className="buddy-header"><div><span className="buddy-eyebrow">BUDDY</span><h2>{siteName}</h2><p><span className="buddy-site-dot active"/>{tools.length} site actions available</p></div><button className="buddy-icon-button" onClick={() => { stopVoice(); setOpen(false); }} aria-label="Close Buddy"><X size={19}/></button></header>
      <nav className="buddy-tabs" aria-label="Buddy views" role="tablist">{(['chat','activity','capabilities','settings'] as Tab[]).map((item, index) => <button key={item} onClick={() => setTab(item)} aria-selected={tab === item} role="tab">{[<Bot key="chat"/>,<ListChecks key="activity"/>,<Sparkles key="capabilities"/>,<Settings key="settings"/>][index]}<span>{t.tabs[index]}</span></button>)}</nav>
      <div className="buddy-content">
        {tab === 'chat' && <div className="buddy-chat" aria-live="polite">{messagesList.map((message) => <div key={message.id} className={`buddy-message ${message.role}`}>{message.text}</div>)}{busy && <div className="buddy-thinking" role="status"><LoaderCircle/> {state === 'THINKING' ? 'Choosing the next safe action…' : 'Waiting for the site…'}</div>}{approval && <ApprovalCard approval={approval} locale={locale} developerMode={settings.developerMode} onApprove={() => void approve()} onCancel={cancelApproval}/>}</div>}
        {tab === 'activity' && <section><div className="buddy-section-title"><Activity/><div><h3>What Buddy did</h3><p>A clear trail, not a technical log.</p></div></div><div className="buddy-activity">{!activity.length && <p className="buddy-muted">Completed steps will appear here.</p>}{activity.map((item) => <div className="buddy-activity-item" key={item.id}><span className={`buddy-check ${item.status}`}>{item.status === 'done' ? <Check/> : item.status === 'failed' ? <CircleAlert/> : <ChevronRight/>}</span><div><strong>{item.label}</strong>{item.detail && <p>{item.detail}</p>}{settings.developerMode && item.technical && <details><summary>Technical details</summary><pre>{safeJson(item.technical, 900)}</pre></details>}</div></div>)}</div></section>}
        {tab === 'capabilities' && <section><div className="buddy-section-title"><Sparkles/><div><h3>What I can do here</h3><p>Translated into everyday language.</p></div></div><div className="buddy-capabilities">{capabilities.map((capability) => <article key={capability.id}><span>{capability.label}</span><p>{capability.description}</p>{settings.developerMode && <code>{capability.toolNames.join(', ')}</code>}</article>)}</div></section>}
        {tab === 'settings' && <SettingsView settings={settings} setSettings={setSettings} voiceSupported={Boolean(realtimeProvider?.supported || (speech.supported && voice.supported))} voiceDiagnostics={voiceDiagnostics}/>}
      </div>
        {tab === 'chat' && <footer className="buddy-composer"><div className="buddy-suggestions"><button onClick={() => setInput('Show what you can do')}>Show what you can do</button><button onClick={() => setInput('Help me choose the best option')}>Help me choose</button></div><form onSubmit={submit}><label className="buddy-sr-only" htmlFor="buddy-goal">{t.placeholder}</label><textarea id="buddy-goal" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t.placeholder} rows={2} maxLength={AGENT_LIMITS.maxGoalLength}/><div className="buddy-compose-actions"><button type="button" className={`buddy-voice-button voice-${voiceState.toLowerCase()}`} onClick={() => void toggleVoice()} disabled={voiceConnecting} aria-label={voiceActive ? 'End voice conversation' : 'Start voice conversation'} aria-pressed={voiceActive}><span className="buddy-waveform" aria-hidden="true">{[0,1,2,3,4].map((bar) => <i key={bar}/>)}</span></button><button type="submit" className="buddy-send" disabled={!input.trim() || busy || state === 'WAITING_FOR_APPROVAL'} aria-label="Send goal"><Send/></button></div></form>{(voiceActive || voiceMode === 'browser-fallback' || voiceState === 'ERROR') && <div className="buddy-voice-status" role="status"><span className={voiceActive ? 'active' : ''}/>{voiceMode === 'browser-fallback' ? 'Browser voice fallback' : voiceStatus[voiceState]}</div>}</footer>}
    </aside>}
    <Mascot state={state} onActivate={onMascotActivate} onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onKeyDown={onMascotKey} label={tooltip} buttonRef={mascotRef} position={position}/>
  </div>;
}

function SettingsView({ settings, setSettings, voiceSupported, voiceDiagnostics }: { settings: StoredSettings; setSettings: (value: StoredSettings) => void; voiceSupported: boolean; voiceDiagnostics: RealtimeDiagnostics }) {
  const setRule = (name: keyof AgentRules, value: boolean) => setSettings({ ...settings, rules: { ...settings.rules, [name]: value } });
  return <section className="buddy-settings"><div className="buddy-section-title"><Settings/><div><h3>My Buddy rules</h3><p>Your rules stay on this device.</p></div></div>
    <label>Language<select value={settings.locale} onChange={(event) => setSettings({ ...settings, locale: event.target.value as StoredSettings['locale'] })}><option value="auto">Auto</option><option value="en">English</option><option value="ar">العربية</option><option value="es">Español</option></select></label>
    <label>Appearance<select value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value as StoredSettings['theme'] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <label>Voice submit<select value={settings.voiceSubmissionMode} onChange={(event) => setSettings({ ...settings, voiceSubmissionMode: event.target.value as VoiceSubmissionMode })}><option value="review">Review transcript</option><option value="auto">Send automatically</option></select></label>
    <div className="buddy-rule-group"><h4>Ask me before</h4>{([['askBeforeSubmit','Submitting forms'],['askBeforeMessages','Sending messages'],['askBeforePurchase','Purchases or reservations'],['askBeforeSensitive','Sharing sensitive information'],['blockDelete','Deleting anything']] as const).map(([key,label]) => <label className="buddy-switch" key={key}><span>{label}</span><input type="checkbox" checked={settings.rules[key]} onChange={(event) => setRule(key, event.target.checked)}/><i/></label>)}</div>
    <label className="buddy-switch"><span>{settings.muted ? <VolumeX/> : <Volume2/>} Voice responses {!voiceSupported && '(unavailable)'}</span><input type="checkbox" checked={!settings.muted} disabled={!voiceSupported} onChange={(event) => setSettings({ ...settings, muted: !event.target.checked })}/><i/></label>
    <label className="buddy-switch"><span>Developer mode</span><input type="checkbox" checked={settings.developerMode} onChange={(event) => setSettings({ ...settings, developerMode: event.target.checked })}/><i/></label>
    {settings.developerMode && <details className="buddy-voice-diagnostics"><summary>Realtime diagnostics</summary><pre>{safeJson(voiceDiagnostics, 1_500)}</pre></details>}
  </section>;
}
