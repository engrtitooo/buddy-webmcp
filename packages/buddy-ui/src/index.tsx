import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, Bot, Check, ChevronRight, CircleAlert, ListChecks, Mic, MicOff, Moon, Send, Settings, Sparkles, Volume2, VolumeX, X } from 'lucide-react';
import { CapabilityMapper, MockAgentProvider, PermissionEngine, normalizePlan, type AgentProvider } from '@buddy/agent-core';
import { detectLocale, directionFor, messages } from '@buddy/localization';
import { DEFAULT_RULES, safeJson, type ActivityItem, type AgentPlan, type AgentRules, type BuddyState, type Locale, type PendingApproval, type PlanStep, type WebMCPTool } from '@buddy/shared';
import type { WebMCPAdapter } from '@buddy/webmcp-bridge';

type Tab = 'chat' | 'activity' | 'capabilities' | 'settings';
interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string }
interface StoredSettings { locale: Locale | 'auto'; muted: boolean; theme: 'light' | 'dark' | 'system'; developerMode: boolean; rules: AgentRules }
const defaults: StoredSettings = { locale: 'auto', muted: true, theme: 'system', developerMode: false, rules: DEFAULT_RULES };

async function loadSettings(): Promise<StoredSettings> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const result = await chrome.storage.local.get('buddySettings'); return { ...defaults, ...(result.buddySettings as Partial<StoredSettings> | undefined) };
  }
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('buddySettings') ?? '{}') as Partial<StoredSettings> }; } catch { return defaults; }
}
async function saveSettings(value: StoredSettings) {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) await chrome.storage.local.set({ buddySettings: value });
  else localStorage.setItem('buddySettings', JSON.stringify(value));
}

export interface SpeechToTextProvider { supported: boolean; listen(locale: Locale): Promise<string>; stop(): void }
export interface TextToSpeechProvider { supported: boolean; speak(text: string, locale: Locale): void; stop(): void }

