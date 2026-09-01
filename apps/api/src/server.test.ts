import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRateLimiter, createBuddyServer, parseAgentNextInput } from './server';

const origin = 'https://client.example';
const tool = { name: 'search', description: 'Search', origin, annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const payload = { sessionId: 'session-1', turn: 0, goal: 'Find a gift', tools: [tool], observations: [] };
const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo; return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); vi.restoreAllMocks(); });

describe('parseAgentNextInput', () => {
  it('accepts a bounded iterative request', () => {
    expect(parseAgentNextInput(payload)).toMatchObject({ sessionId: 'session-1', turn: 0, goal: 'Find a gift' });
  });
  it('rejects duplicate tool names', () => {
    expect(() => parseAgentNextInput({ ...payload, tools: [tool, tool] })).toThrow(/Duplicate/);
  });
  it('rejects an out-of-range turn', () => {
    expect(() => parseAgentNextInput({ ...payload, turn: 10 })).toThrow(/turn/);
  });
  it('rejects observations for tools outside the current inventory', () => {
    expect(() => parseAgentNextInput({ ...payload, observations: [{ callId: '1', toolName: 'missing', args: {}, outcome: 'success' }] })).toThrow(/observation/);
  });
});

describe('MemoryRateLimiter', () => {
  it('enforces its window and resets after expiry', () => {
    const limiter = new MemoryRateLimiter(2, 1_000); expect(limiter.allow('a', 0)).toBe(true); expect(limiter.allow('a', 1)).toBe(true); expect(limiter.allow('a', 2)).toBe(false); expect(limiter.allow('a', 1_001)).toBe(true);
  });
  it('keeps independent client buckets', () => {
    const limiter = new MemoryRateLimiter(1, 1_000); expect(limiter.allow('a', 0)).toBe(true); expect(limiter.allow('b', 0)).toBe(true);
  });
});

describe('Buddy API', () => {
  it('serves a credential-free health check', async () => {
    const base = await start(createBuddyServer({ apiKey: '' })); const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
  it('rejects callers outside the exact origin allowlist', async () => {
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test' }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(403);
  });
  it('supports a replaceable auth verifier', async () => {
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', authVerifier: { verify: () => false } }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(401);
  });
  it('returns a safe error when the provider key is absent', async () => {
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: '' }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(503); expect(response.headers.get('x-request-id')).toBeTruthy(); expect(await response.text()).not.toContain('OPENAI');
  });
  it('uses Responses Structured Outputs, store false, and the Luna default', async () => {
    let providerBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: JSON.stringify({ kind: 'tool_call', callId: '1', toolName: 'search', args: { query: 'gift' }, label: 'Search', reason: 'Find candidates', risk: 'READ' }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ kind: 'tool_call', toolName: 'search', risk: 'READ' });
    expect(providerBody).toMatchObject({ model: 'gpt-5.6-luna', store: false, text: { format: { type: 'json_schema', strict: true } } });
  });
  it('recomputes a dishonest provider risk label', async () => {
    const financialTool = { ...tool, name: 'purchase_now', description: 'Only reads', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({ kind: 'tool_call', callId: '1', toolName: 'purchase_now', args: {}, label: 'Read', reason: 'Continue', risk: 'READ' }) }), { status: 200 })) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, tools: [financialTool] }) });
    expect(await response.json()).toMatchObject({ risk: 'FINANCIAL' });
  });
  it('does not expose provider response details on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret provider detail', { status: 500 })) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('secret provider detail');
  });
});
