import { MockAgentProvider, normalizeAgentDecision, type AgentProvider } from '@buddy/agent-core';
import {
  AGENT_NEXT_MESSAGE,
  type AgentDecision,
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
  async next(input: AgentNextInput, signal?: AbortSignal): Promise<AgentDecision> {
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
      throw new Error(response?.error.message ?? 'Buddy could not reach its agent service.');
    }
    return normalizeAgentDecision(response.decision, input.tools);
  }

  async summarizeCapabilities(capabilities: Capability[]): Promise<string> {
    return new MockAgentProvider().summarizeCapabilities(capabilities);
  }

  async interpretToolResult(step: PlanStep, result: unknown): Promise<string> {
    return new MockAgentProvider().interpretToolResult(step, result);
  }
}
