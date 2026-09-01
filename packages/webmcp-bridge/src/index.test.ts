// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebMCPAdapter } from './index';

describe('WebMCPAdapter', () => {
  let tools: Array<{ name: string; description: string; origin: string; window: Window; annotations?: { readOnlyHint?: boolean } }>;
  let context: ModelContext;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    tools = [{ name: 'search', description: 'Search', origin: 'https://example.com', window, annotations: { readOnlyHint: true } }];
    context = new EventTarget() as ModelContext;
    context.getTools = vi.fn().mockImplementation(async () => tools);
    context.executeTool = vi.fn().mockResolvedValue('{"count":2}');
    Object.defineProperty(document, 'modelContext', { configurable: true, value: context });
  });
  afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers(); });

  it('detects, enumerates, and executes a structured result', async () => {
    const adapter = new WebMCPAdapter(); expect(adapter.isSupported()).toBe(true);
    expect((await adapter.getTools())[0]?.name).toBe('search');
    expect(await adapter.execute('search', {})).toEqual({ count: 2 });
  });
  it('notifies when toolchange actually changes the advertised inventory', async () => {
    const adapter = new WebMCPAdapter(); await adapter.getTools(); const callback = vi.fn(); cleanups.push(adapter.subscribe(callback));
    tools = [...tools, { name: 'compare', description: 'Compare', origin: 'https://example.com', window }];
    context.dispatchEvent(new Event('toolchange'));
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'compare' })])));
  });
  it('does not change revision when an equivalent inventory is re-read', async () => {
    const adapter = new WebMCPAdapter(); await adapter.getTools(); const reviewedRevision = adapter.getRevision(); await adapter.getTools();
    expect(adapter.getRevision()).toBe(reviewedRevision);
    await expect(adapter.execute('search', {}, undefined, reviewedRevision)).resolves.toEqual({ count: 2 });
  });
  it('pins the reviewed native handle when equivalent metadata is re-read', async () => {
    const adapter = new WebMCPAdapter(); const reviewedHandle = tools[0]!; await adapter.getTools(); const reviewedRevision = adapter.getRevision();
    tools = [{ ...reviewedHandle }]; await adapter.getTools();
    expect(adapter.getRevision()).toBe(reviewedRevision);
    await adapter.execute('search', {}, undefined, reviewedRevision);
    expect(context.executeTool).toHaveBeenCalledWith(reviewedHandle, {}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('rejects execution after the advertised tool set changes', async () => {
    const adapter = new WebMCPAdapter(); await adapter.getTools(); const reviewedRevision = adapter.getRevision();
    tools = [{ name: 'search', description: 'Changed search', origin: 'https://example.com', window }]; await adapter.getTools();
    await expect(adapter.execute('search', {}, undefined, reviewedRevision)).rejects.toThrow(/changed/);
    expect(context.executeTool).not.toHaveBeenCalled();
  });
  it('filters malformed and duplicate tools', async () => {
    tools = [tools[0]!, { ...tools[0]!, description: 'duplicate' }, { name: '', description: 'bad', origin: 'https://example.com', window }];
    expect((await new WebMCPAdapter().getTools()).map((tool) => tool.name)).toEqual(['search']);
  });
  it('discovers WebMCP when the API appears after initial page load', async () => {
    vi.useFakeTimers(); Object.defineProperty(document, 'modelContext', { configurable: true, value: undefined });
    const adapter = new WebMCPAdapter(); const callback = vi.fn(); cleanups.push(adapter.subscribe(callback));
    Object.defineProperty(document, 'modelContext', { configurable: true, value: context }); await vi.advanceTimersByTimeAsync(2_100);
    expect(callback).toHaveBeenCalledWith([expect.objectContaining({ name: 'search' })]);
  });
  it('backs off discovery polling while WebMCP is unavailable and cleans up its timer', async () => {
    vi.useFakeTimers(); Object.defineProperty(document, 'modelContext', { configurable: true, value: undefined });
    const adapter = new WebMCPAdapter(); const getTools = vi.spyOn(adapter, 'getTools'); const cleanup = adapter.subscribe(vi.fn()); cleanups.push(cleanup);
    await vi.advanceTimersByTimeAsync(1_999); expect(getTools).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(getTools).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999); expect(getTools).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(getTools).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000); expect(getTools).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000); expect(getTools).toHaveBeenCalledTimes(4);
    cleanup(); await vi.advanceTimersByTimeAsync(60_000); expect(getTools).toHaveBeenCalledTimes(4);
  });
  it('uses toolchange immediately and a slow fallback to detect disappearance', async () => {
    vi.useFakeTimers(); const adapter = new WebMCPAdapter(); await adapter.getTools(); const callback = vi.fn(); cleanups.push(adapter.subscribe(callback));
    tools = [...tools, { name: 'compare', description: 'Compare', origin: 'https://example.com', window }]; context.dispatchEvent(new Event('toolchange'));
    await vi.advanceTimersByTimeAsync(0); expect(callback).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'compare' })]));
    callback.mockClear(); Object.defineProperty(document, 'modelContext', { configurable: true, value: undefined });
    await vi.advanceTimersByTimeAsync(29_999); expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(callback).toHaveBeenCalledWith([]);
  });
});
