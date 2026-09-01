import Ajv from 'ajv';
import {
  AGENT_LIMITS,
  type AgentDecision,
  type AgentNextInput,
  type AgentPlan,
  type AgentRules,
  type ApprovalDecision,
  type Capability,
  type PlanStep,
  type RiskCategory,
  type WebMCPTool,
} from '@buddy/shared';

const patterns: Array<{ test: RegExp; id: string; label: string; description: string; risk: RiskCategory }> = [
  { test: /search|find|query|lookup/i, id: 'search', label: 'Search for things', description: 'Find relevant items or information on this site.', risk: 'READ' },
  { test: /filter|sort|refine/i, id: 'filter', label: 'Narrow down options', description: 'Filter and organize results around your preferences.', risk: 'READ' },
  { test: /compare/i, id: 'compare', label: 'Compare options', description: 'Put the strongest choices side by side.', risk: 'READ' },
  { test: /detail|get|read|view|list/i, id: 'read', label: 'Read useful information', description: 'Retrieve details available from this site.', risk: 'READ' },
  { test: /cart|basket|save|favorite/i, id: 'cart', label: 'Manage your cart', description: 'Add or remove temporary selections.', risk: 'LOW_RISK_WRITE' },
  { test: /checkout|purchase|pay|order|book|reserve/i, id: 'purchase', label: 'Help complete an order', description: 'Prepare or complete a consequential transaction with approval.', risk: 'FINANCIAL' },
  { test: /send|message|email|post|publish/i, id: 'communicate', label: 'Communicate for you', description: 'Send information to another person or audience.', risk: 'EXTERNAL_COMMUNICATION' },
  { test: /delete|remove|cancel|revoke/i, id: 'delete', label: 'Remove content', description: 'Remove or cancel something on this site.', risk: 'DESTRUCTIVE' },
  { test: /profile|identity|address|health|password|secret/i, id: 'sensitive', label: 'Work with private information', description: 'Use sensitive details only with your approval.', risk: 'SENSITIVE' },
];

export function classifyRisk(tool: WebMCPTool): RiskCategory {
  const text = `${tool.name} ${tool.title ?? ''} ${tool.description}`;
  const name = tool.name.toLowerCase();
  const temporaryCartAction = /cart|basket/i.test(text) && /add|remove|update|clear|save/i.test(text);
  if (/profile|identity|address|health|medical|password|secret|credential|passport|ssn|credit.?card|biometric/i.test(text)) return 'SENSITIVE';
  if (/delete|remove|cancel|revoke|erase|purge|terminate|disable|unsubscribe/i.test(text) && !temporaryCartAction) return 'DESTRUCTIVE';
  if (/checkout|purchase|pay|payment|order|book|reserve|transfer|withdraw|deposit|bid|donate|invoice|charge|subscribe|renew/i.test(text)) return 'FINANCIAL';
  if (/send|message|email|post|publish|share|invite|upload/i.test(text)) return 'EXTERNAL_COMMUNICATION';
  // Only the stable tool name can establish an automatic read. Page-authored
  // titles, descriptions, and readOnlyHint annotations remain advisory.
  if (/search|find|query|lookup|filter|sort|refine|compare|detail|get|read|view|list|weather|condition|status|availability|catalog|info|metadata|preview|estimate|calculate/i.test(name)) return 'READ';
  return 'LOW_RISK_WRITE';
}

export class CapabilityMapper {
  map(tools: WebMCPTool[]): Capability[] {
    const grouped = new Map<string, Capability>();
    for (const tool of tools) {
      const text = `${tool.name} ${tool.title ?? ''} ${tool.description}`;
      const match = patterns.find((entry) => entry.test.test(text)) ?? { id: 'other', label: 'Help with this site', description: 'Use a capability this site has made available.', risk: classifyRisk(tool) };
      const current = grouped.get(match.id);
      if (current) current.toolNames.push(tool.name);
      else grouped.set(match.id, { id: match.id, label: match.label, description: match.description, risk: classifyRisk(tool), toolNames: [tool.name] });
    }
    return [...grouped.values()];
  }
}