class BrowserSpeechToText implements SpeechToTextProvider {
  private recognition: { start(): void; stop(): void } | undefined;
  supported = 'webkitSpeechRecognition' in globalThis || 'SpeechRecognition' in globalThis;
  listen(locale: Locale): Promise<string> {
    return new Promise((resolve, reject) => {
      const Constructor = (globalThis as unknown as { webkitSpeechRecognition?: new () => any; SpeechRecognition?: new () => any }).SpeechRecognition ?? (globalThis as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
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

function Mascot({ state, onClick, label }: { state: BuddyState; onClick: () => void; label: string }) {
  return <button className={`buddy-mascot buddy-state-${state.toLowerCase()}`} onClick={onClick} aria-label={label} title={label}>
    <span className="buddy-shell"><span className="buddy-face"><span className="buddy-eye buddy-eye-left"/><span className="buddy-eye buddy-eye-right"/><span className="buddy-mouth"/></span><span className="buddy-status-dot"/></span>
  </button>;
}

function ApprovalCard({ approval, locale, onApprove, onCancel }: { approval: PendingApproval; locale: Locale; onApprove: () => void; onCancel: () => void }) {
  const t = messages[locale];
  return <section className="buddy-approval" aria-labelledby="buddy-approval-title">
    <div className="buddy-approval-heading"><CircleAlert size={18}/><h3 id="buddy-approval-title">{t.approvalTitle}</h3></div>
    <p><strong>{approval.what}</strong></p><p>{approval.why}</p><div className="buddy-data-pill">{approval.dataSummary}</div>
    <div className="buddy-approval-actions"><button className="buddy-secondary" onClick={onCancel}>{t.cancel}</button><button className="buddy-primary" onClick={onApprove}>{t.approve}</button></div>
  </section>;
}

export function BuddyApp({ adapter, provider = new MockAgentProvider(), siteName = location.hostname, demoOpen = false }: { adapter: WebMCPAdapter; provider?: AgentProvider; siteName?: string; demoOpen?: boolean }) {
  const [tools, setTools] = useState<WebMCPTool[]>([]); const [state, setState] = useState<BuddyState>('SLEEPING');
  const [open, setOpen] = useState(demoOpen); const [tab, setTab] = useState<Tab>('chat'); const [input, setInput] = useState('');
  const [settings, setSettings] = useState<StoredSettings>(defaults); const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [approval, setApproval] = useState<PendingApproval>(); const [plan, setPlan] = useState<AgentPlan>(); const nextIndex = useRef(0);
  const planRevision = useRef<number | undefined>(undefined);
  const [messagesList, setMessagesList] = useState<ChatMessage[]>([]); const [notice, setNotice] = useState('');
  const speech = useMemo(() => new BrowserSpeechToText(), []); const voice = useMemo(() => new BrowserTextToSpeech(), []);
  const locale = settings.locale === 'auto' ? detectLocale() : settings.locale; const t = messages[locale];
  const capabilities = useMemo(() => new CapabilityMapper().map(tools), [tools]);

  useEffect(() => { void loadSettings().then(setSettings); }, []);
  useEffect(() => { void saveSettings(settings); }, [settings]);
  useEffect(() => {
    let unsubscribe: () => void = () => undefined; let active = true;
    const detect = async () => {
      if (!adapter.isSupported()) { if (active) { setTools([]); setState('SLEEPING'); } return; }
      try { const found = await adapter.getTools(); if (!active) return; setTools(found); setState(found.length ? 'DETECTED' : 'SLEEPING'); setNotice(found.length ? t.detected : ''); unsubscribe = adapter.subscribe((updated) => { setTools(updated); setState(updated.length ? 'DETECTED' : 'SLEEPING'); }); }
      catch { if (active) { setTools([]); setState('ERROR'); } }
    }; void detect(); return () => { active = false; unsubscribe(); };
  }, [adapter, t.detected]);
  useEffect(() => { if (state === 'DETECTED') { const timer = setTimeout(() => setState('IDLE'), 1600); return () => clearTimeout(timer); } }, [state]);
  useEffect(() => { if (!messagesList.length && tools.length) setMessagesList([{ id: crypto.randomUUID(), role: 'assistant', text: `${t.detected} ${t.found(capabilities.length)} ${t.welcome}` }]); }, [tools.length, capabilities.length, messagesList.length, t]);

  const addMessage = (role: ChatMessage['role'], text: string) => { setMessagesList((items) => [...items, { id: crypto.randomUUID(), role, text }]); if (role === 'assistant' && !settings.muted) voice.speak(text, locale); };
  const updateActivity = (id: string, patch: Partial<ActivityItem>) => setActivity((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));

  const executeFrom = async (currentPlan: AgentPlan, start: number, expectedRevision: number) => {
    const permission = new PermissionEngine();
    for (let index = start; index < currentPlan.steps.length; index += 1) {
      const step = currentPlan.steps[index]; if (!step) continue; nextIndex.current = index;
      const decision = permission.evaluate(step, settings.rules);
      if (decision === 'BLOCK') { updateActivity(step.id, { status: 'canceled', detail: 'Blocked by your Buddy rules.' }); addMessage('assistant', `I stopped before “${step.label}” because your rules block this kind of action.`); setState('IDLE'); return; }
      if (decision === 'ASK') { setApproval({ step, what: `${step.label} (${step.toolName})`, why: 'This action changes something or may have consequences, so your Buddy rules require approval.', dataSummary: safeJson(step.args, 180) }); setState('WAITING_FOR_APPROVAL'); return; }
      await executeStep(step, expectedRevision);
    }
    setApproval(undefined); setState('SUCCESS'); addMessage('assistant', 'Done. I completed the available steps and kept the activity trail for you.');
  };

  const executeStep = async (step: PlanStep, expectedRevision: number) => {
    const started = performance.now(); setState('EXECUTING'); updateActivity(step.id, { status: 'running' });
    try { const result = await adapter.execute(step.toolName, step.args, undefined, expectedRevision); const text = await provider.interpretToolResult(step, result); updateActivity(step.id, { status: 'done', detail: text, technical: { tool: step.toolName, durationMs: Math.round(performance.now() - started), request: step.args, response: result } }); }
    catch (error) { const text = error instanceof Error ? error.message : 'The site could not complete that action.'; updateActivity(step.id, { status: 'failed', detail: text }); setState('ERROR'); addMessage('assistant', `${text} I stopped safely.`); throw error; }
  };

  const sendGoal = async (goal: string) => {
    if (!goal.trim()) return; addMessage('user', goal.trim()); setInput(''); setState('THINKING');
    let executionStarted = false;
    try { const expectedRevision = adapter.getRevision(); const providerPlan = await provider.interpretGoal(goal, tools); if (adapter.getRevision() !== expectedRevision) throw new Error('The site actions changed while I was planning. Please try again.'); const nextPlan = normalizePlan(providerPlan, tools); setPlan(nextPlan); planRevision.current = expectedRevision; nextIndex.current = 0; setActivity(nextPlan.steps.map((step) => ({ id: step.id, label: step.label, status: 'pending' })));
      addMessage('assistant', nextPlan.summary); if (!nextPlan.steps.length) { setState('IDLE'); return; } executionStarted = true; await executeFrom(nextPlan, 0, expectedRevision);
    } catch (error) { setState('ERROR'); if (!executionStarted) addMessage('assistant', error instanceof Error ? `${error.message} I stopped safely.` : 'Planning failed. I stopped safely.'); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void sendGoal(input); };
  const approve = async () => { if (!approval || !plan || planRevision.current === undefined) return; const step = approval.step; const expectedRevision = planRevision.current; setApproval(undefined); try { await executeStep(step, expectedRevision); await executeFrom(plan, nextIndex.current + 1, expectedRevision); } catch { /* error already reported */ } };
  const cancelApproval = () => { if (approval) updateActivity(approval.step.id, { status: 'canceled', detail: 'Canceled by you.' }); setApproval(undefined); setState('IDLE'); addMessage('assistant', 'Canceled. I did not perform that action.'); };
  const listen = async () => { if (!speech.supported) { addMessage('assistant', 'Voice input is unavailable here, but you can type your goal.'); return; } setState('LISTENING'); try { const transcript = await speech.listen(locale); setInput(transcript); setState('IDLE'); } catch (error) { setState('ERROR'); addMessage('assistant', error instanceof Error ? error.message : 'Voice input failed.'); } };

  const resting = !tools.length; const tooltip = resting ? t.resting : `${t.detected} ${t.found(capabilities.length)}`;
  return <div className={`buddy-root buddy-theme-${settings.theme}`} dir={directionFor(locale)} data-buddy-state={state}>
    {notice && !open && <div className="buddy-wake-notice" role="status">{notice}<span>{t.found(capabilities.length)}</span></div>}
    {open && <aside className="buddy-panel" aria-label="Buddy companion panel">
      <header className="buddy-header"><div><span className="buddy-eyebrow">BUDDY</span><h2>{siteName}</h2><p><span className={`buddy-site-dot ${resting ? '' : 'active'}`}/>{resting ? 'Agent actions unavailable' : `${tools.length} site actions available`}</p></div><button className="buddy-icon-button" onClick={() => setOpen(false)} aria-label="Close Buddy"><X size={19}/></button></header>
      <nav className="buddy-tabs" aria-label="Buddy views">{(['chat','activity','capabilities','settings'] as Tab[]).map((item, index) => <button key={item} onClick={() => setTab(item)} aria-selected={tab === item} role="tab">{[<Bot/>,<ListChecks/>,<Sparkles/>,<Settings/>][index]}<span>{t.tabs[index]}</span></button>)}</nav>
      <div className="buddy-content">
        {tab === 'chat' && <div className="buddy-chat" aria-live="polite">{resting && <div className="buddy-empty"><Moon/><h3>Buddy is resting</h3><p>{t.resting}</p></div>}{messagesList.map((message) => <div key={message.id} className={`buddy-message ${message.role}`}>{message.text}</div>)}{approval && <ApprovalCard approval={approval} locale={locale} onApprove={() => void approve()} onCancel={cancelApproval}/>}</div>}
        {tab === 'activity' && <section><div className="buddy-section-title"><Activity/><div><h3>What Buddy did</h3><p>A clear trail, not a technical log.</p></div></div><div className="buddy-activity">{!activity.length && <p className="buddy-muted">Your completed steps will appear here.</p>}{activity.map((item) => <div className="buddy-activity-item" key={item.id}><span className={`buddy-check ${item.status}`}>{item.status === 'done' ? <Check/> : item.status === 'failed' ? <CircleAlert/> : <ChevronRight/>}</span><div><strong>{item.label}</strong>{item.detail && <p>{item.detail}</p>}{settings.developerMode && item.technical && <details><summary>Technical details</summary><pre>{safeJson(item.technical, 900)}</pre></details>}</div></div>)}</div></section>}
        {tab === 'capabilities' && <section><div className="buddy-section-title"><Sparkles/><div><h3>What I can do here</h3><p>Translated into everyday language.</p></div></div><div className="buddy-capabilities">{capabilities.map((capability) => <article key={capability.id}><span>{capability.label}</span><p>{capability.description}</p>{settings.developerMode && <code>{capability.toolNames.join(', ')}</code>}</article>)}</div></section>}
        {tab === 'settings' && <SettingsView settings={settings} setSettings={setSettings} voiceSupported={speech.supported && voice.supported}/>}
      </div>
      {tab === 'chat' && !resting && <footer className="buddy-composer"><div className="buddy-suggestions"><button onClick={() => setInput('Show what you can do')}>Show what you can do</button><button onClick={() => setInput('Help me choose the best option')}>Help me choose</button></div><form onSubmit={submit}><label className="buddy-sr-only" htmlFor="buddy-goal">{t.placeholder}</label><textarea id="buddy-goal" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t.placeholder} rows={2}/><div className="buddy-compose-actions"><button type="button" className="buddy-icon-button" onClick={() => void listen()} aria-label="Use voice input">{state === 'LISTENING' ? <MicOff/> : <Mic/>}</button><button type="submit" className="buddy-send" disabled={!input.trim() || state === 'EXECUTING' || state === 'THINKING'} aria-label="Send goal"><Send/></button></div></form></footer>}
    </aside>}
    <Mascot state={state} onClick={() => setOpen((value) => !value)} label={tooltip}/>
  </div>;
}

function SettingsView({ settings, setSettings, voiceSupported }: { settings: StoredSettings; setSettings: (value: StoredSettings) => void; voiceSupported: boolean }) {
  const setRule = (name: keyof AgentRules, value: boolean) => setSettings({ ...settings, rules: { ...settings.rules, [name]: value } });
  return <section className="buddy-settings"><div className="buddy-section-title"><Settings/><div><h3>My Buddy rules</h3><p>Your rules stay on this device.</p></div></div>
    <label>Language<select value={settings.locale} onChange={(e) => setSettings({ ...settings, locale: e.target.value as StoredSettings['locale'] })}><option value="auto">Auto</option><option value="en">English</option><option value="ar">العربية</option><option value="es">Español</option></select></label>
    <label>Appearance<select value={settings.theme} onChange={(e) => setSettings({ ...settings, theme: e.target.value as StoredSettings['theme'] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <div className="buddy-rule-group"><h4>Ask me before</h4>{([['askBeforeSubmit','Submitting forms'],['askBeforeMessages','Sending messages'],['askBeforePurchase','Purchases or reservations'],['askBeforeSensitive','Sharing sensitive information'],['blockDelete','Deleting anything']] as const).map(([key,label]) => <label className="buddy-switch" key={key}><span>{label}</span><input type="checkbox" checked={settings.rules[key]} onChange={(e) => setRule(key, e.target.checked)}/><i/></label>)}</div>
    <label className="buddy-switch"><span>{settings.muted ? <VolumeX/> : <Volume2/>} Voice responses {!voiceSupported && '(unavailable)'}</span><input type="checkbox" checked={!settings.muted} disabled={!voiceSupported} onChange={(e) => setSettings({ ...settings, muted: !e.target.checked })}/><i/></label>
    <label className="buddy-switch"><span>Developer mode</span><input type="checkbox" checked={settings.developerMode} onChange={(e) => setSettings({ ...settings, developerMode: e.target.checked })}/><i/></label>
  </section>;
}
