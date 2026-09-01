// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '@buddy/agent-core';
import { DEFAULT_RULES, type AgentNextInput, type PlanStep, type WebMCPTool } from '@buddy/shared';
import { BuddyApp, type BuddyAdapter, type BuddySettingsStore, type SpeechToTextProvider, type StoredSettings, type TextToSpeechProvider } from './index';

const searchTool: WebMCPTool = { name: 'search_items', description: 'Search items', origin: 'https://shop.example', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const writeTool: WebMCPTool = { name: 'frobnicate', description: 'Perform an operation', origin: 'https://shop.example', inputSchema: { type: 'object' } };

class FakeAdapter implements BuddyAdapter {
  revision = 1;
  listener: ((tools: WebMCPTool[]) => void) | undefined;
  execute = vi.fn(async () => ({ message: 'Completed.' }));
  constructor(public tools: WebMCPTool[]) {}
  isSupported() { return true; }
  async getTools() { return this.tools; }
  subscribe(callback: (tools: WebMCPTool[]) => void) { this.listener = callback; return () => { this.listener = undefined; }; }
  getRevision() { return this.revision; }
  emit(tools: WebMCPTool[]) { this.tools = tools; this.revision += 1; this.listener?.(tools); }
}

class QueueProvider implements AgentProvider {
  inputs: AgentNextInput[] = [];
  constructor(private readonly responses: unknown[]) {}
  async next(input: AgentNextInput): Promise<unknown> {
    this.inputs.push(structuredClone(input));
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === 'function') return (response as (value: AgentNextInput) => unknown)(input);
    return response;
  }
  async summarizeCapabilities() { return 'Capabilities'; }
  async interpretToolResult(_step: PlanStep, result: unknown) { return typeof result === 'object' && result && 'message' in result ? String(result.message) : 'Completed.'; }
}

const defaultSettings: StoredSettings = { locale: 'en', muted: true, theme: 'system', developerMode: false, voiceSubmissionMode: 'review', rules: DEFAULT_RULES };
const roots: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function makeStore(initial: Partial<StoredSettings> = {}): BuddySettingsStore & { save: ReturnType<typeof vi.fn> } {
  return { load: vi.fn(async () => ({ ...defaultSettings, ...initial })), save: vi.fn(async () => undefined) };
}

const silentVoice: TextToSpeechProvider = { supported: true, speak: vi.fn(), stop: vi.fn() };
const noSpeech: SpeechToTextProvider = { supported: false, listen: vi.fn(async () => ''), stop: vi.fn() };

async function settle(rounds = 3) {
  await act(async () => { for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderBuddy(adapter: FakeAdapter, provider: AgentProvider = new QueueProvider([]), options: { store?: BuddySettingsStore; speech?: SpeechToTextProvider; demoOpen?: boolean } = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => { root.render(<BuddyApp adapter={adapter} provider={provider} siteName="shop.example" demoOpen={options.demoOpen ?? true} settingsStore={options.store ?? makeStore()} speechProvider={options.speech ?? noSpeech} voiceProvider={silentVoice}/>); });
  await settle();
  return container;
}

async function click(element: Element | null) {
  if (!element) throw new Error('Expected element to click.');
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle();
}

async function submitGoal(container: HTMLElement, goal = 'Find a gift') {
  const textarea = container.querySelector('textarea'); if (!textarea) throw new Error('Missing goal input.');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; if (!setter) throw new Error('Missing textarea setter.');
  await act(async () => { setter.call(textarea, goal); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  const form = container.querySelector('form'); if (!form) throw new Error('Missing goal form.');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await settle(5);
}

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 }); Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) });
});

afterEach(async () => {
  await act(async () => { roots.splice(0).forEach((root) => root.unmount()); });
  vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '';
});

