import { describe, expect, it } from 'vitest';
import { createApprovalActionLabel, createApprovalArgumentRows, createApprovalSnapshot } from './index';

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

  it('formats nested arguments completely without raw JSON syntax', () => {
    const rows = createApprovalArgumentRows({ recipient: { accountId: 'reviewed-user' }, items: ['one', 'two'], urgent: true });
    expect(rows).toEqual([
      { label: 'Recipient › Account Id', value: 'reviewed-user' },
      { label: 'Items › Item 1', value: 'one' },
      { label: 'Items › Item 2', value: 'two' },
      { label: 'Urgent', value: 'Yes' },
    ]);
    const renderedValues = rows.map((row) => row.value).join(' ');
    expect(['{', '}', '[', ']', '"'].some((character) => renderedValues.includes(character))).toBe(false);
  });

  it('removes the raw tool identifier from an approval action label', () => {
    expect(createApprovalActionLabel('Add the best option (add_to_cart)', 'add_to_cart')).toBe('Add the best option');
    expect(createApprovalActionLabel('add_to_cart', 'add_to_cart')).toBe('Add to cart');
  });
});
