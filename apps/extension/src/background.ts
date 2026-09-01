import {
  AGENT_LIMITS,
  AGENT_NEXT_MESSAGE,
  type AgentNextInput,
  type AgentNextRuntimeResponse,
} from '@buddy/shared';

declare const __BUDDY_API_BASE_URL__: string;

const API_BASE_URL = __BUDDY_API_BASE_URL__.replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 20_000;
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
    const requestId = response.headers.get('x-request-id') ?? fallbackRequestId;
    if (!response.ok) {
      const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UNAVAILABLE' : 'BAD_REQUEST';
      return { ok: false, requestId, error: { code, message: response.status === 429 ? 'Buddy is busy. Please wait a moment and try again.' : 'Buddy could not safely plan the next action.', retryable: response.status === 429 || response.status >= 500 } };
    }
    return { ok: true, requestId, decision: await response.json() } as AgentNextRuntimeResponse;
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'AbortError';
    return { ok: false, requestId: fallbackRequestId, error: { code: timedOut ? 'TIMEOUT' : 'UNAVAILABLE', message: timedOut ? 'The agent service took too long to respond.' : 'The agent service is unavailable.', retryable: true } };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isRecord(message) || message.type !== AGENT_NEXT_MESSAGE) return undefined;
  if (sender.id !== chrome.runtime.id || !sender.url || !/^https?:\/\//i.test(sender.url)) {
    return Promise.resolve<AgentNextRuntimeResponse>({ ok: false, requestId: crypto.randomUUID(), error: { code: 'BAD_REQUEST', message: 'Untrusted request source.', retryable: false } });
  }
  if (!validPayload(message.payload)) {
    return Promise.resolve<AgentNextRuntimeResponse>({ ok: false, requestId: crypto.randomUUID(), error: { code: 'BAD_REQUEST', message: 'Invalid agent request.', retryable: false } });
  }
  return requestNext(message.payload);
});