describe('BuddyApp integration', () => {
  it('renders nothing without WebMCP and appears when tools are detected', async () => {
    const adapter = new FakeAdapter([]); const container = await renderBuddy(adapter);
    expect(container.querySelector('.buddy-root')).toBeNull();
    await act(async () => adapter.emit([searchTool])); await settle();
    expect(container.querySelector('.buddy-mascot')).not.toBeNull();
  });

  it('updates capabilities after toolchange', async () => {
    const adapter = new FakeAdapter([searchTool]); const container = await renderBuddy(adapter);
    await act(async () => adapter.emit([searchTool, { ...searchTool, name: 'compare_items', description: 'Compare items' }])); await settle();
    await click([...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Capabilities')) ?? null);
    expect(container.textContent).toContain('Search for things'); expect(container.textContent).toContain('Compare options');
  });

  it('executes a permitted read and bounds its observation before the next turn', async () => {
    const provider = new QueueProvider([
      { kind: 'tool_call', toolName: 'search_items', args: { query: 'gift' }, label: 'Search', reason: 'Find items', risk: 'READ' },
      { kind: 'final', message: 'I found the best option.' },
    ]);
    const adapter = new FakeAdapter([searchTool]); adapter.execute.mockResolvedValue({ message: 'X'.repeat(10_000) });
    const container = await renderBuddy(adapter, provider); await submitGoal(container);
    expect(adapter.execute).toHaveBeenCalledTimes(1); expect(provider.inputs).toHaveLength(2);
    expect(JSON.stringify(provider.inputs[1]?.observations[0]?.result).length).toBeLessThanOrEqual(4_010);
    expect(container.textContent).toContain('I found the best option.');
  });

  it('asks for an unknown write and cancel guarantees no execution', async () => {
    const provider = new QueueProvider([{ kind: 'tool_call', toolName: 'frobnicate', args: { value: 1 }, label: 'Update item', reason: 'Continue', risk: 'READ' }]);
    const adapter = new FakeAdapter([writeTool]); const container = await renderBuddy(adapter, provider); await submitGoal(container);
    expect(container.textContent).toContain('Approve once');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel') ?? null);
    expect(adapter.execute).not.toHaveBeenCalled(); expect(container.textContent).toContain('I did not perform that action');
  });

  it('hides and cancels safely when tools disappear during approval', async () => {
    const provider = new QueueProvider([{ kind: 'tool_call', toolName: 'frobnicate', args: {}, label: 'Update item', reason: 'Continue', risk: 'LOW_RISK_WRITE' }]);
    const adapter = new FakeAdapter([writeTool]); const container = await renderBuddy(adapter, provider); await submitGoal(container);
    expect(container.textContent).toContain('Approve once'); await act(async () => adapter.emit([])); await settle();
    expect(container.querySelector('.buddy-root')).toBeNull(); expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments, gives repair feedback, and executes only the repaired call', async () => {
    const provider = new QueueProvider([
      { kind: 'tool_call', toolName: 'search_items', args: {}, label: 'Search', reason: 'Find items', risk: 'READ' },
      { kind: 'tool_call', toolName: 'search_items', args: { query: 'gift' }, label: 'Search', reason: 'Repair arguments', risk: 'READ' },
      { kind: 'final', message: 'Done.' },
    ]);
    const adapter = new FakeAdapter([searchTool]); const container = await renderBuddy(adapter, provider); await submitGoal(container);
    expect(provider.inputs[1]?.observations[0]).toMatchObject({ toolName: 'search_items', outcome: 'rejected', error: expect.stringMatching(/schema/) });
    expect(adapter.execute).toHaveBeenCalledTimes(1); expect(container.textContent).toContain('Done.');
  });

  it('stops before execution when the tool revision changes during reasoning', async () => {
    let resolveDecision: ((value: unknown) => void) | undefined;
    const provider: AgentProvider = { next: vi.fn(async () => new Promise((resolve) => { resolveDecision = resolve; })), summarizeCapabilities: vi.fn(async () => ''), interpretToolResult: vi.fn(async () => '') };
    const adapter = new FakeAdapter([searchTool]); const container = await renderBuddy(adapter, provider);
    await submitGoal(container); await act(async () => adapter.emit([searchTool])); resolveDecision?.({ kind: 'tool_call', toolName: 'search_items', args: { query: 'gift' }, label: 'Search', reason: 'Find', risk: 'READ' });
    await settle(); expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('shows a safe UI error for malformed or unavailable AI responses', async () => {
    const malformed = await renderBuddy(new FakeAdapter([searchTool]), new QueueProvider([{ kind: 'unexpected' }])); await submitGoal(malformed);
    expect(malformed.textContent).toContain('invalid tool call');
    const unavailable = await renderBuddy(new FakeAdapter([searchTool]), new QueueProvider([new Error("Buddy's AI service is temporarily unavailable.")])); await submitGoal(unavailable);
    expect(unavailable.textContent).toContain("Buddy's AI service is temporarily unavailable");
  });

  it('reviews voice transcripts by default and auto-sends only when configured', async () => {
    const speech: SpeechToTextProvider = { supported: true, listen: vi.fn(async () => 'Find headphones'), stop: vi.fn() };
    const reviewProvider = new QueueProvider([]); const review = await renderBuddy(new FakeAdapter([searchTool]), reviewProvider, { speech });
    await click(review.querySelector('[aria-label="Use voice input"]')); expect((review.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Find headphones'); expect(reviewProvider.inputs).toHaveLength(0);
    const autoProvider = new QueueProvider([{ kind: 'final', message: 'Finished.' }]); const auto = await renderBuddy(new FakeAdapter([searchTool]), autoProvider, { speech, store: makeStore({ voiceSubmissionMode: 'auto' }) });
    await click(auto.querySelector('[aria-label="Use voice input"]')); expect(autoProvider.inputs[0]?.goal).toBe('Find headphones'); expect(auto.textContent).toContain('Finished.');
  });

  it('loads RTL and position settings, then persists keyboard and drag movement', async () => {
    const store = makeStore({ locale: 'ar', position: { x: 120, y: 130 } }); const container = await renderBuddy(new FakeAdapter([searchTool]), new QueueProvider([]), { store });
    const root = container.querySelector('.buddy-root'); const mascot = container.querySelector('.buddy-mascot') as HTMLButtonElement;
    expect(root?.getAttribute('dir')).toBe('rtl'); expect(mascot.getAttribute('style')).toContain('120px');
    await act(async () => { mascot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); }); await settle();
    expect(store.save).toHaveBeenLastCalledWith(expect.objectContaining({ position: { x: 130, y: 130 } }));
    vi.spyOn(mascot, 'getBoundingClientRect').mockReturnValue({ x: 130, y: 130, left: 130, top: 130, right: 202, bottom: 202, width: 72, height: 72, toJSON: () => ({}) });
    const pointer = (type: string, x: number, y: number) => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 1 }); return event; };
    await act(async () => { mascot.dispatchEvent(pointer('pointerdown', 140, 140)); mascot.dispatchEvent(pointer('pointermove', 170, 180)); mascot.dispatchEvent(pointer('pointerup', 170, 180)); }); await settle();
    expect(store.save).toHaveBeenLastCalledWith(expect.objectContaining({ position: { x: 160, y: 170 } }));
  });

  it('keeps raw approval JSON developer-only and renders malicious text inert', async () => {
    const call = { kind: 'tool_call', toolName: 'frobnicate', args: { recipient: { accountId: 'reviewed-user' }, note: '<img src=x onerror=alert(1)>' }, label: 'Update item (frobnicate)', reason: 'Continue', risk: 'LOW_RISK_WRITE' };
    const normal = await renderBuddy(new FakeAdapter([writeTool]), new QueueProvider([call])); await submitGoal(normal);
    expect(normal.textContent).toContain('Update item'); expect(normal.textContent).not.toContain('frobnicate'); expect(normal.textContent).toContain('Recipient › Account Id'); expect(normal.textContent).toContain('<img src=x onerror=alert(1)>'); expect(normal.querySelector('img')).toBeNull(); expect(normal.textContent).not.toContain('Raw arguments');
    await click([...normal.querySelectorAll('button')].find((button) => button.textContent?.includes('Activity')) ?? null); expect(normal.textContent).not.toContain('frobnicate');
    const developer = await renderBuddy(new FakeAdapter([writeTool]), new QueueProvider([call]), { store: makeStore({ developerMode: true }) }); await submitGoal(developer);
    expect(developer.textContent).toContain('Tool'); expect(developer.textContent).toContain('frobnicate'); expect(developer.textContent).toContain('Raw arguments');
  });

  it('includes a deterministic reduced-motion override', () => {
    const css = readFileSync('packages/buddy-ui/src/styles.css', 'utf8');
    expect(css).toMatch(/prefers-reduced-motion:reduce/); expect(css).toContain('animation-duration:.01ms!important');
  });
});
