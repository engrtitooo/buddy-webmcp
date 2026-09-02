import { MockAgentProvider, type AgentProvider } from '@buddy/agent-core';
import {
  AGENT_NEXT_MESSAGE,
  AgentServiceError,
  type AgentNextInput,
  type AgentNextRuntimeMessage,
  type AgentNextRuntimeResponse,
  type Capability,
  type PlanStep,
} from '@buddy/shared';

function abortError(): DOMException {
  return new DOMException('The request was canceled.', 'AbortError');
}

export class ExtensionAgentProvider implements AgentProvider {
  async next(input: AgentNextInput, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const message: AgentNextRuntimeMessage = { type: AGENT_NEXT_MESSAGE, payload: input };
    const pending = chrome.runtime.sendMessage(message) as Promise<AgentNextRuntimeResponse>;
    const response = signal
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true })),
        ])
      : await pending;
    if (!response || !response.ok) {
      const requestId = response?.requestId ?? crypto.randomUUID();
      const details = response?.error ?? { code: 'UNAVAILABLE' as const, message: 'Buddy could not reach its agent service.', retryable: true };
      throw new AgentServiceError(details.message, requestId, details);
    }
    return response.decision;
  }

  async summarizeCapabilities(capabilities: Capability[]): Promise<string> {
    return new MockAgentProvider().summarizeCapabilities(capabilities);
  }

  async interpretToolResult(step: PlanStep, result: unknown): Promise<string> {
    return new MockAgentProvider().interpretToolResult(step, result);
  }
}
