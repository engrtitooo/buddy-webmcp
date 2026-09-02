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

export type WebMCPToolValidationReason = 'definition' | 'schema' | 'origin';

export class WebMCPToolValidationError extends Error {
  constructor(
    message: string,
    readonly reason: WebMCPToolValidationReason,
    readonly toolName?: string,
  ) {
    super(message);
    this.name = 'WebMCPToolValidationError';
  }
}

const blockedObjectKeys = new Set(['__proto__', 'prototype', 'constructor']);

function cloneJsonValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers are not JSON values.');
    return value;
  }
  if (typeof value !== 'object' || depth > 64) throw new Error('The value is not bounded JSON data.');
  if (seen.has(value)) throw new Error('Cyclic JSON data is not supported.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) throw new Error('Non-plain arrays are not supported.');
      return value.map((item) => cloneJsonValue(item, seen, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) throw new Error('Non-plain objects are not supported.');
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (blockedObjectKeys.has(key)) throw new Error('Unsafe object keys are not supported.');
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) throw new Error('Accessor properties are not supported.');
      clone[key] = cloneJsonValue(descriptor.value, seen, depth + 1);
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

export function jsonByteLength(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return Number.POSITIVE_INFINITY; }
}

export function normalizeWebMCPInputSchema(value: unknown, toolName?: string): Record<string, unknown> {
  let clone: unknown;
  try { clone = cloneJsonValue(value, new WeakSet<object>(), 0); }
  catch { throw new WebMCPToolValidationError('Invalid tool schema', 'schema', toolName); }
  if (!clone || typeof clone !== 'object' || Array.isArray(clone) || jsonByteLength(clone) > AGENT_LIMITS.maxSchemaBytes) {
    throw new WebMCPToolValidationError('Invalid tool schema', 'schema', toolName);
  }
  // Round-tripping removes null/custom prototypes before the value crosses a
  // browser or HTTP boundary and produces the canonical JSON representation.
  return JSON.parse(JSON.stringify(clone)) as Record<string, unknown>;
}

export function canonicalWebMCPOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 2_000) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin === 'null') return undefined;
    return parsed.origin;
  } catch { return undefined; }
}

export function normalizeWebMCPTool(value: unknown): WebMCPTool {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebMCPToolValidationError('Invalid tool definition', 'definition');
  const candidate = value as Record<string, unknown>;
  const toolName = typeof candidate.name === 'string' ? candidate.name : undefined;
  if (!toolName || toolName.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(toolName) || typeof candidate.description !== 'string' || !candidate.description || candidate.description.length > 2_000) {
    throw new WebMCPToolValidationError('Invalid tool definition', 'definition', toolName);
  }
  const origin = canonicalWebMCPOrigin(candidate.origin);
  if (!origin) throw new WebMCPToolValidationError('Invalid tool origin', 'origin', toolName);
  const title = typeof candidate.title === 'string' && candidate.title.trim() && candidate.title.length <= 240 ? candidate.title.trim() : undefined;
  const annotationsValue = candidate.annotations;
  const annotations = annotationsValue && typeof annotationsValue === 'object' && !Array.isArray(annotationsValue) ? {
    ...(typeof (annotationsValue as Record<string, unknown>).readOnlyHint === 'boolean' ? { readOnlyHint: (annotationsValue as Record<string, unknown>).readOnlyHint as boolean } : {}),
    ...(typeof (annotationsValue as Record<string, unknown>).untrustedContentHint === 'boolean' ? { untrustedContentHint: (annotationsValue as Record<string, unknown>).untrustedContentHint as boolean } : {}),
  } : undefined;
  const inputSchema = candidate.inputSchema === undefined ? undefined : normalizeWebMCPInputSchema(candidate.inputSchema, toolName);
  return {
    name: toolName,
    ...(title ? { title } : {}),
    description: candidate.description,
    ...(inputSchema ? { inputSchema } : {}),
    origin,
    ...(annotations && Object.keys(annotations).length ? { annotations } : {}),
  };
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

export type AgentErrorCode =
  | 'INVALID_REQUEST_BODY'
  | 'INVALID_SESSION'
  | 'INVALID_TURN'
  | 'INVALID_GOAL'
  | 'INVALID_TOOL_INVENTORY'
  | 'INVALID_TOOL_DEFINITION'
  | 'INVALID_TOOL_SCHEMA'
  | 'INVALID_TOOL_ORIGIN'
  | 'INVALID_OBSERVATIONS'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHORIZED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR';

export type AgentValidationStage = 'request_body' | 'session' | 'turn' | 'goal' | 'tool_inventory' | 'tool_definition' | 'tool_schema' | 'tool_origin' | 'observations' | 'provider';

export interface AgentRuntimeError {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  validationStage?: AgentValidationStage;
  toolName?: string;
}

export interface AgentApiErrorResponse {
  requestId: string;
  error: Pick<AgentRuntimeError, 'code' | 'message'> & { validationStage?: AgentValidationStage; toolName?: string };
}

export class AgentServiceError extends Error {
  override readonly name = 'AgentServiceError';
  constructor(
    message: string,
    readonly requestId: string,
    readonly details: AgentRuntimeError,
  ) { super(message); }
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

export const AGENT_CONTRACT_VERSION = 2;

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
