import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type WebMCPTool } from '@buddy/shared';
import { CapabilityMapper, MockAgentProvider, PermissionEngine, classifyRisk, normalizePlan } from './index';
const tool = (name: string, description = name, readOnlyHint = false): WebMCPTool => ({ name, description, origin: 'https://example.com', annotations: { readOnlyHint } });

describe('CapabilityMapper', () => {
  it('groups technical tools into human capabilities', () => {
    const mapped = new CapabilityMapper().map([tool('search_items', '', true), tool('filter_items', '', true), tool('add_to_cart')]);
    expect(mapped.map((x) => x.label)).toContain('Search for things'); expect(mapped.map((x) => x.label)).toContain('Manage your cart');
  });
});
describe('PermissionEngine', () => {
  it('asks before money and blocks deletion', () => {
    const engine = new PermissionEngine();
    expect(engine.evaluate({ toolName: 'checkout', args: {}, risk: 'FINANCIAL' }, DEFAULT_RULES)).toBe('ASK');
    expect(engine.evaluate({ toolName: 'add_to_cart', args: {}, risk: 'LOW_RISK_WRITE' }, DEFAULT_RULES)).toBe('ASK');
    expect(engine.evaluate({ toolName: 'delete_account', args: {}, risk: 'DESTRUCTIVE' }, DEFAULT_RULES)).toBe('BLOCK');
    expect(classifyRisk(tool('search_items', '', true))).toBe('READ');
    expect(classifyRisk(tool('delete_account', '', true))).toBe('DESTRUCTIVE');
    expect(classifyRisk(tool('send_message', '', true))).toBe('EXTERNAL_COMMUNICATION');
    expect(engine.evaluate({ toolName: 'delete_account', args: {}, risk: 'READ' }, DEFAULT_RULES)).toBe('BLOCK');
  });
});
describe('normalizePlan', () => {
  it('recomputes provider risk from the current tool definition', () => {
    const normalized = normalizePlan({ summary: 'Plan', missingCapabilities: [], steps: [{ id: '1', toolName: 'delete_account', args: {}, label: 'Read account', risk: 'READ' }] }, [tool('delete_account', '', true)]);
    expect(normalized.steps[0]?.risk).toBe('DESTRUCTIVE');
  });
  it('rejects unavailable tools', () => {
    expect(() => normalizePlan({ summary: 'Plan', missingCapabilities: [], steps: [{ id: '1', toolName: 'unknown', args: {}, label: 'Unknown', risk: 'READ' }] }, [])).toThrow(/not available/);
  });
});
describe('MockAgentProvider', () => {
  it('creates a deterministic goal plan from available tools', async () => {
    const plan = await new MockAgentProvider().interpretGoal('Find a gift under $50, compare the best, but do not buy', [tool('search_items', '', true), tool('filter_items', '', true), tool('compare_items', '', true), tool('add_to_cart')]);
    expect(plan.steps.map((x) => x.toolName)).toEqual(['search_items', 'filter_items', 'compare_items', 'add_to_cart']);
  });
});
