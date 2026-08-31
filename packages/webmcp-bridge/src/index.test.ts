// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebMCPAdapter } from './index';

describe('WebMCPAdapter', () => {
  beforeEach(() => {
    const context = new EventTarget() as ModelContext;
    context.getTools = vi.fn().mockResolvedValue([{ name: 'search', description: 'Search', origin: 'https://example.com', window, annotations: { readOnlyHint: true } }]);
    context.executeTool = vi.fn().mockResolvedValue('{"count":2}');
    Object.defineProperty(document, 'modelContext', { configurable: true, value: context });
  });
  it('detects, enumerates, executes and observes changes', async () => {
    const adapter = new WebMCPAdapter(); expect(adapter.isSupported()).toBe(true);
    expect((await adapter.getTools())[0]?.name).toBe('search');
    expect(await adapter.execute('search', {})).toEqual({ count: 2 });
    const callback = vi.fn(); adapter.subscribe(callback); document.modelContext?.dispatchEvent(new Event('toolchange'));
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
  });
  it('rejects execution after the advertised tool set changes', async () => {
    const adapter = new WebMCPAdapter();
    await adapter.getTools();
    const reviewedRevision = adapter.getRevision();
    await adapter.getTools();
    await expect(adapter.execute('search', {}, undefined, reviewedRevision)).rejects.toThrow(/changed/);
    expect(document.modelContext?.executeTool).not.toHaveBeenCalled();
  });
});
