import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Activity, Bot, Check, ChevronRight, CircleAlert, ListChecks, LoaderCircle, Mic, MicOff, Send, Settings, Sparkles, Volume2, VolumeX, X } from 'lucide-react';
import { CapabilityMapper, MockAgentProvider, PermissionEngine, RepeatedToolCallGuard, normalizeAgentDecisionOrRejection, type AgentProvider } from '@buddy/agent-core';
import { detectLocale, directionFor, messages } from '@buddy/localization';
import { AGENT_LIMITS, AgentServiceError, DEFAULT_RULES, safeJson, type ActivityItem, type AgentDecision, type AgentObservation, type AgentRules, type BuddyState, type Locale, type PendingApproval, type PlanStep, type WebMCPTool } from '@buddy/shared';

type Tab = 'chat' | 'activity' | 'capabilities' | 'settings';
export type VoiceSubmissionMode = 'review' | 'auto';
interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string }
export interface AvatarPosition { x: number; y: number }
export interface StoredSettings { locale: Locale | 'auto'; muted: boolean; theme: 'light' | 'dark' | 'system'; developerMode: boolean; voiceSubmissionMode: VoiceSubmissionMode; rules: AgentRules; position?: AvatarPosition }
type ToolCall = Extract<AgentDecision, { kind: 'tool_call' }>;
interface RunContext { id: number; sessionId: string; goal: string; expectedRevision: number; nextTurn: number; observations: AgentObservation[]; guard: RepeatedToolCallGuard; controller: AbortController; pending: ToolCall | undefined }

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

export interface BuddyAppProps { adapter: BuddyAdapter; provider?: AgentProvider; siteName?: string; demoOpen?: boolean; speechProvider?: SpeechToTextProvider; voiceProvider?: TextToSpeechProvider; settingsStore?: BuddySettingsStore }

