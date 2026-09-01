export type RiskCategory =
  | 'READ'
  | 'LOW_RISK_WRITE'
  | 'EXTERNAL_COMMUNICATION'
  | 'FINANCIAL'
  | 'DESTRUCTIVE'
  | 'SENSITIVE';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMCPTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  origin: string;
  annotations?: ToolAnnotations;
}

export interface Capability {
  id: string;
  label: string;
  description: string;
  risk: RiskCategory;
  toolNames: string[];
}

export interface AgentRules {
  allowRead: boolean;
  allowSearch: boolean;
  allowCompare: boolean;
  allowFormFill: boolean;
  askBeforeSubmit: boolean;
  askBeforeMessages: boolean;
  askBeforePurchase: boolean;
  askBeforeSensitive: boolean;
  blockDelete: boolean;
}

export const DEFAULT_RULES: AgentRules = {
  allowRead: true,
  allowSearch: true,
  allowCompare: true,
  allowFormFill: true,
  askBeforeSubmit: true,
  askBeforeMessages: true,
  askBeforePurchase: true,
  askBeforeSensitive: true,
  blockDelete: true,
};

export type ApprovalDecision = 'ALLOW' | 'ASK' | 'BLOCK';

export interface ActivityItem {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled';
  detail?: string;
  technical?: { tool: string; durationMs?: number; request?: unknown; response?: unknown };
}

export interface PlanStep {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  label: string;
  risk: RiskCategory;
}

export interface AgentPlan {
  summary: string;
  steps: PlanStep[];
  missingCapabilities: string[];
}

export interface PendingApproval {
  step: PlanStep;
  what: string;
  why: string;
  argumentsJson: string;
  site: string;
  risk: RiskCategory;
}

export interface AgentObservation {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  outcome: 'success' | 'error' | 'canceled' | 'rejected';
  result?: unknown;
  error?: string;
}

export interface AgentNextInput {
  sessionId: string;
  turn: number;
  goal: string;
  tools: WebMCPTool[];
  observations: AgentObservation[];
}

export type AgentDecision =
  | {
      kind: 'tool_call';
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      label: string;
      reason: string;
      risk: RiskCategory;
    }
  | {
      kind: 'rejected_tool_call';
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      message: string;
    }
  | { kind: 'final'; message: string }
  | { kind: 'needs_input'; message: string };

export const AGENT_NEXT_MESSAGE = 'buddy.agent.next' as const;

export interface AgentNextRuntimeMessage {
  type: typeof AGENT_NEXT_MESSAGE;
  payload: AgentNextInput;
}

export interface AgentRuntimeError {
  code: 'BAD_REQUEST' | 'UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMITED' | 'PROVIDER_ERROR';
  message: string;
  retryable: boolean;
}

export type AgentNextRuntimeResponse =
  | { ok: true; requestId: string; decision: AgentDecision }
  | { ok: false; requestId: string; error: AgentRuntimeError };

export const AGENT_LIMITS = {
  maxGoalLength: 2_000,
  maxTools: 64,
  maxObservations: 12,
  maxTurns: 10,
  maxPayloadBytes: 100_000,
  maxSchemaBytes: 10_000,
  maxResultCharacters: 4_000,
} as const;

export type BuddyState =
  | 'SLEEPING'
  | 'DETECTED'
  | 'IDLE'
  | 'LISTENING'
  | 'THINKING'
  | 'EXECUTING'
  | 'WAITING_FOR_APPROVAL'
  | 'SUCCESS'
  | 'ERROR';

export type Locale = 'en' | 'ar' | 'es';

export function safeJson(value: unknown, maxLength = 1500): string {
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return '[Unserializable result]';
  }
}
