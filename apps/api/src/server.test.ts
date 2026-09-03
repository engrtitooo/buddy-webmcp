import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_LIMITS, type AgentNextInput } from '@buddy/shared';
import { OPENAI_DECISION_SCHEMA, normalizeOpenAIModelDecision } from './openai';
import { MemoryRateLimiter, RequestError, assertProductionEnvironment, createBuddyServer, parseAgentNextInput } from './server';
import { createRealtimeSessionConfig, realtimeConfig, validateRealtimeSdp } from './realtime';

const origin = 'https://client.example';
const tool = { name: 'search', description: 'Search', origin, annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const payload = { sessionId: 'session-1', turn: 0, goal: 'Find a gift', tools: [tool], observations: [] };
const servers: Server[] = [];
const modelToolCall = (overrides: Record<string, unknown> = {}) => ({ kind: 'tool_call', toolName: 'search', argsJson: '{"query":"gift"}', label: 'Search for gifts', reason: 'Find candidates', message: null, ...overrides });

async function start(server: Server): Promise<string> {
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo; return `http://127.0.0.1:${address.port}`;
}

function expectClosedObjectSchemas(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(expectClosedObjectSchemas); return; }
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object') expect(schema.additionalProperties).toBe(false);
  Object.values(schema).forEach(expectClosedObjectSchemas);
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
  it('accepts bounded rejected-call feedback for a nonexistent tool', () => {
    expect(parseAgentNextInput({ ...payload, observations: [{ callId: '1', toolName: 'missing', args: {}, outcome: 'rejected', error: 'Use an available tool.' }] }).observations[0]).toMatchObject({ toolName: 'missing', outcome: 'rejected' });
  });
  it('accepts empty, list, required-string, and subscription object schemas', () => {
    const tools = [
      { name: 'get_site_info', description: 'Get site info', origin: 'https://cloverbase.com', inputSchema: { type: 'object', properties: {} } },
      { name: 'list_posts', title: 'List posts', description: 'List posts', origin: 'https://cloverbase.com', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
      { name: 'search_posts', description: 'Search posts', origin: 'https://cloverbase.com', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'subscribe_newsletter', description: 'Subscribe', origin: 'https://cloverbase.com', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } },
    ];
    const result = parseAgentNextInput({ ...payload, sessionId: 'b8d90c28-5432-45fb-921d-7245ea90c3fb', goal: 'Show what you can do', tools, observations: [] });
    expect(result.tools).toHaveLength(4); expect(result.observations).toEqual([]);
  });
  it('accepts omitted title and annotations and canonicalizes a valid origin', () => {
    const result = parseAgentNextInput({ ...payload, tools: [{ name: 'get_site_info', description: 'Info', origin: 'https://cloverbase.com/path?ignored=1', inputSchema: { type: 'object' } }] });
    expect(result.tools[0]).toEqual({ name: 'get_site_info', description: 'Info', origin: 'https://cloverbase.com', inputSchema: { type: 'object' } });
  });
  it('rejects malformed and oversized schemas at the tool-schema stage', () => {
    for (const inputSchema of [{ type: 'not-a-json-schema-type' }, { type: 'object', description: 'x'.repeat(AGENT_LIMITS.maxSchemaBytes) }]) {
      let thrown: unknown;
      try { parseAgentNextInput({ ...payload, tools: [{ ...tool, inputSchema }] }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(RequestError);
      expect(thrown).toMatchObject({ errorCode: 'INVALID_TOOL_SCHEMA', validationStage: 'tool_schema', toolName: 'search' });
    }
  });
  it('rejects prototype-pollution keys in schemas', () => {
    const inputSchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as Record<string, unknown>;
    expect(() => parseAgentNextInput({ ...payload, tools: [{ ...tool, inputSchema }] })).toThrow(/schema/i);
  });
});

describe('production environment', () => {
  it('fails fast when required production values are missing', () => {
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production' })).toThrow(/OPENAI_API_KEY, ALLOWED_ORIGINS/);
  });
  it('rejects originless and localhost production configurations', () => {
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'test', ALLOWED_ORIGINS: 'https://app.example', ALLOW_ORIGINLESS: 'true' })).toThrow(/originless/i);
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'test', ALLOWED_ORIGINS: 'http://localhost:5173' })).toThrow(/localhost/i);
  });
  it('rejects invalid and insecure public production origins', () => {
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'test', ALLOWED_ORIGINS: 'not-an-origin' })).toThrow(/invalid production origin/i);
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'test', ALLOWED_ORIGINS: 'http://app.example' })).toThrow(/HTTPS or chrome-extension/i);
  });
  it('accepts an explicit production extension origin', () => {
    expect(() => assertProductionEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'test', ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnop' })).not.toThrow();
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
  it('serves a public API status at the root without weakening protected routes', async () => {
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: '' })); const response = await fetch(base);
    expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({ name: 'Buddy WebMCP API', status: 'ok', health: '/health' });
  });
  it('serves a credential-free health check', async () => {
    const base = await start(createBuddyServer({ apiKey: '' })); const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200); await expect(response.json()).resolves.toMatchObject({ status: 'ok', contractVersion: 2, commit: expect.any(String) });
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
  it('sends OpenAI a strict fixed-object Structured Output contract', async () => {
    let providerBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: JSON.stringify(modelToolCall()) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ kind: 'tool_call', toolName: 'search', risk: 'READ' });
    expect(providerBody).toMatchObject({ model: 'gpt-5.6-luna', store: false, text: { format: { type: 'json_schema', strict: true } } });
    const format = ((providerBody?.text as Record<string, unknown>).format as Record<string, unknown>);
    const schema = format.schema as Record<string, unknown>;
    expect(format.type).toBe('json_schema'); expect(format.strict).toBe(true);
    expect(schema).toEqual(OPENAI_DECISION_SCHEMA); expect(schema.type).toBe('object'); expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty('anyOf'); expect(schema).not.toHaveProperty('oneOf'); expectClosedObjectSchemas(schema);
    expect(schema.required).toEqual(['kind', 'toolName', 'argsJson', 'label', 'reason', 'message']);
    expect(Object.keys(schema.properties as Record<string, unknown>)).not.toEqual(expect.arrayContaining(['args', 'risk', 'callId']));
    const exactProviderInput = JSON.parse(String(providerBody?.input)) as AgentNextInput;
    expect(exactProviderInput.tools[0]?.inputSchema).toEqual(tool.inputSchema);
    expect(exactProviderInput.tools[0]?.inputSchema).not.toHaveProperty('catalog');
  });

  it('lets “Show what you can do” reach the provider boundary on turn zero', async () => {
    let providerInput: AgentNextInput | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      providerInput = JSON.parse(body.input) as AgentNextInput;
      return new Response(JSON.stringify({ output_text: JSON.stringify({ kind: 'final', toolName: null, argsJson: null, label: null, reason: null, message: 'Here is what I can do.' }) }), { status: 200 });
    }) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, sessionId: '4072cc55-e39a-4df7-889f-aae31886befd', goal: 'Show what you can do', observations: [] }) });
    expect(response.status).toBe(200); expect(providerInput).toMatchObject({ turn: 0, goal: 'Show what you can do', observations: [] });
  });

  it.each(['What can you do here?', 'Explain what this site lets you do.', 'Help me choose.'])('allows a conversational final response for “%s” without forcing a tool call', async (goal) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({ kind: 'final', toolName: null, argsJson: null, label: null, reason: null, message: 'I can explain the available options.' }) }), { status: 200 })) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, goal }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ kind: 'final', message: 'I can explain the available options.' });
  });

  it('returns and logs safe validation diagnostics without logging the goal', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test' }));
    const secretGoal = 'private user wording';
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, goal: secretGoal, tools: [{ ...tool, inputSchema: 'serialized-at-the-wrong-boundary' }] }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ requestId: expect.any(String), error: { code: 'INVALID_TOOL_SCHEMA', validationStage: 'tool_schema', toolName: 'search' } });
    const log = info.mock.calls.map(([entry]) => String(entry)).join('\n');
    expect(log).toContain('"errorCode":"INVALID_TOOL_SCHEMA"'); expect(log).toContain('"validationStage":"tool_schema"'); expect(log).not.toContain(secretGoal);
  });

  it('normalizes valid tool_call, final, and needs_input envelopes', () => {
    expect(normalizeOpenAIModelDecision(modelToolCall(), [tool])).toMatchObject({ kind: 'tool_call', toolName: 'search', args: { query: 'gift' }, risk: 'READ' });
    expect(normalizeOpenAIModelDecision({ kind: 'final', toolName: null, argsJson: null, label: null, reason: null, message: 'Done.' }, [tool])).toEqual({ kind: 'final', message: 'Done.' });
    expect(normalizeOpenAIModelDecision({ kind: 'needs_input', toolName: null, argsJson: null, label: null, reason: null, message: 'Which date?' }, [tool])).toEqual({ kind: 'needs_input', message: 'Which date?' });
    expect(() => normalizeOpenAIModelDecision({ kind: 'final', toolName: 'search', argsJson: null, label: null, reason: null, message: 'Done.' }, [tool])).toThrow(/inconsistent/);
  });

  it.each([
    ['malformed JSON', '{not json', /valid JSON/],
    ['an array', '["gift"]', /JSON object/],
    ['a primitive', '42', /JSON object/],
    ['schema-invalid arguments', '{}', /schema/],
  ])('turns argsJson containing %s into repairable feedback', (_case, argsJson, message) => {
    expect(normalizeOpenAIModelDecision(modelToolCall({ argsJson }), [tool])).toMatchObject({ kind: 'rejected_tool_call', toolName: 'search', message: expect.stringMatching(message) });
  });

  it('turns an unavailable tool into non-executable repair feedback', () => {
    expect(normalizeOpenAIModelDecision(modelToolCall({ toolName: 'missing' }), [tool])).toMatchObject({ kind: 'rejected_tool_call', toolName: 'missing', args: { query: 'gift' } });
  });

  it('never accepts a provider risk or call ID and derives both locally', () => {
    const financialTool = { ...tool, name: 'purchase_now', description: 'Only reads', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } };
    const decision = normalizeOpenAIModelDecision(modelToolCall({ toolName: 'purchase_now', argsJson: '{}' }), [financialTool]);
    expect(decision).toMatchObject({ kind: 'tool_call', risk: 'FINANCIAL', callId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(() => normalizeOpenAIModelDecision({ ...modelToolCall(), risk: 'READ', callId: 'provider-id' }, [tool])).toThrow(/envelope/);
  });
  it('rejects oversized request bodies', async () => {
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test' }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, goal: 'x'.repeat(110_000) }) });
    expect(response.status).toBe(413);
  });
  it('normalizes provider timeouts without exposing details', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('provider secret', 'AbortError')), { once: true }))) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl, providerTimeoutMs: 5 }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(504); const body = await response.text(); expect(body).toContain('timed out'); expect(body).not.toContain('provider secret');
  });
  it('does not expose provider response details on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret provider detail', { status: 500 })) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/agent/next`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('secret provider detail');
  });
});

describe('Buddy Realtime bootstrap', () => {
  const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  const answer = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

  it('builds a server-owned semantic VAD and internal-tool-only session', () => {
    const session = createRealtimeSessionConfig(realtimeConfig({}), 'ar');
    expect(session).toMatchObject({
      model: 'gpt-realtime-2.1',
      output_modalities: ['audio'],
      audio: { input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true } }, output: { voice: 'marin' } },
      tools: [{ type: 'function', name: 'buddy_webmcp_request' }],
    });
    expect(JSON.stringify(session)).toContain('Arabic');
    expect(JSON.stringify(session)).not.toContain('executeTool');
  });

  it('forwards bounded SDP through the unified calls API without exposing the key', async () => {
    let providerForm: FormData | undefined; let providerHeaders: Headers | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      providerForm = init?.body as FormData; providerHeaders = new Headers(init?.headers);
      return new Response(answer, { status: 201, headers: { 'content-type': 'application/sdp' } });
    }) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'server-secret', fetchImpl }));
    const response = await fetch(`${base}/realtime/session`, { method: 'POST', headers: { origin, 'content-type': 'application/sdp', 'x-buddy-locale': 'es' }, body: offer });
    expect(response.status).toBe(201); expect(await response.text()).toBe(answer);
    expect(response.headers.get('x-buddy-realtime-model')).toBe('gpt-realtime-2.1'); expect(response.headers.get('x-buddy-realtime-voice')).toBe('marin');
    expect(providerForm?.get('sdp')).toBe(offer);
    const session = JSON.parse(String(providerForm?.get('session'))) as Record<string, unknown>;
    expect(session).toMatchObject({ model: 'gpt-realtime-2.1', audio: { output: { voice: 'marin' } } }); expect(JSON.stringify(session)).toContain('Spanish');
    expect(providerHeaders?.get('authorization')).toBe('Bearer server-secret');
    expect(providerHeaders?.get('openai-safety-identifier')).toMatch(/^[a-f0-9]{64}$/);
    expect(await (await fetch(`${base}/health`)).text()).not.toContain('server-secret');
  });

  it('rejects unapproved origins, malformed SDP, wrong media types, and bootstrap floods', async () => {
    const fetchImpl = vi.fn(async () => new Response(answer, { status: 201 })) as typeof fetch;
    const realtimeRateLimiter = new MemoryRateLimiter(2, 60_000);
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl, realtimeRateLimiter }));
    const evil = await fetch(`${base}/realtime/session`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/sdp' }, body: offer }); expect(evil.status).toBe(403);
    const malformed = await fetch(`${base}/realtime/session`, { method: 'POST', headers: { origin, 'content-type': 'application/sdp' }, body: 'not-sdp' }); expect(malformed.status).toBe(400);
    const wrongType = await fetch(`${base}/realtime/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }); expect(wrongType.status).toBe(415);
    const flooded = await fetch(`${base}/realtime/session`, { method: 'POST', headers: { origin, 'content-type': 'application/sdp' }, body: offer }); expect(flooded.status).toBe(429);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized SDP offer before contacting OpenAI', async () => {
    const fetchImpl = vi.fn(async () => new Response(answer, { status: 201 })) as typeof fetch;
    const base = await start(createBuddyServer({ allowedOrigins: new Set([origin]), apiKey: 'test', fetchImpl }));
    const response = await fetch(`${base}/realtime/session`, { method: 'POST', headers: { origin, 'content-type': 'application/sdp' }, body: `${offer}${'a'.repeat(64_000)}` });
    expect(response.status).toBe(413); expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates SDP and optional config bounds without adding required secrets', () => {
    expect(validateRealtimeSdp(offer)).toBe(true); expect(validateRealtimeSdp('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96')).toBe(false);
    expect(realtimeConfig({ OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1', OPENAI_REALTIME_VOICE: 'marin', BUDDY_REALTIME_MAX_SESSION_SECONDS: '1200', BUDDY_REALTIME_SESSION_RATE_LIMIT: '12' })).toEqual({ model: 'gpt-realtime-2.1', voice: 'marin', maxSessionSeconds: 1200, sessionRateLimit: 12 });
    expect(() => realtimeConfig({ OPENAI_REALTIME_VOICE: 'not-a-voice' })).toThrow(/voice/);
  });
});
