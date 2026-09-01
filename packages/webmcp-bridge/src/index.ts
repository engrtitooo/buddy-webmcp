import type { WebMCPTool } from '@buddy/shared';

export interface BrowserWebMCPAnnotations { readOnlyHint?: boolean; untrustedContentHint?: boolean }
export interface BrowserRegisteredTool { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; window: Window; origin: string; annotations?: BrowserWebMCPAnnotations }
export interface BrowserToolDefinition { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; annotations?: BrowserWebMCPAnnotations; execute(input: Record<string, unknown>, options: { signal: AbortSignal }): unknown | Promise<unknown> }
export interface BrowserModelContext extends EventTarget {
  registerTool(tool: BrowserToolDefinition, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void>;
  getTools(options?: { fromOrigins?: string[] }): Promise<BrowserRegisteredTool[]>;
  executeTool(tool: BrowserRegisteredTool, input?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<string>;
}
declare global { interface Document { readonly modelContext?: BrowserModelContext } }

export type ToolChangeListener = (tools: WebMCPTool[]) => void;

export class WebMCPAdapter {
  private registered = new Map<string, BrowserRegisteredTool>();
  private revision = 0;
  private signature = '';
  private context: BrowserModelContext | undefined;

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
    const tools = (await context.getTools()).filter((tool) => typeof tool.name === 'string' && tool.name.length > 0 && tool.name.length <= 128 && typeof tool.description === 'string' && tool.description.length <= 2_000).slice(0, 64);
    const unique = tools.filter((tool, index) => tools.findIndex((candidate) => candidate.name === tool.name) === index);
    const exposed = unique.map(({ name, title, description, inputSchema, origin, annotations }) => ({
      name, ...(title ? { title } : {}), description, ...(inputSchema ? { inputSchema } : {}), origin: origin || location.origin,
      ...(annotations ? { annotations: { ...annotations } } : {}),
    }));
    const nextSignature = JSON.stringify(exposed);
    if (nextSignature !== this.signature) {
      this.registered = new Map(unique.map((tool) => [tool.name, tool]));
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
    if (!context || !tool) throw new Error(`The ${name} action is no longer available.`);
    const timeout = AbortSignal.timeout(30_000);
    const executionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const raw = await context.executeTool(tool, args, { signal: executionSignal });
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw) as unknown; } catch { return raw; }
  }

  subscribe(callback: ToolChangeListener): () => void {
    let context = document.modelContext;
    let stopped = false;
    const refresh = () => { const previous = this.revision; void this.getTools().then((tools) => { if (!stopped && previous !== this.revision) callback(tools); }).catch(() => { if (!stopped) callback([]); }); };
    const listener: EventListener = refresh;
    context?.addEventListener('toolchange', listener);
    const interval = setInterval(() => {
      if (context !== document.modelContext) { context?.removeEventListener('toolchange', listener); context = document.modelContext; context?.addEventListener('toolchange', listener); }
      refresh();
    }, 2_000);
    return () => { stopped = true; clearInterval(interval); context?.removeEventListener('toolchange', listener); };
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