export class PermissionEngine {
  evaluate(step: Pick<PlanStep, 'risk' | 'toolName' | 'args'>, rules: AgentRules): ApprovalDecision {
    const name = step.toolName.toLowerCase();
    if (/delete|cancel|revoke/.test(name) && rules.blockDelete) return 'BLOCK';
    if (/purchase|pay|checkout|order|book|reserve|transfer|withdraw|deposit|bid|donate|invoice|charge|subscribe|renew/.test(name) && rules.askBeforePurchase) return 'ASK';
    if (/send|message|email|post|publish|share|invite|upload/.test(name) && rules.askBeforeMessages) return 'ASK';
    if (/profile|identity|address|health|medical|password|secret|credential|passport|ssn|credit.?card|biometric/.test(name) && rules.askBeforeSensitive) return 'ASK';
    if (step.risk === 'DESTRUCTIVE' && rules.blockDelete) return 'BLOCK';
    if (step.risk === 'FINANCIAL' && rules.askBeforePurchase) return 'ASK';
    if (step.risk === 'EXTERNAL_COMMUNICATION' && rules.askBeforeMessages) return 'ASK';
    if (step.risk === 'SENSITIVE' && rules.askBeforeSensitive) return 'ASK';
    if (containsSensitiveArgument(step.args) && rules.askBeforeSensitive) return 'ASK';
    if (/add.*cart|cart.*add/.test(name) && rules.askBeforePurchase) return 'ASK';
    if (/submit|checkout|reserve|book/.test(name) && rules.askBeforeSubmit) return 'ASK';
    if (step.risk === 'LOW_RISK_WRITE' && !(/fill|populate/.test(name) && rules.allowFormFill)) return 'ASK';
    if (step.risk === 'READ') {
      if (/compare/.test(name)) return rules.allowCompare ? 'ALLOW' : 'ASK';
      if (/search|find|query|lookup|filter|sort|refine/.test(name)) return rules.allowSearch ? 'ALLOW' : 'ASK';
      if (/detail|get|read|view|list|weather|condition|status|availability|catalog|info|metadata|preview|estimate|calculate/.test(name)) return rules.allowRead ? 'ALLOW' : 'ASK';
      return 'ASK';
    }
    return 'ALLOW';
  }
}

function containsSensitiveArgument(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > 512) return true;
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) { pending.push(...current); continue; }
    for (const [key, nested] of Object.entries(current)) {
      if (/password|secret|token|health|medical|identity|address|passport|ssn|credit.?card|credential|biometric/i.test(key)) return true;
      pending.push(nested);
    }
  }
  return false;
}

const MAX_PLAN_STEPS = 12;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

function boundedJsonLength(value: unknown, limit: number): boolean {
  try { return JSON.stringify(value).length <= limit; } catch { return false; }
}

