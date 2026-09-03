import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { validateToolSchema } from '@buddy/agent-core';
import {
  AGENT_CONTRACT_VERSION,
  AGENT_LIMITS,
  WebMCPToolValidationError,
  normalizeWebMCPTool,
  type AgentApiErrorResponse,
  type AgentErrorCode,
  type AgentNextInput,
  type AgentValidationStage,
  type WebMCPTool,
} from '@buddy/shared';
import { createOpenAIRequestBody, extractOpenAIOutputText, normalizeOpenAIModelDecision } from './openai';
import { extensionOriginPolicy, isAllowedOrigin, isChromeExtensionOrigin, type ExtensionOriginPolicy } from './origins';
import {
  MAX_REALTIME_SDP_BYTES,
  createOpenAIRealtimeCall,
  createRealtimeSafetyIdentifier,
  parseRealtimeLocale,
  realtimeConfig,
  validateRealtimeSdp,
  type RealtimeConfig,
} from './realtime';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const jsonLength = (value: unknown) => { try { return JSON.stringify(value).length; } catch { return Number.POSITIVE_INFINITY; } };
const logEvent = (event: string, details: Record<string, unknown>) => console.info(JSON.stringify({ event, ...details }));
const sanitizedArgumentShape = (args: Record<string, unknown> | undefined) => args ? Object.fromEntries(Object.entries(args).slice(0, 24).map(([key, value]) => [key, /password|secret|token|authorization|cookie|credential|credit.?card|ssn|passport|medical|health/i.test(key) ? 'redacted' : Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value])) : undefined;

export class RequestError extends Error {
  constructor(
    message: string,
    readonly errorCode: AgentErrorCode,
    readonly validationStage: AgentValidationStage,
    readonly status = 400,
    readonly toolName?: string,
  ) { super(message); }
}

export interface RateLimiter { allow(key: string, now?: number): boolean }

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maximum = 30, private readonly windowMs = 60_000) {}
  allow(key: string, now = Date.now()): boolean {
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) { this.buckets.set(key, { count: 1, resetAt: now + this.windowMs }); return true; }
    current.count += 1; return current.count <= this.maximum;
  }
}

export interface AuthVerifier { verify(req: IncomingMessage): boolean | Promise<boolean> }

export class EnvironmentAuthVerifier implements AuthVerifier {
  constructor(private readonly token = process.env.BUDDY_API_AUTH_TOKEN?.trim()) {}
  verify(req: IncomingMessage): boolean {
    if (!this.token) return true;
    const supplied = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!supplied) return false;
    const expectedBuffer = Buffer.from(this.token); const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
  }
}

export interface BuddyServerOptions {
  allowedOrigins?: Set<string>;
  allowOriginless?: boolean;
  extensionOriginPolicy?: ExtensionOriginPolicy;
  rateLimiter?: RateLimiter;
  authVerifier?: AuthVerifier;
  fetchImpl?: typeof fetch;
  providerTimeoutMs?: number;
  apiKey?: string;
  model?: string;
  realtimeRateLimiter?: RateLimiter;
  realtime?: RealtimeConfig;
}

export function assertProductionEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  extensionOriginPolicy(environment);
  if (environment.NODE_ENV !== 'production') return;
  const missing = ['OPENAI_API_KEY', 'ALLOWED_ORIGINS'].filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`Missing required production environment: ${missing.join(', ')}`);
  if (environment.ALLOW_ORIGINLESS === 'true') throw new Error('ALLOW_ORIGINLESS must remain false in production.');
  const origins = String(environment.ALLOWED_ORIGINS).split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error(`Invalid production origin: ${origin}`); }
    const hostname = parsed.hostname.replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) || hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:/.test(hostname)) throw new Error('Production ALLOWED_ORIGINS must not include localhost or loopback addresses.');
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'chrome-extension:') throw new Error('Production origins must use HTTPS or chrome-extension.');
    if (parsed.protocol === 'chrome-extension:' ? !isChromeExtensionOrigin(origin) : parsed.origin !== origin || parsed.hostname.includes('*')) throw new Error('Invalid production origin: expected an exact HTTPS or Chrome extension origin.');
  }
}

function configuredOrigins(): Set<string> {
  return new Set((process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean));
}

