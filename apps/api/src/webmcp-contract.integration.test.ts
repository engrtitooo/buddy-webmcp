// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { WebMCPAdapter, type BrowserModelContext, type BrowserRegisteredTool } from '@buddy/webmcp-bridge';
import { parseAgentNextInput } from './server';

const cloverbaseSchemas = {
  get_site_info: { type: 'object', properties: {}, additionalProperties: false },
  list_posts: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
    additionalProperties: false,
  },
  search_posts: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false,
  },
  subscribe_newsletter: {
    type: 'object',
    properties: { email: { type: 'string', format: 'email' } },
    required: ['email'],
    additionalProperties: false,
  },
} as const;

function chromeTool(
  name: keyof typeof cloverbaseSchemas,
  description: string,
  options: { title?: string; annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean } } = {},
): BrowserRegisteredTool {
  return {
    name,
    description,
    inputSchema: JSON.stringify(cloverbaseSchemas[name]),
    origin: 'https://cloverbase.com',
    window,
    ...options,
  };
}

describe('Chrome RegisteredTool to Buddy API contract', () => {
  it('accepts the exact serialized inventory produced for four Cloverbase-style tools', async () => {
    const registered = [
      chromeTool('get_site_info', 'Get information about this site', { annotations: { readOnlyHint: true } }),
      chromeTool('list_posts', 'List recent posts', { title: 'List posts' }),
      chromeTool('search_posts', 'Search posts by query', { title: 'Search posts', annotations: { readOnlyHint: true } }),
      chromeTool('subscribe_newsletter', 'Subscribe an email address to the newsletter'),
    ];
    const context = new EventTarget() as BrowserModelContext;
    context.getTools = vi.fn().mockResolvedValue(registered);
    context.executeTool = vi.fn();
    context.registerTool = vi.fn();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: context });

    const tools = await new WebMCPAdapter().getTools();
    const parsed = parseAgentNextInput({
      sessionId: 'a4c5c546-cd3a-4a2e-b30e-d8b255f94b7a',
      turn: 0,
      goal: 'Show what you can do',
      observations: [],
      tools,
    });

    expect(parsed.tools.map((tool) => tool.name)).toEqual([
      'get_site_info',
      'list_posts',
      'search_posts',
      'subscribe_newsletter',
    ]);
    expect(parsed.tools[0]?.inputSchema).toEqual(cloverbaseSchemas.get_site_info);
    expect(parsed.tools[2]?.inputSchema).toEqual(cloverbaseSchemas.search_posts);
    expect(parsed.observations).toEqual([]);
    expect(JSON.stringify(tools)).not.toContain('window');
  });
});