export function validateToolArguments(tool: WebMCPTool, args: unknown): asserts args is Record<string, unknown> {
  if (!isRecord(args)) throw new Error(`The ${tool.name} action received invalid arguments.`);
  if (!boundedJsonLength(args, AGENT_LIMITS.maxPayloadBytes)) throw new Error(`The ${tool.name} action arguments are too large.`);
  if (!tool.inputSchema) return;
  if (!boundedJsonLength(tool.inputSchema, AGENT_LIMITS.maxSchemaBytes)) throw new Error(`The ${tool.name} action schema is too large to validate safely.`);
  try {
    const validate = ajv.compile(tool.inputSchema);
    if (!validate(args)) {
      const detail = (validate.errors ?? []).slice(0, 3).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
      throw new Error(`The ${tool.name} action arguments do not match the site's schema${detail ? `: ${detail}` : '.'}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`The ${tool.name} action arguments`)) throw error;
    throw new Error(`The ${tool.name} action has an invalid schema, so Buddy stopped safely.`);
  }
}

export function normalizeAgentDecision(value: unknown, tools: WebMCPTool[]): AgentDecision {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('The agent returned an invalid next action.');
  if (value.kind === 'final' || value.kind === 'needs_input') {
    if (typeof value.message !== 'string' || !value.message.trim()) throw new Error('The agent returned an empty message.');
    return { kind: value.kind, message: value.message.trim().slice(0, 2_000) };
  }
  if (value.kind !== 'tool_call' || typeof value.toolName !== 'string' || !isRecord(value.args)) {
    throw new Error('The agent returned an invalid tool call.');
  }
  const tool = tools.find((candidate) => candidate.name === value.toolName);
  if (!tool) throw new Error(`The ${value.toolName} action is not available on this site.`);
  validateToolArguments(tool, value.args);
  return {
    kind: 'tool_call',
    callId: crypto.randomUUID(),
    toolName: tool.name,
    args: value.args,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 240) : tool.title ?? tool.name,
    reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim().slice(0, 500) : 'This action is needed to continue your request.',
    risk: classifyRisk(tool),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function toolCallFingerprint(call: Pick<Extract<AgentDecision, { kind: 'tool_call' }>, 'toolName' | 'args'>): string {
  return `${call.toolName}:${JSON.stringify(stableValue(call.args))}`;
}

export class RepeatedToolCallGuard {
  private readonly fingerprints = new Set<string>();
  assertNew(call: Pick<Extract<AgentDecision, { kind: 'tool_call' }>, 'toolName' | 'args'>): void {
    const fingerprint = toolCallFingerprint(call);
    if (this.fingerprints.has(fingerprint)) throw new Error('Buddy stopped because the agent repeated the same action.');
    this.fingerprints.add(fingerprint);
  }
}

export function normalizePlan(value: unknown, tools: WebMCPTool[]): AgentPlan {
  if (!isRecord(value) || typeof value.summary !== 'string' || !Array.isArray(value.steps) || !Array.isArray(value.missingCapabilities)) {
    throw new Error('The planning service returned an invalid plan.');
  }
  if (value.steps.length > MAX_PLAN_STEPS) throw new Error('The planning service returned too many steps.');
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const steps = value.steps.map((candidate, index): PlanStep => {
    if (!isRecord(candidate) || typeof candidate.toolName !== 'string' || !isRecord(candidate.args)) {
      throw new Error(`Plan step ${index + 1} is invalid.`);
    }
    const tool = available.get(candidate.toolName);
    if (!tool) throw new Error(`The ${candidate.toolName} action is not available.`);
    return {
      id: typeof candidate.id === 'string' && candidate.id.length <= 128 ? candidate.id : crypto.randomUUID(),
      toolName: tool.name,
      args: candidate.args,
      label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.slice(0, 240) : tool.title ?? tool.name,
      risk: classifyRisk(tool),
    };
  });
  return {
    summary: value.summary.slice(0, 1000),
    steps,
    missingCapabilities: value.missingCapabilities.filter((item): item is string => typeof item === 'string').slice(0, 32),
  };
}

export interface AgentProvider {
  next(input: AgentNextInput, signal?: AbortSignal): Promise<AgentDecision>;
  summarizeCapabilities(capabilities: Capability[]): Promise<string>;
  interpretToolResult(step: PlanStep, result: unknown): Promise<string>;
}

function findTool(tools: WebMCPTool[], patternsToTry: RegExp[]): WebMCPTool | undefined {
  return patternsToTry.map((pattern) => tools.find((tool) => pattern.test(`${tool.name} ${tool.description}`))).find(Boolean);
}

function makeStep(tool: WebMCPTool, args: Record<string, unknown>, label: string): PlanStep {
  return { id: crypto.randomUUID(), toolName: tool.name, args, label, risk: classifyRisk(tool) };
}

export class MockAgentProvider implements AgentProvider {
  async next(input: AgentNextInput): Promise<AgentDecision> {
    const plan = await this.interpretGoal(input.goal, input.tools);
    const last = input.observations.at(-1);
    if (last?.outcome === 'error' || last?.outcome === 'canceled') {
      return { kind: 'final', message: 'I stopped safely after the last action did not complete.' };
    }
    const step = plan.steps[input.observations.length];
    if (!step) return { kind: 'final', message: plan.steps.length ? 'Done. I completed the available steps.' : plan.summary };
    return { kind: 'tool_call', callId: step.id, toolName: step.toolName, args: step.args, label: step.label, reason: 'This is the next available site action needed for your goal.', risk: step.risk };
  }

  async interpretGoal(goal: string, tools: WebMCPTool[]): Promise<AgentPlan> {
    const text = goal.toLowerCase();
    const budget = Number(text.match(/(?:under|below|less than|أقل من|menos de)\s*\$?\s*(\d+)/i)?.[1] ?? NaN);
    const search = findTool(tools, [/search/i, /find/i]);
    const filter = findTool(tools, [/filter/i, /refine/i]);
    const compare = findTool(tools, [/compare/i]);
    const add = findTool(tools, [/add.*cart/i, /cart.*add/i]);
    const steps: PlanStep[] = [];
    const missing: string[] = [];
    const query = /headphone|سماعات|auricular/i.test(text) ? 'headphones' : /gift|هدية|regalo/i.test(text) ? 'gift' : goal.slice(0, 80);
    if (search) steps.push(makeStep(search, { query }, `Search for ${query}`)); else missing.push('search');
    if (filter && (Number.isFinite(budget) || /arriv|deliver|الخميس|jueves|thursday/i.test(text))) {
      steps.push(makeStep(filter, { ...(Number.isFinite(budget) ? { maxPrice: budget } : {}), ...(/thursday|الخميس|jueves/i.test(text) ? { deliveryBy: 'Thursday' } : {}), minRating: 4 }, 'Apply your budget, rating, and delivery preferences'));
    }
    if (compare && /compare|best|top|قارن|أفضل|compara|mejor/i.test(text)) steps.push(makeStep(compare, { limit: 3 }, 'Compare the best options'));
    if (add && /add|cart|buy|purchase|أضف|اشتر|carrito|compra|don't buy|do not buy/i.test(text)) steps.push(makeStep(add, { selection: 'best' }, 'Add the best option to your cart'));
    return { summary: steps.length ? 'I made a short plan using only actions this site provides.' : 'This site does not provide the actions needed for that goal.', steps, missingCapabilities: missing };
  }

  async summarizeCapabilities(capabilities: Capability[]): Promise<string> {
    return capabilities.length ? `I can ${capabilities.map((item) => item.label.toLowerCase()).join(', ')}.` : "This site doesn't expose any actions yet.";
  }

  async interpretToolResult(step: PlanStep, result: unknown): Promise<string> {
    if (typeof result === 'object' && result && 'message' in result && typeof result.message === 'string') return result.message;
    return `${step.label} completed.`;
  }
}

export class RemoteAgentProvider implements AgentProvider {
  constructor(private readonly endpoint: string) {}
  async next(input: AgentNextInput, signal?: AbortSignal): Promise<AgentDecision> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/agent/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'The agent service is busy. Try again shortly.' : 'The agent service is unavailable.');
    return normalizeAgentDecision(await response.json(), input.tools);
  }
  async interpretGoal(goal: string, tools: WebMCPTool[]): Promise<AgentPlan> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'The planning service is busy. Try again shortly.' : 'The planning service is unavailable.');
    return normalizePlan(await response.json(), tools);
  }
  async summarizeCapabilities(capabilities: Capability[]): Promise<string> { return new MockAgentProvider().summarizeCapabilities(capabilities); }
  async interpretToolResult(step: PlanStep, result: unknown): Promise<string> { return new MockAgentProvider().interpretToolResult(step, result); }
}
