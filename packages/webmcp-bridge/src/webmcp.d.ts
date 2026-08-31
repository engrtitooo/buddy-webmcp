export {};
declare global {
interface WebMCPAnnotations { readOnlyHint?: boolean; untrustedContentHint?: boolean }
interface WebMCPRegisteredTool { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; window: Window; origin: string; annotations?: WebMCPAnnotations }
interface WebMCPToolDefinition { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; annotations?: WebMCPAnnotations; execute(input: Record<string, unknown>, options: { signal: AbortSignal }): unknown | Promise<unknown> }
interface ModelContext extends EventTarget {
  registerTool(tool: WebMCPToolDefinition, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void>;
  getTools(options?: { fromOrigins?: string[] }): Promise<WebMCPRegisteredTool[]>;
  executeTool(tool: WebMCPRegisteredTool, input?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<string>;
  ontoolchange: ((event: Event) => void) | null;
}
interface Document { readonly modelContext?: ModelContext }
}