function parseTools(value: unknown): WebMCPTool[] {
  if (!Array.isArray(value) || value.length > AGENT_LIMITS.maxTools) throw new RequestError('Invalid tool inventory', 'INVALID_TOOL_INVENTORY', 'tool_inventory');
  const names = new Set<string>();
  return value.map((candidate) => {
    const candidateName = isRecord(candidate) && typeof candidate.name === 'string' ? candidate.name : undefined;
    const diagnosticToolName = candidateName && candidateName.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(candidateName) ? candidateName : undefined;
    let tool: WebMCPTool;
    try { tool = normalizeWebMCPTool(candidate); }
    catch (error) {
      if (error instanceof WebMCPToolValidationError) {
        const [errorCode, stage] = error.reason === 'schema'
          ? ['INVALID_TOOL_SCHEMA', 'tool_schema'] as const
          : error.reason === 'origin'
            ? ['INVALID_TOOL_ORIGIN', 'tool_origin'] as const
            : ['INVALID_TOOL_DEFINITION', 'tool_definition'] as const;
        throw new RequestError(error.message, errorCode, stage, 400, diagnosticToolName);
      }
      throw new RequestError('Invalid tool definition', 'INVALID_TOOL_DEFINITION', 'tool_definition', 400, diagnosticToolName);
    }
    if (names.has(tool.name)) throw new RequestError('Duplicate tool name', 'INVALID_TOOL_INVENTORY', 'tool_inventory', 400, tool.name);
    names.add(tool.name);
    try { validateToolSchema(tool); }
    catch { throw new RequestError('Invalid tool schema', 'INVALID_TOOL_SCHEMA', 'tool_schema', 400, tool.name); }
    return tool;
  });
}

export function parseAgentNextInput(value: unknown): AgentNextInput {
  if (!isRecord(value)) throw new RequestError('Invalid request body', 'INVALID_REQUEST_BODY', 'request_body');
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 128) throw new RequestError('Invalid session', 'INVALID_SESSION', 'session');
  if (!Number.isInteger(value.turn) || Number(value.turn) < 0 || Number(value.turn) >= AGENT_LIMITS.maxTurns) throw new RequestError('Invalid turn', 'INVALID_TURN', 'turn');
  if (typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > AGENT_LIMITS.maxGoalLength) throw new RequestError('Invalid goal', 'INVALID_GOAL', 'goal');
  const tools = parseTools(value.tools);
  if (!Array.isArray(value.observations) || value.observations.length > AGENT_LIMITS.maxObservations) throw new RequestError('Invalid observations', 'INVALID_OBSERVATIONS', 'observations');
  const observations = value.observations.map((observation) => {
    if (!isRecord(observation) || typeof observation.callId !== 'string' || observation.callId.length > 128 || typeof observation.toolName !== 'string' || !observation.toolName || observation.toolName.length > 128 || !isRecord(observation.args) || !['success', 'error', 'canceled', 'rejected'].includes(String(observation.outcome))) throw new RequestError('Invalid observation', 'INVALID_OBSERVATIONS', 'observations');
    if ((observation.outcome !== 'rejected' && !tools.some((tool) => tool.name === observation.toolName)) || jsonLength(observation) > AGENT_LIMITS.maxResultCharacters + 20_000) throw new RequestError('Invalid observation', 'INVALID_OBSERVATIONS', 'observations', 400, observation.toolName);
    return {
      callId: observation.callId, toolName: observation.toolName, args: observation.args, outcome: observation.outcome as 'success' | 'error' | 'canceled' | 'rejected',
      ...(observation.result !== undefined ? { result: observation.result } : {}), ...(typeof observation.error === 'string' ? { error: observation.error.slice(0, 1_000) } : {}),
    };
  });
  return { sessionId: value.sessionId, turn: Number(value.turn), goal: value.goal.trim(), tools, observations };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > AGENT_LIMITS.maxPayloadBytes) throw new RequestError('Request too large', 'PAYLOAD_TOO_LARGE', 'request_body', 413); }
  try { return JSON.parse(raw) as unknown; } catch { throw new RequestError('Invalid JSON', 'INVALID_REQUEST_BODY', 'request_body'); }
}

async function readSdpBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_REALTIME_SDP_BYTES) throw new RequestError('SDP offer is too large', 'INVALID_SDP', 'request_body', 413);
  }
  if (!validateRealtimeSdp(raw)) throw new RequestError('Invalid SDP offer', 'INVALID_SDP', 'request_body');
  return raw;
}

