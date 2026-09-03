import { normalizeWebMCPTool, type WebMCPTool } from '@buddy/shared';
import { validateToolSchema } from '@buddy/agent-core';

export interface BrowserWebMCPAnnotations { readOnlyHint?: boolean; untrustedContentHint?: boolean }
export interface BrowserRegisteredTool { name: string; title?: string; description: string; inputSchema?: Record<string, unknown> | string; window: Window; origin: string; annotations?: BrowserWebMCPAnnotations }
export interface BrowserToolDefinition { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; annotations?: BrowserWebMCPAnnotations; execute(input: Record<string, unknown>, options: { signal: AbortSignal }): unknown | Promise<unknown> }
export interface BrowserModelContext extends EventTarget {
  registerTool(tool: BrowserToolDefinition, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void>;
  getTools(options?: { fromOrigins?: string[] }): Promise<BrowserRegisteredTool[]>;
  executeTool(tool: BrowserRegisteredTool, input?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<string>;
}
declare global { interface Document { readonly modelContext?: BrowserModelContext } }

export type ToolChangeListener = (tools: WebMCPTool[]) => void;

/**
 * The single boundary from browser-owned RegisteredTool handles to Buddy's
 * canonical, JSON-only tool contract. Chrome builds have exposed inputSchema
 * both as a parsed object and as its serialized JSON form.
 */
export function normalizeRegisteredTool(tool: BrowserRegisteredTool, fallbackOrigin: string): WebMCPTool | undefined {
  let inputSchema: unknown = tool.inputSchema;
  if (typeof inputSchema === 'string') {
    try { inputSchema = JSON.parse(inputSchema) as unknown; } catch { return undefined; }
  }
  try {
    const normalized = normalizeWebMCPTool({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      origin: tool.origin || fallbackOrigin,
      annotations: tool.annotations,
    });
    validateToolSchema(normalized);
    return normalized;
  } catch { return undefined; }
}

export class WebMCPAdapter {
  private registered = new Map<string, BrowserRegisteredTool>();
  private revision = 0;
  private signature = '';
  private context: BrowserModelContext | undefined;
  private unavailableSignature = '';

  isSupported(): boolean {
    return Boolean(document.modelContext?.getTools && document.modelContext?.executeTool);
  }

  async getTools(): Promise<WebMCPTool[]> {
    const context = document.modelContext;
    if (context !== this.context) {
      const contextDisappeared = Boolean(this.context) && !context;
      this.context = context;
      this.signature = '';
      this.registered.clear();
      if (contextDisappeared) this.revision += 1;
    }
    if (!context) return [];
    const normalized: Array<{ registered: BrowserRegisteredTool; exposed: WebMCPTool }> = [];
    const unavailable: string[] = [];
    const names = new Set<string>();
    for (const registered of (await context.getTools()).slice(0, 64)) {
      const exposed = normalizeRegisteredTool(registered, location.origin);
      if (!exposed) { if (/^[A-Za-z0-9_.-]{1,128}$/.test(registered.name)) unavailable.push(registered.name); continue; }
      if (names.has(exposed.name)) continue;
      names.add(exposed.name); normalized.push({ registered, exposed });
    }
    const unavailableSignature = unavailable.sort().join(',');
    if (unavailableSignature !== this.unavailableSignature) {
      this.unavailableSignature = unavailableSignature;
      unavailable.forEach((toolName) => console.warn('[Buddy] WebMCP tool unavailable', { toolName, reason: 'incompatible-definition-or-schema' }));
    }
    const exposed = normalized.map((item) => item.exposed);
    const nextSignature = JSON.stringify(exposed);
    if (nextSignature !== this.signature) {
      this.registered = new Map(normalized.map((item) => [item.exposed.name, item.registered]));
      this.signature = nextSignature;
      this.revision += 1;
    }
    return exposed;
  }

  getRevision(): number { return this.revision; }

  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal, expectedRevision?: number): Promise<unknown> {
    const context = document.modelContext;
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new Error('The site actions changed. Please review a fresh plan before continuing.');
    const tool = this.registered.get(name);
    if (!context || !tool) throw new Error('The selected site action is no longer available.');
    const timeout = AbortSignal.timeout(30_000);
    const executionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const raw = await context.executeTool(tool, args, { signal: executionSignal });
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw) as unknown; } catch { return raw; }
  }

  subscribe(callback: ToolChangeListener): () => void {
    let context = document.modelContext;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let discoveryIndex = 0;
    let refreshing = false;
    const discoveryDelays = [2_000, 5_000, 10_000, 30_000] as const;
    const syncContext = () => {
      if (context === document.modelContext) return;
      context?.removeEventListener('toolchange', listener);
      context = document.modelContext;
      context?.addEventListener('toolchange', listener);
      if (!context) discoveryIndex = 0;
    };
    const refresh = async () => {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        syncContext();
        const previous = this.revision;
        const tools = await this.getTools();
        if (!stopped && previous !== this.revision) callback(tools);
      } catch { if (!stopped) callback([]); }
      finally { refreshing = false; }
    };
    const listener: EventListener = () => { void refresh(); };
    const schedule = () => {
      if (stopped) return;
      const delay = context ? 30_000 : discoveryDelays[Math.min(discoveryIndex, discoveryDelays.length - 1)]!;
      if (!context && discoveryIndex < discoveryDelays.length - 1) discoveryIndex += 1;
      timer = setTimeout(() => { timer = undefined; void refresh().finally(schedule); }, delay);
    };
    context?.addEventListener('toolchange', listener);
    schedule();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); context?.removeEventListener('toolchange', listener); };
  }
}

export interface RegisterableTool {
  name: string; title?: string; description: string; inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute(input: Record<string, unknown>, signal: AbortSignal): unknown | Promise<unknown>;
}

export async function registerTools(tools: RegisterableTool[]): Promise<() => void> {
  const context = document.modelContext;
  if (!context) return () => undefined;
  const controllers: AbortController[] = [];
  for (const tool of tools) {
    const controller = new AbortController(); controllers.push(controller);
    await context.registerTool({
      name: tool.name, ...(tool.title ? { title: tool.title } : {}), description: tool.description,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}),
      execute: (input, options) => tool.execute(input, options.signal),
    }, { signal: controller.signal });
  }
  return () => controllers.forEach((controller) => controller.abort());
}
