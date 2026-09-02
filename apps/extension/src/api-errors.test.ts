import { describe, expect, it } from 'vitest';
import { normalizeAgentApiFailure } from './api-errors';

describe('normalizeAgentApiFailure', () => {
  it('carries safe API diagnostics to Developer Mode while replacing server text with a friendly message', () => {
    expect(normalizeAgentApiFailure(400, { error: { code: 'INVALID_TOOL_SCHEMA', message: 'sensitive server detail', validationStage: 'tool_schema', toolName: 'search_posts' } })).toEqual({
      code: 'INVALID_TOOL_SCHEMA',
      message: 'Buddy could not safely understand that request.',
      retryable: false,
      status: 400,
      validationStage: 'tool_schema',
      toolName: 'search_posts',
    });
  });

  it('drops unrecognized or unsafe diagnostics', () => {
    expect(normalizeAgentApiFailure(400, { error: { code: 'SECRET_CODE', validationStage: 'internal_secret', toolName: '<script>' } })).toEqual({
      code: 'INVALID_REQUEST_BODY',
      message: 'Buddy could not safely understand that request.',
      retryable: false,
      status: 400,
    });
  });
});
