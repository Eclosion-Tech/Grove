type Tool = { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => Promise<unknown> };
type ModelContext = { registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void> };

/** Optional browser capability; absence never affects ordinary editing. */
export function registerContentTools(list: (type?: string) => Promise<unknown>, open: (id: string) => Promise<unknown>) {
  const context = (document as unknown as { modelContext?: ModelContext }).modelContext;
  if (!context?.registerTool) return () => {};
  const lifecycle = new AbortController();
  const tools: Tool[] = [
    { name: 'grove_list_content', title: 'List Grove content', description: 'Read the first 100 accessible documents in this workspace, optionally filtered by collection. Does not change content.', inputSchema: { type: 'object', properties: { type: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: async input => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'type')) throw new Error('Provide an object with an optional type.');
      const type = (input as { type?: unknown }).type;
      if (type !== undefined && typeof type !== 'string') throw new Error('type must be a string.');
      return list(type);
    } },
    { name: 'grove_open_document', title: 'Open Grove document', description: 'Save the currently edited draft if needed and open the requested document. Stops if saving is blocked. Does not publish.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async input => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'id')) throw new Error('Provide a document id.');
      const id = (input as { id?: unknown }).id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) throw new Error('Invalid document id.');
      return open(id);
    } },
  ];
  for (const tool of tools) {
    try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(error => console.warn('Grove browser tools unavailable', error)); }
    catch (error) { console.warn('Grove browser tools unavailable', error); }
  }
  return () => lifecycle.abort();
}
