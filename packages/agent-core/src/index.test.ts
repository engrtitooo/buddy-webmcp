import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type WebMCPTool } from '@buddy/shared';
import { CapabilityMapper, MockAgentProvider, PermissionEngine, RepeatedToolCallGuard, classifyRisk, normalizeAgentDecision, normalizePlan, toolCallFingerprint, validateToolArguments } from './index';
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
  it('does not trust readOnlyHint for consequential actions', () => {
    expect(classifyRisk(tool('purchase_now', 'Only reads a receipt', true))).toBe('FINANCIAL');
    expect(classifyRisk(tool('publish_post', 'Harmless lookup', true))).toBe('EXTERNAL_COMMUNICATION');
    expect(classifyRisk(tool('revoke_access', 'Read settings', true))).toBe('DESTRUCTIVE');
    const opaqueWrite = tool('transfer_funds', 'Continue with the selected option', true);
    expect(classifyRisk(opaqueWrite)).toBe('FINANCIAL');
    expect(new PermissionEngine().evaluate({ toolName: opaqueWrite.name, args: {}, risk: classifyRisk(opaqueWrite) }, DEFAULT_RULES)).toBe('ASK');
    expect(classifyRisk(tool('perform_operation', 'Continue', true))).toBe('LOW_RISK_WRITE');
    expect(classifyRisk(tool('perform_operation', 'Lookup current data', true))).toBe('LOW_RISK_WRITE');
    expect(classifyRisk(tool('weather', 'Current conditions', true))).toBe('READ');
  });
  it('treats unknown tools as writes and sensitive argument names as approval-worthy', () => {
    const engine = new PermissionEngine();
    expect(classifyRisk(tool('frobnicate'))).toBe('LOW_RISK_WRITE');
    expect(engine.evaluate({ toolName: 'frobnicate', args: {}, risk: 'LOW_RISK_WRITE' }, DEFAULT_RULES)).toBe('ASK');
    expect(engine.evaluate({ toolName: 'update', args: { passportNumber: 'x' }, risk: 'LOW_RISK_WRITE' }, DEFAULT_RULES)).toBe('ASK');
    expect(engine.evaluate({ toolName: 'search_people', args: { filters: { passportNumber: 'x' } }, risk: 'READ' }, DEFAULT_RULES)).toBe('ASK');
  });
  it('honors automatic-read rule switches and refuses opaque READ claims', () => {
    const engine = new PermissionEngine();
    expect(engine.evaluate({ toolName: 'weather', args: {}, risk: 'READ' }, DEFAULT_RULES)).toBe('ALLOW');
    expect(engine.evaluate({ toolName: 'weather', args: {}, risk: 'READ' }, { ...DEFAULT_RULES, allowRead: false })).toBe('ASK');
    expect(engine.evaluate({ toolName: 'search_items', args: {}, risk: 'READ' }, { ...DEFAULT_RULES, allowSearch: false })).toBe('ASK');
    expect(engine.evaluate({ toolName: 'compare_items', args: {}, risk: 'READ' }, { ...DEFAULT_RULES, allowCompare: false })).toBe('ASK');
    expect(engine.evaluate({ toolName: 'perform_operation', args: {}, risk: 'READ' }, DEFAULT_RULES)).toBe('ASK');
  });
  it('honors explicit rule relaxation without weakening destructive blocking', () => {
    const engine = new PermissionEngine();
    const relaxed = { ...DEFAULT_RULES, askBeforeMessages: false, askBeforePurchase: false };
    expect(engine.evaluate({ toolName: 'send_message', args: {}, risk: 'EXTERNAL_COMMUNICATION' }, relaxed)).toBe('ALLOW');
    expect(engine.evaluate({ toolName: 'delete_account', args: {}, risk: 'DESTRUCTIVE' }, relaxed)).toBe('BLOCK');
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
  it('selects exactly one next action after each observation', async () => {
    const provider = new MockAgentProvider(); const tools = [tool('search_items', '', true), tool('compare_items', '', true)];
    const first = await provider.next({ sessionId: 's', turn: 0, goal: 'find and compare gifts', tools, observations: [] });
    expect(first.kind).toBe('tool_call');
    const second = await provider.next({ sessionId: 's', turn: 1, goal: 'find and compare gifts', tools, observations: [{ callId: '1', toolName: 'search_items', args: {}, outcome: 'success', result: {} }] });
    expect(second.kind === 'tool_call' && second.toolName).toBe('compare_items');
  });
  it('stops after an error observation', async () => {
    const decision = await new MockAgentProvider().next({ sessionId: 's', turn: 1, goal: 'find gifts', tools: [tool('search_items')], observations: [{ callId: '1', toolName: 'search_items', args: {}, outcome: 'error', error: 'failed' }] });
    expect(decision.kind).toBe('final');
  });
});

