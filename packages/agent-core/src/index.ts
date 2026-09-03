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
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 2_048;
const MAX_PATTERN_LENGTH = 256;
const schemaKeywords = new Set([
  '$id', '$schema', '$comment', '$defs', 'definitions', '$ref',
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'nullable', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'enum', 'const', 'anyOf', 'oneOf', 'allOf',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format',
]);
const jsonTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const safeFormats = new Set(['date', 'date-time', 'time', 'email', 'hostname', 'ipv4', 'ipv6', 'uri', 'url', 'uuid']);

export class ToolSchemaCompatibilityError extends Error {
  override readonly name = 'ToolSchemaCompatibilityError';
}

export class ToolArgumentValidationError extends Error {
  override readonly name = 'ToolArgumentValidationError';
  constructor(readonly toolName: string, readonly validationErrors: string[]) {
    super(`The ${toolName} action arguments do not match the site's schema: ${validationErrors.slice(0, 4).join('; ')}`);
  }
}

function boundedJsonLength(value: unknown, limit: number): boolean {
  try { return JSON.stringify(value).length <= limit; } catch { return false; }
}

function schemaError(toolName: string): never {
  throw new ToolSchemaCompatibilityError(`The ${toolName} action has an incompatible schema, so Buddy made only that action unavailable.`);
}

function resolveLocalRef(root: Record<string, unknown>, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!isRecord(current) || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return current;
}

function validateSchemaShape(schema: unknown, root: Record<string, unknown>, toolName: string, depth: number, state: { nodes: number }): void {
  if (typeof schema === 'boolean') return;
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH || ++state.nodes > MAX_SCHEMA_NODES) schemaError(toolName);
  if (Object.keys(schema).some((key) => !schemaKeywords.has(key))) schemaError(toolName);
  if (schema.$ref !== undefined && (typeof schema.$ref !== 'string' || resolveLocalRef(root, schema.$ref) === undefined)) schemaError(toolName);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => typeof type !== 'string' || !jsonTypes.has(type))) schemaError(toolName);
  }
  if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') schemaError(toolName);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) schemaError(toolName);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) schemaError(toolName);
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') schemaError(toolName);
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'] as const) {
    const countKeyword = keyword.startsWith('min') || keyword.startsWith('max') ? !['minimum', 'maximum'].includes(keyword) : false;
    if (schema[keyword] !== undefined && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]) || (keyword === 'multipleOf' && schema[keyword] <= 0) || (countKeyword && (!Number.isInteger(schema[keyword]) || schema[keyword] < 0)))) schemaError(toolName);
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > MAX_PATTERN_LENGTH || /\\[1-9]|\(\?[<!=]|(?:\*|\+|\{\d+,?\d*\})(?:\s*\)|\s*)[+*{]|\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/.test(schema.pattern)) schemaError(toolName);
    try { new RegExp(schema.pattern, 'u'); } catch { schemaError(toolName); }
  }
  if (schema.format !== undefined && (typeof schema.format !== 'string' || !safeFormats.has(schema.format))) schemaError(toolName);
  for (const collection of ['$defs', 'definitions', 'properties'] as const) {
    if (schema[collection] === undefined) continue;
    if (!isRecord(schema[collection])) schemaError(toolName);
    for (const nested of Object.values(schema[collection])) validateSchemaShape(nested, root, toolName, depth + 1, state);
  }
  if (schema.additionalProperties !== undefined) validateSchemaShape(schema.additionalProperties, root, toolName, depth + 1, state);
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) schema.items.forEach((nested) => validateSchemaShape(nested, root, toolName, depth + 1, state));
    else validateSchemaShape(schema.items, root, toolName, depth + 1, state);
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || !schema[keyword].length) schemaError(toolName);
    schema[keyword].forEach((nested) => validateSchemaShape(nested, root, toolName, depth + 1, state));
  }
}

function exactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(exactJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, exactJsonValue(value[key])]));
}

function equalJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(exactJsonValue(left)) === JSON.stringify(exactJsonValue(right)); } catch { return false; }
}

