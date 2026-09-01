import { AGENT_LIMITS, type AgentNextInput, type WebMCPTool } from '@buddy/shared';
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

const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  signal: AbortSignal.timeout(30_000),
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify(createOpenAIRequestBody(input, model)),
});
if (!response.ok) {
  const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 1_000);
  throw new Error(`OpenAI rejected the Structured Output smoke request (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
}
const outputText = extractOpenAIOutputText(await response.json());
if (!outputText || outputText.length > AGENT_LIMITS.maxPayloadBytes) throw new Error('OpenAI returned no bounded Structured Output text.');
const decision = normalizeOpenAIModelDecision(JSON.parse(outputText) as unknown, input.tools);
console.log(`OpenAI Structured Outputs smoke test passed (${decision.kind}).`);