describe('tool argument validation', () => {
  const schemaTool: WebMCPTool = { name: 'search', description: 'Search', origin: 'https://example.com', inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] } };
  it('accepts arguments matching the advertised JSON Schema', () => {
    expect(() => validateToolArguments(schemaTool, { query: 'gift', limit: 3 })).not.toThrow();
  });
  it('rejects missing required fields', () => {
    expect(() => validateToolArguments(schemaTool, { limit: 3 })).toThrow(/schema/);
  });
  it('rejects additional fields when the site forbids them', () => {
    expect(() => validateToolArguments(schemaTool, { query: 'gift', hidden: true })).toThrow(/schema/);
  });
  it('stops safely on an invalid site schema', () => {
    expect(() => validateToolArguments({ ...schemaTool, inputSchema: { type: 'not-a-type' } }, {})).toThrow(/invalid schema/);
  });
});

describe('normalizeAgentDecision', () => {
  it('normalizes final and needs-input messages', () => {
    const final = normalizeAgentDecision({ kind: 'final', message: ' Done ' }, []);
    expect(final.kind === 'final' && final.message).toBe('Done');
    expect(normalizeAgentDecision({ kind: 'needs_input', message: 'Which item?' }, []).kind).toBe('needs_input');
  });
  it('rejects unavailable tool calls', () => {
    expect(() => normalizeAgentDecision({ kind: 'tool_call', callId: '1', toolName: 'missing', args: {}, label: 'Missing', reason: 'test' }, [])).toThrow(/not available/);
  });
  it('recomputes risk even when a provider lies', () => {
    const decision = normalizeAgentDecision({ kind: 'tool_call', callId: '1', toolName: 'pay_now', args: {}, label: 'Read', reason: 'test', risk: 'READ' }, [tool('pay_now', 'read only', true)]);
    expect(decision.kind === 'tool_call' && decision.risk).toBe('FINANCIAL');
  });
  it('validates arguments before returning a call', () => {
    const schemaTool: WebMCPTool = { name: 'search', description: 'Search', origin: 'https://example.com', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
    expect(() => normalizeAgentDecision({ kind: 'tool_call', toolName: 'search', args: {}, label: 'Search', reason: 'test' }, [schemaTool])).toThrow(/schema/);
  });
});

describe('RepeatedToolCallGuard', () => {
  it('uses stable argument ordering and rejects an identical repeat', () => {
    const guard = new RepeatedToolCallGuard(); guard.assertNew({ toolName: 'search', args: { b: 2, a: 1 } });
    expect(() => guard.assertNew({ toolName: 'search', args: { a: 1, b: 2 } })).toThrow(/repeated/);
  });
  it('allows distinct arguments and tools', () => {
    const guard = new RepeatedToolCallGuard(); guard.assertNew({ toolName: 'search', args: { q: 'a' } });
    expect(() => guard.assertNew({ toolName: 'search', args: { q: 'b' } })).not.toThrow();
    expect(toolCallFingerprint({ toolName: 'compare', args: {} })).not.toBe(toolCallFingerprint({ toolName: 'search', args: {} }));
  });
});
