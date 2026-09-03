import {
  AGENT_LIMITS,
  AGENT_NEXT_MESSAGE,
  REALTIME_SESSION_MESSAGE,
  type AgentNextInput,
  type AgentNextRuntimeResponse,
  type Locale,
  type RealtimeSessionRuntimeResponse,
} from '@buddy/shared';
import { normalizeAgentApiFailure, safeRequestId } from './api-errors';

declare const __BUDDY_API_BASE_URL__: string;

const API_BASE_URL = __BUDDY_API_BASE_URL__.replace(/\/$/, '');
// Allow the API's default 20-second provider deadline to return its safe diagnostic first.
const REQUEST_TIMEOUT_MS = 30_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function validPayload(value: unknown): value is AgentNextInput {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length > 128) return false;
  if (!Number.isInteger(value.turn) || Number(value.turn) < 0 || Number(value.turn) >= AGENT_LIMITS.maxTurns) return false;
  if (typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > AGENT_LIMITS.maxGoalLength) return false;
  if (!Array.isArray(value.tools) || value.tools.length > AGENT_LIMITS.maxTools) return false;
  if (!Array.isArray(value.observations) || value.observations.length > AGENT_LIMITS.maxObservations) return false;
  try { return JSON.stringify(value).length <= AGENT_LIMITS.maxPayloadBytes; } catch { return false; }
}

async function requestNext(payload: AgentNextInput): Promise<AgentNextRuntimeResponse> {
  const fallbackRequestId = crypto.randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}/agent/next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    const requestId = safeRequestId(response.headers.get('x-request-id'), fallbackRequestId);
    if (!response.ok) {
      let body: unknown;
      try { body = await response.json(); } catch (error) { if (controller.signal.aborted) throw error; body = undefined; }
      return { ok: false, requestId, error: normalizeAgentApiFailure(response.status, body) };
    }
    return { ok: true, requestId, decision: await response.json() } as AgentNextRuntimeResponse;
  } catch {
    const timedOut = controller.signal.aborted;
    return { ok: false, requestId: fallbackRequestId, error: { code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', message: timedOut ? 'The agent service took too long to respond.' : 'The agent service is unavailable.', retryable: true } };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestRealtimeSession(sdp: string, locale: Locale): Promise<RealtimeSessionRuntimeResponse> {
  const fallbackRequestId = crypto.randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}/realtime/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp', 'x-buddy-locale': locale },
      body: sdp,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    const requestId = safeRequestId(response.headers.get('x-request-id'), fallbackRequestId);
    if (!response.ok) {
      let body: unknown;
      try { body = await response.json(); } catch (error) { if (controller.signal.aborted) throw error; body = undefined; }
      return { ok: false, requestId, error: normalizeAgentApiFailure(response.status, body) };
    }
    const answer = await response.text();
    if (!answer.startsWith('v=0') || answer.length > 64_000) {
      return { ok: false, requestId, error: { code: 'PROVIDER_ERROR', message: 'Voice Mode received an invalid connection response.', retryable: true } };
    }
    return {
      ok: true,
      requestId,
      sdp: answer,
      model: response.headers.get('x-buddy-realtime-model') ?? 'gpt-realtime-2.1',
      voice: response.headers.get('x-buddy-realtime-voice') ?? 'marin',
      vadMode: 'semantic_vad',
      maxSessionSeconds: Math.max(60, Math.min(3_600, Number(response.headers.get('x-buddy-realtime-max-session-seconds')) || 900)),
    };
  } catch {
    const timedOut = controller.signal.aborted;
    return { ok: false, requestId: fallbackRequestId, error: { code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', message: timedOut ? 'Voice Mode took too long to connect.' : 'Voice Mode is temporarily unavailable.', retryable: true } };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isRecord(message) || (message.type !== AGENT_NEXT_MESSAGE && message.type !== REALTIME_SESSION_MESSAGE)) return undefined;
  if (sender.id !== chrome.runtime.id || !sender.url || !/^https?:\/\//i.test(sender.url)) {
    return Promise.resolve({ ok: false, requestId: crypto.randomUUID(), error: { code: 'INVALID_REQUEST_BODY', message: 'Untrusted request source.', retryable: false, validationStage: 'request_body' } });
  }
  if (message.type === REALTIME_SESSION_MESSAGE) {
    const payload = message.payload;
    if (!isRecord(payload) || typeof payload.sdp !== 'string' || !payload.sdp.startsWith('v=0') || payload.sdp.length > 64_000 || !['en', 'ar', 'es'].includes(String(payload.locale))) {
      return Promise.resolve<RealtimeSessionRuntimeResponse>({ ok: false, requestId: crypto.randomUUID(), error: { code: 'INVALID_SDP', message: 'Invalid voice session request.', retryable: false, validationStage: 'request_body' } });
    }
    return requestRealtimeSession(payload.sdp, payload.locale as Locale);
  }
  if (!validPayload(message.payload)) {
    return Promise.resolve<AgentNextRuntimeResponse>({ ok: false, requestId: crypto.randomUUID(), error: { code: 'INVALID_REQUEST_BODY', message: 'Invalid agent request.', retryable: false, validationStage: 'request_body' } });
  }
  return requestNext(message.payload);
});