function valueHasType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validFormat(value: string, format: string): boolean {
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'hostname') return value.length <= 253 && /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value);
  if (format === 'ipv4') return value.split('.').length === 4 && value.split('.').every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  if (format === 'uuid') return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (format === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][0-2]\d:[0-5]\d)$/.test(value);
  if (format === 'date-time') return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
  if (format === 'uri' || format === 'url') { try { const url = new URL(value); return format === 'uri' || ['http:', 'https:'].includes(url.protocol); } catch { return false; } }
  if (format === 'ipv6') return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
  return true;
}

function collectValidationErrors(schema: unknown, value: unknown, root: Record<string, unknown>, path: string, depth: number, refs: number): string[] {
  if (depth > MAX_SCHEMA_DEPTH || refs > MAX_SCHEMA_DEPTH) return [`${path} exceeds the supported nesting depth`];
  if (schema === true) return [];
  if (schema === false) return [`${path} is not allowed`];
  if (!isRecord(schema)) return [`${path} uses an incompatible schema`];
  const errors: string[] = [];
  if (typeof schema.$ref === 'string') {
    const target = resolveLocalRef(root, schema.$ref);
    errors.push(...collectValidationErrors(target, value, root, path, depth + 1, refs + 1));
  }
  const nullable = schema.nullable === true;
  const declaredTypes = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
  if (value === null && nullable) return errors;
  if (declaredTypes.length && !declaredTypes.some((type) => valueHasType(value, type))) errors.push(`${path} must be ${declaredTypes.join(' or ')}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => equalJson(candidate, value))) errors.push(`${path} must be one of the advertised values`);
  if (Object.hasOwn(schema, 'const') && !equalJson(schema.const, value)) errors.push(`${path} must equal the advertised constant`);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    const branches = schema[keyword].map((branch) => collectValidationErrors(branch, value, root, path, depth + 1, refs));
    if (keyword === 'allOf') branches.forEach((branch) => errors.push(...branch));
    else {
      const passing = branches.filter((branch) => branch.length === 0).length;
      if ((keyword === 'anyOf' && passing === 0) || (keyword === 'oneOf' && passing !== 1)) errors.push(`${path} must match ${keyword === 'oneOf' ? 'exactly one' : 'at least one'} advertised shape`);
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && (value.length > 2_048 || !new RegExp(schema.pattern, 'u').test(value))) errors.push(`${path} does not match the required pattern`);
    if (typeof schema.format === 'string' && !validFormat(value, schema.format)) errors.push(`${path} must be a valid ${schema.format}`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${path} must be greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(`${path} must be less than ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === 'number' && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10) errors.push(`${path} must be a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(exactJsonValue(item)))).size !== value.length) errors.push(`${path} items must be unique`);
    const itemSchema = schema.items;
    if (Array.isArray(itemSchema)) value.forEach((item, index) => { if (itemSchema[index] !== undefined) errors.push(...collectValidationErrors(itemSchema[index], item, root, `${path}/${index}`, depth + 1, refs)); });
    else if (itemSchema !== undefined) value.forEach((item, index) => errors.push(...collectValidationErrors(itemSchema, item, root, `${path}/${index}`, depth + 1, refs)));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === 'string' && !Object.hasOwn(value, key)) errors.push(`${path}/${key} is required`);
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) errors.push(`${path} needs at least ${schema.minProperties} properties`);
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) errors.push(`${path} allows at most ${schema.maxProperties} properties`);
    for (const [key, nested] of Object.entries(value)) {
      const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (Object.hasOwn(properties, key)) errors.push(...collectValidationErrors(properties[key], nested, root, childPath, depth + 1, refs));
      else if (schema.additionalProperties === false) errors.push(`${childPath} is not an advertised property`);
      else if (isRecord(schema.additionalProperties) || typeof schema.additionalProperties === 'boolean') errors.push(...collectValidationErrors(schema.additionalProperties, nested, root, childPath, depth + 1, refs));
    }
  }
  return errors.slice(0, 12);
}

export function validateToolSchema(tool: Pick<WebMCPTool, 'name' | 'inputSchema'>): void {
  if (!tool.inputSchema) return;
  if (!boundedJsonLength(tool.inputSchema, AGENT_LIMITS.maxSchemaBytes)) throw new Error(`The ${tool.name} action schema is too large to validate safely.`);
  try { validateSchemaShape(tool.inputSchema, tool.inputSchema, tool.name, 0, { nodes: 0 }); }
  catch (error) {
    if (error instanceof ToolSchemaCompatibilityError) throw error;
    throw new ToolSchemaCompatibilityError(`The ${tool.name} action has an incompatible schema, so Buddy made only that action unavailable.`);
  }
}

export function validateToolArguments(tool: WebMCPTool, args: unknown): asserts args is Record<string, unknown> {
  if (!isRecord(args)) throw new Error(`The ${tool.name} action received invalid arguments.`);
  if (!boundedJsonLength(args, AGENT_LIMITS.maxPayloadBytes)) throw new Error(`The ${tool.name} action arguments are too large.`);
  if (!tool.inputSchema) return;
  validateToolSchema(tool);
  const errors = collectValidationErrors(tool.inputSchema, args, tool.inputSchema, '', 0, 0);
  if (errors.length) throw new ToolArgumentValidationError(tool.name, errors);
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

export function normalizeAgentDecisionOrRejection(value: unknown, tools: WebMCPTool[]): AgentDecision {
  if (isRecord(value) && value.kind === 'rejected_tool_call') {
    if (typeof value.toolName !== 'string' || !value.toolName.trim() || value.toolName.length > 128 || !isRecord(value.args) || !boundedJsonLength(value.args, AGENT_LIMITS.maxPayloadBytes) || typeof value.message !== 'string' || !value.message.trim()) {
      throw new Error('The agent returned an invalid rejected action.');
    }
    return { kind: 'rejected_tool_call', callId: crypto.randomUUID(), toolName: value.toolName, args: value.args, message: value.message.trim().slice(0, 1_000) };
  }
  try {
    return normalizeAgentDecision(value, tools);
  } catch (error) {
    if (!isRecord(value) || value.kind !== 'tool_call') throw error;
    const toolName = typeof value.toolName === 'string' && value.toolName.trim() && value.toolName.length <= 128 ? value.toolName : 'invalid_tool';
    const args = isRecord(value.args) && boundedJsonLength(value.args, AGENT_LIMITS.maxPayloadBytes)
      ? JSON.parse(JSON.stringify(value.args)) as Record<string, unknown>
      : {};
    return {
      kind: 'rejected_tool_call',
      callId: crypto.randomUUID(),
      toolName,
      args,
      message: (error instanceof Error ? error.message : 'The proposed tool call was invalid.').slice(0, 1_000),
    };
  }
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function toolCallFingerprint(call: Pick<Extract<AgentDecision, { kind: 'tool_call' }>, 'toolName' | 'args'>): string {
  return `${call.toolName}:${JSON.stringify(stableValue(call.args))}`;
}

export class RepeatedToolCallGuard {
  private readonly fingerprints = new Set<string>();
  private readonly successfulResults = new Map<string, Set<string>>();
  assertNew(call: Pick<Extract<AgentDecision, { kind: 'tool_call' }>, 'toolName' | 'args'>): void {
    const fingerprint = toolCallFingerprint(call);
    if (this.fingerprints.has(fingerprint)) throw new Error('Buddy stopped because the agent repeated the same action.');
    this.fingerprints.add(fingerprint);
  }
  recordSuccess(call: Pick<Extract<AgentDecision, { kind: 'tool_call' }>, 'toolName' | 'args'>, result: unknown): boolean {
    const fingerprint = JSON.stringify(stableValue(result));
    const prior = this.successfulResults.get(call.toolName) ?? new Set<string>();
    const repeated = prior.has(fingerprint);
    prior.add(fingerprint); this.successfulResults.set(call.toolName, prior);
    return repeated;
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
  next(input: AgentNextInput, signal?: AbortSignal): Promise<unknown>;
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
  async next(input: AgentNextInput, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/agent/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'The agent service is busy. Try again shortly.' : 'The agent service is unavailable.');
    return response.json();
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