function deploymentInfo(): { contractVersion: number; commit: string; branch?: string } {
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || process.env.GIT_COMMIT_SHA?.trim() || 'unknown';
  const branch = process.env.RAILWAY_GIT_BRANCH?.trim();
  return { contractVersion: AGENT_CONTRACT_VERSION, commit, ...(branch ? { branch } : {}) };
}

export function createBuddyServer(options: BuddyServerOptions = {}): Server {
  const allowedOrigins = options.allowedOrigins ?? configuredOrigins();
  const extensionPolicy = options.extensionOriginPolicy ?? extensionOriginPolicy();
  const allowOriginless = options.allowOriginless ?? process.env.ALLOW_ORIGINLESS === 'true';
  const limiter = options.rateLimiter ?? new MemoryRateLimiter(Math.max(1, Number(process.env.BUDDY_RATE_LIMIT_MAX || 30)), Math.max(1_000, Number(process.env.BUDDY_RATE_LIMIT_WINDOW_MS || 60_000)));
  const auth = options.authVerifier ?? new EnvironmentAuthVerifier();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.providerTimeoutMs ?? Math.max(1_000, Number(process.env.BUDDY_PROVIDER_TIMEOUT_MS || 20_000));
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';
  const realtime = options.realtime ?? realtimeConfig();
  const realtimeLimiter = options.realtimeRateLimiter ?? new MemoryRateLimiter(realtime.sessionRateLimit, 60_000);

  return createServer(async (req, res) => {
    const started = Date.now(); const requestId = randomUUID(); const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const originAllowed = origin ? isAllowedOrigin(origin, allowedOrigins, extensionPolicy) : allowOriginless;
    const reply = (status: number, body: unknown, diagnostic?: { errorCode: AgentErrorCode; validationStage?: AgentValidationStage; toolName?: string }, responseHeaders: Record<string, string> = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId, 'access-control-allow-headers': 'content-type,authorization,x-buddy-locale', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'x-request-id,x-buddy-realtime-model,x-buddy-realtime-voice,x-buddy-realtime-vad,x-buddy-realtime-max-session-seconds', vary: 'origin', ...responseHeaders };
      if (origin && originAllowed) headers['access-control-allow-origin'] = origin;
      res.writeHead(status, headers); res.end(status === 204 ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
      const path = ['/', '/health', '/agent/next', '/realtime/session'].includes(req.url ?? '') ? req.url : 'unknown';
      console.info(JSON.stringify({ event: 'buddy_api_request', requestId, method: req.method, path, status, ...(diagnostic ?? {}), durationMs: Date.now() - started }));
    };
    const errorReply = (status: number, code: AgentErrorCode, message: string, validationStage?: AgentValidationStage, toolName?: string) => {
      const body: AgentApiErrorResponse = { requestId, error: { code, message, ...(validationStage ? { validationStage } : {}), ...(toolName ? { toolName } : {}) } };
      reply(status, body, { errorCode: code, ...(validationStage ? { validationStage } : {}), ...(toolName ? { toolName } : {}) });
    };
    if (req.url === '/' && req.method === 'GET') { reply(200, { name: 'Buddy WebMCP API', status: 'ok', health: '/health' }); return; }
    if (req.url === '/health' && req.method === 'GET') { reply(200, { status: 'ok', ...deploymentInfo() }); return; }
    if (!originAllowed) { errorReply(403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed'); return; }
    if (req.method === 'OPTIONS') { reply(204, {}); return; }
    const agentRequest = req.url === '/agent/next' && req.method === 'POST';
    const realtimeRequest = req.url === '/realtime/session' && req.method === 'POST';
    if (!agentRequest && !realtimeRequest) { reply(404, { error: 'Not found', requestId }); return; }
    if (!await auth.verify(req)) { errorReply(401, 'UNAUTHORIZED', 'Unauthorized'); return; }
    // Share extension quotas across IDs so rotating an unpacked ID cannot reset a bucket.
    // Do not trust caller-controlled X-Forwarded-For; a gateway can supply a durable limiter.
    const clientKey = `${origin && isChromeExtensionOrigin(origin) ? 'chrome-extension' : origin ?? 'originless'}:${req.socket.remoteAddress || 'unknown'}`;
    if (!(realtimeRequest ? realtimeLimiter : limiter).allow(clientKey)) { errorReply(429, 'RATE_LIMITED', 'Too many requests'); return; }
    if (realtimeRequest) {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/sdp')) { errorReply(415, 'INVALID_SDP', 'Content-Type must be application/sdp', 'request_body'); return; }
      if (!apiKey) { errorReply(503, 'PROVIDER_ERROR', 'AI provider is not configured', 'provider'); return; }
      try {
        const sdp = await readSdpBody(req);
        const locale = parseRealtimeLocale(req.headers['x-buddy-locale']);
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await createOpenAIRealtimeCall({
            apiKey,
            sdp,
            locale,
            config: realtime,
            safetyIdentifier: createRealtimeSafetyIdentifier(apiKey, origin, req.socket.remoteAddress),
            fetchImpl,
            signal: controller.signal,
          });
          if (!response.ok) { errorReply(response.status === 429 ? 429 : 502, response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR', 'Realtime provider request failed', 'provider'); return; }
          const answer = await response.text();
          if (!validateRealtimeSdp(answer)) { errorReply(502, 'PROVIDER_ERROR', 'Realtime provider returned an invalid answer', 'provider'); return; }
          logEvent('buddy_realtime_session_created', { requestId, model: realtime.model, voice: realtime.voice, locale, vadMode: 'semantic_vad' });
          reply(201, answer, undefined, {
            'content-type': 'application/sdp',
            'x-buddy-realtime-model': realtime.model,
            'x-buddy-realtime-voice': realtime.voice,
            'x-buddy-realtime-vad': 'semantic_vad',
            'x-buddy-realtime-max-session-seconds': String(realtime.maxSessionSeconds),
          });
        } finally { clearTimeout(timeout); }
      } catch (error) {
        if (error instanceof RequestError) { errorReply(error.status, error.errorCode, error.message, error.validationStage); return; }
        if (error instanceof DOMException && error.name === 'AbortError') { errorReply(504, 'TIMEOUT', 'Realtime provider request timed out', 'provider'); return; }
        errorReply(502, 'PROVIDER_ERROR', 'Realtime session request failed', 'provider');
      }
      return;
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { errorReply(415, 'INVALID_REQUEST_BODY', 'Content-Type must be application/json', 'request_body'); return; }
    if (!apiKey) { errorReply(503, 'PROVIDER_ERROR', 'AI provider is not configured', 'provider'); return; }
    try {
      const input = parseAgentNextInput(await readJsonBody(req));
      logEvent('buddy_agent_turn', { requestId, sessionId: input.sessionId, turn: input.turn, toolCount: input.tools.length, observationCount: input.observations.length, lastObservationStatus: input.observations.at(-1)?.outcome ?? 'none' });
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(createOpenAIRequestBody(input, model)),
        });
        if (!response.ok) { errorReply(response.status === 429 ? 429 : 502, response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR', 'Provider request failed', 'provider'); return; }
        const text = extractOpenAIOutputText(await response.json()); if (!text) throw new Error('Empty provider result');
        const decision = normalizeOpenAIModelDecision(JSON.parse(text), input.tools);
        logEvent('buddy_agent_decision', { requestId, sessionId: input.sessionId, turn: input.turn, decisionKind: decision.kind, toolName: 'toolName' in decision ? decision.toolName : undefined, sanitizedArgs: 'args' in decision ? sanitizedArgumentShape(decision.args) : undefined });
        if (decision.kind === 'rejected_tool_call') logEvent('buddy_tool_validation_failed', { requestId, sessionId: input.sessionId, turn: input.turn, toolName: decision.toolName });
        if (decision.kind === 'final') logEvent('buddy_agent_final', { requestId, sessionId: input.sessionId, turn: input.turn });
        reply(200, decision);
      } finally { clearTimeout(timeout); }
    } catch (error) {
      if (error instanceof RequestError) { errorReply(error.status, error.errorCode, error.message, error.validationStage, error.toolName); return; }
      if (error instanceof DOMException && error.name === 'AbortError') { errorReply(504, 'TIMEOUT', 'Provider request timed out', 'provider'); return; }
      errorReply(502, 'PROVIDER_ERROR', 'Agent request failed', 'provider');
    }
  });
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const port = Number(process.env.PORT || 8787); const host = process.env.HOST || '127.0.0.1';
  assertProductionEnvironment();
  createBuddyServer().listen(port, host, () => console.log(`Buddy API listening on http://${host}:${port}`));
}