export function BuddyApp({ adapter, provider = new MockAgentProvider(), siteName = location.hostname, demoOpen = false, speechProvider, voiceProvider, settingsStore = browserSettingsStore }: BuddyAppProps) {
  const [tools, setTools] = useState<WebMCPTool[]>([]); const [state, setState] = useState<BuddyState>('SLEEPING');
  const [open, setOpen] = useState(demoOpen); const [tab, setTab] = useState<Tab>('chat'); const [input, setInput] = useState('');
  const [settings, setSettings] = useState<StoredSettings>(defaults); const [settingsLoaded, setSettingsLoaded] = useState(false); const [position, setPosition] = useState<AvatarPosition>();
  const [activity, setActivity] = useState<ActivityItem[]>([]); const [approval, setApproval] = useState<PendingApproval>();
  const [messagesList, setMessagesList] = useState<ChatMessage[]>([]); const [showNotice, setShowNotice] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null); const mascotRef = useRef<HTMLButtonElement>(null); const activeRun = useRef<RunContext | undefined>(undefined); const runSequence = useRef(0); const suppressClick = useRef(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: AvatarPosition; moved: boolean } | undefined>(undefined);
  const speech = useMemo(() => speechProvider ?? new BrowserSpeechToText(), [speechProvider]); const voice = useMemo(() => voiceProvider ?? new BrowserTextToSpeech(), [voiceProvider]);
  const locale = settings.locale === 'auto' ? detectLocale() : settings.locale; const t = messages[locale]; const capabilities = useMemo(() => new CapabilityMapper().map(tools), [tools]);

  useEffect(() => { void loadSettings(settingsStore).then((loaded) => { setSettings(loaded); if (loaded.position) setPosition(clampPosition(loaded.position)); setSettingsLoaded(true); }); }, [settingsStore]);
  useEffect(() => { if (settingsLoaded) void settingsStore.save({ ...settings, ...(position ? { position } : {}) }); }, [position, settings, settingsLoaded, settingsStore]);
  useEffect(() => { const onResize = () => setPosition((current) => current ? clampPosition(current) : current); addEventListener('resize', onResize); return () => removeEventListener('resize', onResize); }, []);
  useEffect(() => {
    let unsubscribe: () => void = () => undefined; let active = true;
    const applyTools = (found: WebMCPTool[], changed: boolean) => {
      if (!active) return;
      if (changed && activeRun.current) { activeRun.current.controller.abort(); activeRun.current = undefined; setApproval(undefined); }
      setTools(found);
      if (!found.length) { setOpen(false); setShowNotice(false); setState('SLEEPING'); return; }
      setState('DETECTED'); setShowNotice(true);
    };
    const detect = async () => {
      try { applyTools(adapter.isSupported() ? await adapter.getTools() : [], false); unsubscribe = adapter.subscribe((updated) => applyTools(updated, true)); }
      catch { applyTools([], false); }
    };
    void detect(); return () => { active = false; unsubscribe(); activeRun.current?.controller.abort(); };
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

  const addMessage = (role: ChatMessage['role'], text: string) => { setMessagesList((items) => [...items, { id: crypto.randomUUID(), role, text }]); if (role === 'assistant' && !settings.muted) voice.speak(text, locale); };
  const updateActivity = (id: string, patch: Partial<ActivityItem>) => setActivity((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const stopRun = (run: RunContext) => { if (activeRun.current?.id === run.id) activeRun.current = undefined; };

  const executeCall = async (run: RunContext, call: ToolCall) => {
    const started = performance.now(); setState('EXECUTING'); updateActivity(call.callId, { status: 'running' });
    try {
      const result = await adapter.execute(call.toolName, call.args, run.controller.signal, run.expectedRevision);
      const step: PlanStep = { id: call.callId, toolName: call.toolName, args: call.args, label: call.label, risk: call.risk };
      const text = await provider.interpretToolResult(step, result);
      updateActivity(call.callId, { status: 'done', detail: text, technical: { tool: call.toolName, durationMs: Math.round(performance.now() - started), request: call.args, response: result } });
      run.observations.push({ callId: call.callId, toolName: call.toolName, args: call.args, outcome: 'success', result: boundedResult(result) });
    } catch (error) {
      if (run.controller.signal.aborted) throw error;
      const text = error instanceof Error ? error.message : 'The site could not complete that action.';
      updateActivity(call.callId, { status: 'failed', detail: text }); run.observations.push({ callId: call.callId, toolName: call.toolName, args: call.args, outcome: 'error', error: text });
      setState('ERROR'); addMessage('assistant', `${text} I stopped safely.`); throw error;
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
        if (decision.kind === 'final' || decision.kind === 'needs_input') { addMessage('assistant', decision.message); setState(decision.kind === 'final' ? 'SUCCESS' : 'IDLE'); stopRun(run); return; }
        if (decision.kind === 'rejected_tool_call') {
          run.guard.assertNew(decision);
          run.observations.push({ callId: decision.callId, toolName: decision.toolName, args: decision.args, outcome: 'rejected', error: decision.message });
          setActivity((items) => [...items, { id: decision.callId, label: 'Correct invalid action details', status: 'failed', detail: 'Buddy rejected invalid arguments and asked the AI to correct them.', technical: { tool: decision.toolName, request: decision.args, response: decision.message } }]);
          continue;
        }
        run.guard.assertNew(decision);
        const actionLabel = createApprovalActionLabel(decision.label, decision.toolName);
        const displayCall = { ...decision, label: actionLabel };
        setActivity((items) => [...items, { id: decision.callId, label: actionLabel, status: 'pending' }]);
        const permission = new PermissionEngine().evaluate(decision, settings.rules);
        if (permission === 'BLOCK') { updateActivity(decision.callId, { status: 'canceled', detail: 'Blocked by your Buddy rules.' }); addMessage('assistant', `I stopped before “${actionLabel}” because your rules block this action.`); setState('IDLE'); stopRun(run); return; }
        if (permission === 'ASK') {
          const reviewed = createApprovalSnapshot(decision.args);
          const reviewedCall = { ...displayCall, args: reviewed.args };
          run.pending = reviewedCall; setApproval({ step: { id: reviewedCall.callId, toolName: reviewedCall.toolName, args: reviewedCall.args, label: reviewedCall.label, risk: reviewedCall.risk }, what: reviewedCall.label, why: reviewedCall.reason, argumentsJson: reviewed.argumentsJson, site: siteName, risk: reviewedCall.risk }); setState('WAITING_FOR_APPROVAL'); return;
        }
        await executeCall(run, displayCall);
      }
      if (!run.controller.signal.aborted && activeRun.current?.id === run.id) throw new Error('Buddy reached its safe action limit and stopped.');
    } catch (error) {
      if (!run.controller.signal.aborted) {
        setState('ERROR');
        const suffix = settings.developerMode ? developerErrorSuffix(error) : '';
        addMessage('assistant', `${error instanceof Error ? error.message : 'The agent stopped unexpectedly.'}${suffix} No further action was taken.`);
      }
      stopRun(run);
    }
  };

  const sendGoal = async (goal: string) => {
    const cleanGoal = goal.trim(); if (!cleanGoal || !tools.length) return;
    activeRun.current?.controller.abort(); setApproval(undefined); addMessage('user', cleanGoal); setInput('');
    const run: RunContext = { id: ++runSequence.current, sessionId: crypto.randomUUID(), goal: cleanGoal, expectedRevision: adapter.getRevision(), nextTurn: 0, observations: [], guard: new RepeatedToolCallGuard(), controller: new AbortController(), pending: undefined };
    activeRun.current = run; await continueRun(run);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void sendGoal(input); };
  const approve = async () => {
    const run = activeRun.current; const call = run?.pending; if (!run || !call) return;
    if (adapter.getRevision() !== run.expectedRevision) { run.controller.abort(); setApproval(undefined); setState('ERROR'); addMessage('assistant', 'The site actions changed before approval. I canceled the action.'); stopRun(run); return; }
    run.pending = undefined; setApproval(undefined);
    try { await executeCall(run, call); await continueRun(run); } catch { stopRun(run); }
  };
  const cancelApproval = () => {
    const run = activeRun.current; const call = run?.pending; if (call) updateActivity(call.callId, { status: 'canceled', detail: 'Canceled by you. Nothing was executed.' });
    if (run) { run.controller.abort(); stopRun(run); } setApproval(undefined); setState('IDLE'); addMessage('assistant', 'Canceled. I did not perform that action.');
  };
  const listen = async () => {
    if (!speech.supported) { addMessage('assistant', 'Voice input is unavailable here, but you can type your goal.'); return; }
    setState('LISTENING'); try { const transcript = await speech.listen(locale); setState('IDLE'); if (settings.voiceSubmissionMode === 'auto') await sendGoal(transcript); else setInput(transcript); } catch (error) { setState('ERROR'); addMessage('assistant', error instanceof Error ? error.message : 'Voice input failed.'); }
  };

  const onDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => { const rect = event.currentTarget.getBoundingClientRect(); drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { x: rect.left, y: rect.top }, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => { const current = drag.current; if (!current || current.pointerId !== event.pointerId) return; const dx = event.clientX - current.startX; const dy = event.clientY - current.startY; if (Math.hypot(dx, dy) > 5) current.moved = true; if (current.moved) setPosition(clampPosition({ x: current.origin.x + dx, y: current.origin.y + dy })); };
  const onDragEnd = (event: ReactPointerEvent<HTMLButtonElement>) => { const current = drag.current; if (!current || current.pointerId !== event.pointerId) return; suppressClick.current = current.moved; drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const onMascotActivate = () => { if (suppressClick.current) { suppressClick.current = false; return; } setOpen((value) => !value); };
  const onMascotKey = (event: KeyboardEvent<HTMLButtonElement>) => { const offsets: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }; const offset = offsets[event.key]; if (!offset) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setPosition(clampPosition({ x: (position?.x ?? rect.left) + offset[0], y: (position?.y ?? rect.top) + offset[1] })); };

  if (!tools.length) return null;
  const tooltip = `${t.detected} ${t.found(capabilities.length)}`; const busy = state === 'EXECUTING' || state === 'THINKING';
  return <div ref={rootRef} className={`buddy-root buddy-theme-${settings.theme}`} dir={directionFor(locale)} data-buddy-state={state}>
    {showNotice && !open && <div className="buddy-wake-notice" role="status">{t.detected}<span>{t.found(capabilities.length)}</span></div>}
    {open && <aside className="buddy-panel" aria-label="Buddy companion panel">
      <header className="buddy-header"><div><span className="buddy-eyebrow">BUDDY</span><h2>{siteName}</h2><p><span className="buddy-site-dot active"/>{tools.length} site actions available</p></div><button className="buddy-icon-button" onClick={() => setOpen(false)} aria-label="Close Buddy"><X size={19}/></button></header>
      <nav className="buddy-tabs" aria-label="Buddy views" role="tablist">{(['chat','activity','capabilities','settings'] as Tab[]).map((item, index) => <button key={item} onClick={() => setTab(item)} aria-selected={tab === item} role="tab">{[<Bot key="chat"/>,<ListChecks key="activity"/>,<Sparkles key="capabilities"/>,<Settings key="settings"/>][index]}<span>{t.tabs[index]}</span></button>)}</nav>
      <div className="buddy-content">
        {tab === 'chat' && <div className="buddy-chat" aria-live="polite">{messagesList.map((message) => <div key={message.id} className={`buddy-message ${message.role}`}>{message.text}</div>)}{busy && <div className="buddy-thinking" role="status"><LoaderCircle/> {state === 'THINKING' ? 'Choosing the next safe action…' : 'Waiting for the site…'}</div>}{approval && <ApprovalCard approval={approval} locale={locale} developerMode={settings.developerMode} onApprove={() => void approve()} onCancel={cancelApproval}/>}</div>}
        {tab === 'activity' && <section><div className="buddy-section-title"><Activity/><div><h3>What Buddy did</h3><p>A clear trail, not a technical log.</p></div></div><div className="buddy-activity">{!activity.length && <p className="buddy-muted">Completed steps will appear here.</p>}{activity.map((item) => <div className="buddy-activity-item" key={item.id}><span className={`buddy-check ${item.status}`}>{item.status === 'done' ? <Check/> : item.status === 'failed' ? <CircleAlert/> : <ChevronRight/>}</span><div><strong>{item.label}</strong>{item.detail && <p>{item.detail}</p>}{settings.developerMode && item.technical && <details><summary>Technical details</summary><pre>{safeJson(item.technical, 900)}</pre></details>}</div></div>)}</div></section>}
        {tab === 'capabilities' && <section><div className="buddy-section-title"><Sparkles/><div><h3>What I can do here</h3><p>Translated into everyday language.</p></div></div><div className="buddy-capabilities">{capabilities.map((capability) => <article key={capability.id}><span>{capability.label}</span><p>{capability.description}</p>{settings.developerMode && <code>{capability.toolNames.join(', ')}</code>}</article>)}</div></section>}
        {tab === 'settings' && <SettingsView settings={settings} setSettings={setSettings} voiceSupported={speech.supported && voice.supported}/>}
      </div>
      {tab === 'chat' && <footer className="buddy-composer"><div className="buddy-suggestions"><button onClick={() => setInput('Show what you can do')}>Show what you can do</button><button onClick={() => setInput('Help me choose the best option')}>Help me choose</button></div><form onSubmit={submit}><label className="buddy-sr-only" htmlFor="buddy-goal">{t.placeholder}</label><textarea id="buddy-goal" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t.placeholder} rows={2} maxLength={AGENT_LIMITS.maxGoalLength}/><div className="buddy-compose-actions"><button type="button" className="buddy-icon-button" onClick={() => void listen()} aria-label="Use voice input">{state === 'LISTENING' ? <MicOff/> : <Mic/>}</button><button type="submit" className="buddy-send" disabled={!input.trim() || busy || state === 'WAITING_FOR_APPROVAL'} aria-label="Send goal"><Send/></button></div></form></footer>}
    </aside>}
    <Mascot state={state} onActivate={onMascotActivate} onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onKeyDown={onMascotKey} label={tooltip} buttonRef={mascotRef} position={position}/>
  </div>;
}

function SettingsView({ settings, setSettings, voiceSupported }: { settings: StoredSettings; setSettings: (value: StoredSettings) => void; voiceSupported: boolean }) {
  const setRule = (name: keyof AgentRules, value: boolean) => setSettings({ ...settings, rules: { ...settings.rules, [name]: value } });
  return <section className="buddy-settings"><div className="buddy-section-title"><Settings/><div><h3>My Buddy rules</h3><p>Your rules stay on this device.</p></div></div>
    <label>Language<select value={settings.locale} onChange={(event) => setSettings({ ...settings, locale: event.target.value as StoredSettings['locale'] })}><option value="auto">Auto</option><option value="en">English</option><option value="ar">العربية</option><option value="es">Español</option></select></label>
    <label>Appearance<select value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value as StoredSettings['theme'] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <label>Voice submit<select value={settings.voiceSubmissionMode} onChange={(event) => setSettings({ ...settings, voiceSubmissionMode: event.target.value as VoiceSubmissionMode })}><option value="review">Review transcript</option><option value="auto">Send automatically</option></select></label>
    <div className="buddy-rule-group"><h4>Ask me before</h4>{([['askBeforeSubmit','Submitting forms'],['askBeforeMessages','Sending messages'],['askBeforePurchase','Purchases or reservations'],['askBeforeSensitive','Sharing sensitive information'],['blockDelete','Deleting anything']] as const).map(([key,label]) => <label className="buddy-switch" key={key}><span>{label}</span><input type="checkbox" checked={settings.rules[key]} onChange={(event) => setRule(key, event.target.checked)}/><i/></label>)}</div>
    <label className="buddy-switch"><span>{settings.muted ? <VolumeX/> : <Volume2/>} Voice responses {!voiceSupported && '(unavailable)'}</span><input type="checkbox" checked={!settings.muted} disabled={!voiceSupported} onChange={(event) => setSettings({ ...settings, muted: !event.target.checked })}/><i/></label>
    <label className="buddy-switch"><span>Developer mode</span><input type="checkbox" checked={settings.developerMode} onChange={(event) => setSettings({ ...settings, developerMode: event.target.checked })}/><i/></label>
  </section>;
}
