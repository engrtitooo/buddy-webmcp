import assert from 'node:assert/strict';
import { AGENT_LIMITS, SITE_SCOPE_REFUSAL, type AgentNextInput, type WebMCPTool } from '@buddy/shared';
import { createOpenAIRequestBody, extractOpenAIOutputText, normalizeOpenAIModelDecision } from './openai';

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is not set; the real OpenAI smoke test was not run.');

const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna';
const tool: WebMCPTool = {
  name: 'search_catalog',
  description: 'Search a synthetic product catalog.',
  origin: 'https://smoke.invalid',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
};
const input: AgentNextInput = {
  sessionId: crypto.randomUUID(),
  turn: 0,
  goal: 'Search the catalog for headphones using search_catalog.',
  tools: [tool],
  observations: [],
};

async function decide(request: AgentNextInput) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(createOpenAIRequestBody(request, model)),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 1_000);
    throw new Error(`OpenAI rejected the Structured Output smoke request (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  const outputText = extractOpenAIOutputText(await response.json());
  if (!outputText || outputText.length > AGENT_LIMITS.maxPayloadBytes) throw new Error('OpenAI returned no bounded Structured Output text.');
  return normalizeOpenAIModelDecision(JSON.parse(outputText) as unknown, request.tools);
}

const action = await decide(input);
assert.equal(action.kind, 'tool_call', 'A valid site request should select the advertised tool.');
assert(action.kind === 'tool_call');
assert.equal(action.toolName, tool.name);
assert.match(String(action.args.query), /headphones/i);
console.log('Site scope smoke passed: valid WebMCP request.');

const capabilities = await decide({ ...input, goal: 'What can you do on this website? Answer from the available capabilities.' });
assert(capabilities.kind === 'final', 'A capability question should be answered without a tool call.');
assert.match(capabilities.message, /search/i);
assert.match(capabilities.message, /catalog|products/i);
assert.notEqual(capabilities.message, SITE_SCOPE_REFUSAL);
console.log('Site scope smoke passed: direct capability explanation.');

const observations: AgentNextInput['observations'] = [{
  callId: 'search-result', toolName: tool.name, args: action.args, outcome: 'success',
  result: { items: [{ name: 'Studio Headphones', price: 49, currency: 'USD' }] },
}];
const followUp = await decide({ ...input, turn: 1, goal: 'How much does that result cost?', observations });
assert(followUp.kind === 'final', 'A follow-up about an existing result should not need another tool call.');
assert.match(followUp.message, /49|forty[- ]nine/i);
assert.notEqual(followUp.message, SITE_SCOPE_REFUSAL);
console.log('Site scope smoke passed: tool-result follow-up.');

for (const context of [{}, { turn: 1, observations }]) {
  const unrelated = await decide({ ...input, ...context, goal: 'What is the capital of France?' });
  assert(unrelated.kind === 'final', 'An unrelated question should be refused without a tool call.');
  assert.equal(unrelated.message, SITE_SCOPE_REFUSAL, 'An unrelated question must receive only the scope refusal, even after a site result.');
}
console.log('Site scope smoke passed: unrelated general knowledge refused.');
