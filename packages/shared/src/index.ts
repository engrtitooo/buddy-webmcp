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
  dataSummary: string;
}

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
