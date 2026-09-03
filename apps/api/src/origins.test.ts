import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertProductionEnvironment, createBuddyServer, MemoryRateLimiter } from './server';
import { extensionOriginPolicy, isAllowedOrigin } from './origins';

const extensionA = `chrome-extension://${'a'.repeat(32)}`;
const extensionB = `chrome-extension://${'p'.repeat(32)}`;
const webOrigin = 'https://client.example';
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-pwd:private-sdp\r\n';
const agentInput = { sessionId: 'smoke-session', turn: 0, goal: 'private goal', tools: [], observations: [] };
const servers: Server[] = [];
async function start(server: Server) {
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); vi.restoreAllMocks(); });

describe('production extension origin policy', () => {
  it('requires explicit operator opt-in and validates configuration', () => {
    expect(extensionOriginPolicy({})).toBe('allowlist');
    expect(extensionOriginPolicy({ BUDDY_EXTENSION_ORIGIN_POLICY: 'chrome-extensions' })).toBe('chrome-extensions');
    expect(() => extensionOriginPolicy({ BUDDY_EXTENSION_ORIGIN_POLICY: '*' })).toThrow();
    expect(isAllowedOrigin(extensionA, new Set(), 'allowlist')).toBe(false);
    expect(isAllowedOrigin(extensionA, new Set([extensionA]), 'allowlist')).toBe(true);
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'test', ALLOWED_ORIGINS: webOrigin, BUDDY_EXTENSION_ORIGIN_POLICY: 'chrome-extensions' })).not.toThrow();
  });

  it.each(['*', 'https://*.example', 'https://client.example/path', 'https://user:password@client.example', 'chrome-extension://short', `${extensionA}/`, 'https://127.1', 'https://LOCALHOST.'])('rejects unsafe production allowlist entry %s', (origin) => {
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'test', ALLOWED_ORIGINS: origin })).toThrow();
  });
});

describe.each([
  { path: '/agent/next', body: JSON.stringify(agentInput), contentType: 'application/json', status: 200 },
  { path: '/realtime/session', body: sdp, contentType: 'application/sdp', status: 201 },
])('origin and transport boundary $path', ({ path, body, contentType, status }) => {
  const provider = () => vi.fn(async () => path === '/agent/next'
    ? Response.json({ output_text: JSON.stringify({ kind: 'final', message: 'Ready', toolName: null, argsJson: null, label: null, reason: null }) })
    : new Response(sdp, { status: 201 })) as unknown as typeof fetch;

  it('accepts different judge extension IDs and exact web origins, including preflights', async () => {
    const fetchImpl = provider();
    const base = await start(createBuddyServer({ allowedOrigins: new Set([webOrigin]), extensionOriginPolicy: 'chrome-extensions', apiKey: 'server-key', fetchImpl }));
    for (const origin of [extensionA, extensionB, webOrigin]) {
      const preflight = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': `content-type${path === '/realtime/session' ? ',x-buddy-locale' : ''}` } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { origin, 'content-type': contentType }, body });
      expect(response.status).toBe(status);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('vary')).toBe('origin');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('blocks arbitrary web origins, malformed extension lookalikes, null, and originless requests', async () => {
    const fetchImpl = provider();
    const base = await start(createBuddyServer({ allowedOrigins: new Set([webOrigin]), extensionOriginPolicy: 'chrome-extensions', apiKey: 'server-key', fetchImpl }));
    for (const origin of [undefined, 'null', 'https://evil.example', 'http://client.example', 'https://client.example.evil', `${extensionA}/`, `${extensionA}.evil`, `${extensionA}:443`, `${extensionA}?x`, 'chrome-extension://short', `chrome-extension://${'z'.repeat(32)}`, `https://${'a'.repeat(32)}`, `chrome-extension://user@${'a'.repeat(32)}`]) {
      for (const method of ['POST', 'OPTIONS']) {
        const response = await fetch(`${base}${path}`, { method, headers: { ...(origin ? { origin } : {}), 'content-type': contentType }, ...(method === 'POST' ? { body } : {}) });
        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
      }
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('keeps authentication and rate limiting active across extension IDs', async () => {
    const fetchImpl = provider();
    const options = { allowedOrigins: new Set<string>(), extensionOriginPolicy: 'chrome-extensions' as const, apiKey: 'server-key', fetchImpl };
    const privateBase = await start(createBuddyServer({ ...options, authVerifier: { verify: () => false } }));
    expect((await fetch(`${privateBase}${path}`, { method: 'POST', headers: { origin: extensionA, 'content-type': contentType }, body })).status).toBe(401);
    const limit = new MemoryRateLimiter(1, 60_000);
    const base = await start(createBuddyServer({ ...options, rateLimiter: limit, realtimeRateLimiter: limit }));
    expect((await fetch(`${base}${path}`, { method: 'POST', headers: { origin: extensionA, 'content-type': contentType }, body })).status).toBe(status);
    expect((await fetch(`${base}${path}`, { method: 'POST', headers: { origin: extensionB, 'content-type': contentType }, body })).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['timeout', 'network'])('returns a safe provider %s failure', async (failure) => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (failure === 'network') throw new TypeError('server-key private-sdp private goal');
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('server-key private-sdp', 'AbortError')), { once: true }));
    }) as typeof fetch;
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const base = await start(createBuddyServer({ allowedOrigins: new Set(), extensionOriginPolicy: 'chrome-extensions', apiKey: 'server-key', fetchImpl, providerTimeoutMs: 5 }));
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { origin: extensionA, 'content-type': contentType }, body });
    expect(response.status).toBe(failure === 'timeout' ? 504 : 502);
    expect(await response.json()).toMatchObject({ error: { code: failure === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR' } });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/server-key|private-sdp|private goal/);
  });
});
