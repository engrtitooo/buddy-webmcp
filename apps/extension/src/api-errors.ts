import type { AgentErrorCode, AgentRuntimeError, AgentValidationStage } from '@buddy/shared';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorCodes = new Set<AgentErrorCode>(['INVALID_REQUEST_BODY', 'INVALID_SESSION', 'INVALID_TURN', 'INVALID_GOAL', 'INVALID_TOOL_INVENTORY', 'INVALID_TOOL_DEFINITION', 'INVALID_TOOL_SCHEMA', 'INVALID_TOOL_ORIGIN', 'INVALID_OBSERVATIONS', 'PAYLOAD_TOO_LARGE', 'UNAUTHORIZED', 'ORIGIN_NOT_ALLOWED', 'RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT', 'PROVIDER_ERROR']);
const validationStages = new Set<AgentValidationStage>(['request_body', 'session', 'turn', 'goal', 'tool_inventory', 'tool_definition', 'tool_schema', 'tool_origin', 'observations', 'provider']);

function defaultErrorCode(status: number): AgentErrorCode {
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  return 'INVALID_REQUEST_BODY';
}

function friendlyErrorMessage(status: number): string {
  if (status === 429) return 'Buddy is busy. Please wait a moment and try again.';
  if (status >= 500) return "Buddy's AI service is temporarily unavailable.";
  return 'Buddy could not safely understand that request.';
}

export function normalizeAgentApiFailure(status: number, body: unknown): AgentRuntimeError {
  const apiError = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const code = typeof apiError?.code === 'string' && errorCodes.has(apiError.code as AgentErrorCode) ? apiError.code as AgentErrorCode : defaultErrorCode(status);
  const validationStage = typeof apiError?.validationStage === 'string' && validationStages.has(apiError.validationStage as AgentValidationStage) ? apiError.validationStage as AgentValidationStage : undefined;
  const toolName = typeof apiError?.toolName === 'string' && apiError.toolName.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(apiError.toolName) ? apiError.toolName : undefined;
  return { code, message: friendlyErrorMessage(status), retryable: status === 429 || status >= 500, status, ...(validationStage ? { validationStage } : {}), ...(toolName ? { toolName } : {}) };
}
