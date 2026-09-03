import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_NEXT_MESSAGE, REALTIME_SESSION_MESSAGE, type AgentNextRuntimeResponse, type RealtimeSessionRuntimeResponse } from '@buddy/shared';

const api = 'https://buddy-mcp-production.up.railway.app';
const sender = { id: 'a'.repeat(32), url: 'https://page.example' };
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-pwd:private-sdp-credential\r\n';
const agentPayload = { sessionId: 'test-session', turn: 0, goal: 'private user goal', tools: [], observations: [] };
type Reply = AgentNextRuntimeResponse | RealtimeSessionRuntimeResponse;
let listener: (message: unknown, sender: { id: string; url: string }) => Promise<Reply> | undefined;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); fetchMock.mockReset();
  vi.stubGlobal('__BUDDY_API_BASE_URL__', api);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', { runtime: { id: sender.id, onMessage: { addListener: (value: typeof listener) => { listener = value; } } } });
  await import('./background');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe.each([
  { type: AGENT_NEXT_MESSAGE, path: '/agent/next', payload: agentPayload, success: JSON.stringify({ kind: 'final', message: 'Ready' }) },
  { type: REALTIME_SESSION_MESSAGE, path: '/realtime/session', payload: { sdp, locale: 'en' }, success: sdp },
])('fixed backend request $path', ({ type, path, payload, success }) => {
  it('uses the built API URL even when page data supplies alternative URLs', async () => {
    fetchMock.mockResolvedValue(new Response(success));
    const response = await listener({ type, url: 'https://evil.example', payload: { ...payload, apiBaseUrl: 'https://evil.example', url: 'http://localhost' } }, sender);
    expect(response?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(`${api}${path}`, expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' }));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects messages from other extensions or non-web senders', async () => {
    for (const untrusted of [{ ...sender, id: 'b'.repeat(32) }, { ...sender, url: 'file:///private' }]) {
      expect(await listener({ type, payload }, untrusted)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST_BODY' } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies network failures without exposing content or exception details', async () => {
    fetchMock.mockRejectedValue(new TypeError(`authorization Bearer secret ${sdp}`));
    const response = await listener({ type, payload }, sender);
    expect(response).toMatchObject({ ok: false, error: { code: 'NETWORK_ERROR', retryable: true } });
    expect(JSON.stringify(response)).not.toMatch(/secret|private|ice-pwd|authorization/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies a deadline using the abort signal even for non-DOM exceptions', async () => {
    fetchMock.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private transport detail')), { once: true });
    }));
    const response = listener({ type, payload }, sender);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await response).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [403, 'ORIGIN_NOT_ALLOWED'], [401, 'UNAUTHORIZED'], [429, 'RATE_LIMITED'], [502, 'PROVIDER_ERROR'], [504, 'TIMEOUT'],
  ])('preserves safe HTTP %s diagnostics as %s', async (status, code) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code, message: `secret ${sdp}`, authorization: 'Bearer token' } }), { status, headers: { 'x-request-id': 'private-token' } }));
    const response = await listener({ type, payload }, sender);
    expect(response).toMatchObject({ ok: false, error: { status, code } });
    expect(JSON.stringify(response)).not.toMatch(/secret|private|ice-pwd|Bearer/);
  });

  it('distinguishes an unstructured HTTP failure from a network failure', async () => {
    fetchMock.mockResolvedValue(new Response('private gateway page', { status: 502 }));
    expect(await listener({ type, payload }, sender)).toMatchObject({ ok: false, error: { code: 'HTTP_ERROR', status: 502 } });
  });

  it('reports a timeout while consuming an HTTP error body', async () => {
    fetchMock.mockImplementation(async (_input, init) => ({ ok: false, status: 502, headers: new Headers(), json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private body')), { once: true });
    }) }) as Response);
    const response = listener({ type, payload }, sender);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await response).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });
});
