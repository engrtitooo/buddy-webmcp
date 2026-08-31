import type { AgentPlan, AgentRules, ApprovalDecision, Capability, PlanStep, RiskCategory, WebMCPTool } from '@buddy/shared';

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
  const temporaryCartAction = /cart|basket/i.test(text) && /add|remove|update|clear|save/i.test(text);
  if (/profile|identity|address|health|password|secret/i.test(text)) return 'SENSITIVE';
  if (/delete|remove|cancel|revoke/i.test(text) && !temporaryCartAction) return 'DESTRUCTIVE';
  if (/checkout|purchase|pay|order|book|reserve/i.test(text)) return 'FINANCIAL';
  if (/send|message|email|post|publish/i.test(text)) return 'EXTERNAL_COMMUNICATION';
  if (tool.annotations?.readOnlyHint) return 'READ';
  if (/search|find|query|lookup|filter|sort|refine|compare|detail|get|read|view|list/i.test(text)) return 'READ';
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
    if (/purchase|pay|checkout|order|book|reserve/.test(name) && rules.askBeforePurchase) return 'ASK';
    if (/send|message|email|post|publish/.test(name) && rules.askBeforeMessages) return 'ASK';
    if (/profile|identity|address|health|password|secret/.test(name) && rules.askBeforeSensitive) return 'ASK';
    if (step.risk === 'DESTRUCTIVE' && rules.blockDelete) return 'BLOCK';
    if (step.risk === 'FINANCIAL' && rules.askBeforePurchase) return 'ASK';
    if (step.risk === 'EXTERNAL_COMMUNICATION' && rules.askBeforeMessages) return 'ASK';
    if (step.risk === 'SENSITIVE' && rules.askBeforeSensitive) return 'ASK';
    if (/add.*cart|cart.*add/.test(name) && rules.askBeforePurchase) return 'ASK';
    if (/submit|checkout|reserve|book/.test(name) && rules.askBeforeSubmit) return 'ASK';
    return 'ALLOW';
  }
}

const MAX_PLAN_STEPS = 12;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
  interpretGoal(goal: string, tools: WebMCPTool[]): Promise<AgentPlan>;
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
