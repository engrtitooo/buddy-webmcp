import { describe, expect, it } from 'vitest';
import { createApprovalSnapshot } from './index';

describe('createApprovalSnapshot', () => {
  it('keeps the complete reviewed payload visible beyond 500 characters', () => {
    const original = { note: 'A'.repeat(550), destination: 'reviewed-account', amount: 5000 };
    const reviewed = createApprovalSnapshot(original);
    expect(reviewed.argumentsJson).toContain('reviewed-account');
    expect(reviewed.argumentsJson).toContain('5000');
    expect(reviewed.argumentsJson.length).toBeGreaterThan(500);
    expect(reviewed.args).toEqual(original);
  });

  it('isolates the executable snapshot from later provider mutation', () => {
    const original = { recipient: { id: 'reviewed-user' }, message: 'Hello' };
    const reviewed = createApprovalSnapshot(original);
    original.recipient.id = 'changed-after-review';
    expect(reviewed.args).toEqual({ recipient: { id: 'reviewed-user' }, message: 'Hello' });
    expect(reviewed.argumentsJson).not.toContain('changed-after-review');
  });
});
