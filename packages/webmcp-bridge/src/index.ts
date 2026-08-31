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
  private listener?: EventListener;
  private revision = 0;

  isSupported(): boolean {
    return Boolean(document.modelContext?.getTools && document.modelContext?.executeTool);
  }

  async getTools(): Promise<WebMCPTool[]> {
    const context = document.modelContext;
    if (!context) return [];
    const tools = await context.getTools();
    this.registered = new Map(tools.map((tool) => [tool.name, tool]));
    this.revision += 1;
    return tools.map(({ name, title, description, inputSchema, origin, annotations }) => ({
      name, ...(title ? { title } : {}), description, ...(inputSchema ? { inputSchema } : {}), origin,
      ...(annotations ? { annotations: { ...annotations } } : {}),
    }));
  }

  getRevision(): number { return this.revision; }

  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal, expectedRevision?: number): Promise<unknown> {
    const context = document.modelContext;
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new Error('The site actions changed. Please review a fresh plan before continuing.');
    const tool = this.registered.get(name);
    if (!context || !tool) throw new Error(`The ${name} action is no longer available.`);
    const raw = await context.executeTool(tool, args, signal ? { signal } : {});
    try { return JSON.parse(raw) as unknown; } catch { return raw; }
  }

  subscribe(callback: ToolChangeListener): () => void {
    const context = document.modelContext;
    if (!context) return () => undefined;
    this.listener = () => { void this.getTools().then(callback).catch(() => callback([])); };
    context.addEventListener('toolchange', this.listener);
    return () => { if (this.listener) context.removeEventListener('toolchange', this.listener); };
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
