import type { DeliveredDocument, Document, HistoryEntry, SaveInput, Schema, SchemaRecord, Scope, MediaAsset, MediaPatch, Usage, Content, AdminModuleInfo, AdminPage, AdminRecordView, AdminExecution, AdminActionRequest } from './schema.js';

export class GroveClientError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'GroveClientError';
  }
}
export type ClientOptions = {
  baseUrl: string;
  scope: Scope;
  /** Use server-side for API keys. Browser integrations should use host-managed sessions. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof globalThis.fetch;
};
export function createClient(options: ClientOptions) {
  const base = `${options.baseUrl.replace(/\/$/, '')}/v1/tenants/${encodeURIComponent(options.scope.tenantId)}/sites/${encodeURIComponent(options.scope.siteId)}/environments/${encodeURIComponent(options.scope.environment)}`;
  const path = (id: string) => `documents/${encodeURIComponent(id)}`;
  async function request<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
    const headers = new Headers(await options.headers?.());
    if (data !== undefined) headers.set('Content-Type', 'application/json');
    const response = await (options.fetch ?? globalThis.fetch)(`${base}/${route}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'same-origin' });
    const value = await response.json() as any;
    if (!response.ok) throw new GroveClientError(response.status, value.error?.code ?? 'http_error', value.error?.message ?? `HTTP ${response.status}`, value.error?.details);
    return value as T;
  }
  const adminPath = (module: string, resource: string) => `admin/${encodeURIComponent(module)}/${encodeURIComponent(resource)}`;
  return {
    adminModules: () => request<AdminModuleInfo[]>('admin/modules'),
    adminQuery: (module: string, resource: string, input: { filters?: Content; cursor?: string | null; limit?: number } = {}) => request<AdminPage>(`${adminPath(module, resource)}/query`, 'POST', input),
    adminGet: (module: string, resource: string, id: string) => request<AdminRecordView>(`${adminPath(module, resource)}/records/${encodeURIComponent(id)}`),
    adminRun: (module: string, resource: string, action: string, input: AdminActionRequest) => request<AdminExecution>(`${adminPath(module, resource)}/actions/${encodeURIComponent(action)}`, 'POST', input),
    adminActivity: (module: string, resource: string) => request<AdminExecution[]>(`${adminPath(module, resource)}/activity`),
    getSchema: () => request<SchemaRecord | null>('schema'),
    pushSchema: (definition: Schema, expectedVersion: number, opts: { dryRun?: boolean; allowBreaking?: boolean } = {}) => request<{ version: number; changes: { path: string; change: string; breaking: boolean }[]; applied: boolean }>('schema', 'PUT', { definition, expectedVersion, ...opts }),
    listDocuments: (options: { type?: string; search?: string; after?: string; limit?: number } = {}) => {
      const query = new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      return request<Document[]>(`documents?${query}`);
    },
    whereUsed: (id: string, offset = 0) => request<Usage[]>(`${path(id)}/where-used?offset=${offset}`),
    migrateDocument: (id: string, input: { expectedRevision: number; expectedSchemaVersion: number; draft: Content; published: Content | null }) => request<Document>(`${path(id)}/migrate`, 'POST', input),
    listMedia: (options: { search?: string; after?: string; limit?: number; archived?: boolean } = {}) => request<MediaAsset[]>(`media?${new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
    getMedia: (id: string) => request<MediaAsset>(`media/${encodeURIComponent(id)}`),
    mediaContentUrl: (id: string) => `${base}/media/${encodeURIComponent(id)}/content`,
    updateMedia: (id: string, input: MediaPatch) => request<MediaAsset>(`media/${encodeURIComponent(id)}`, 'PATCH', input),
    archiveMedia: (id: string, expectedRevision: number) => request<MediaAsset>(`media/${encodeURIComponent(id)}/archive`, 'POST', { expectedRevision }),
    restoreMedia: (id: string, expectedRevision: number) => request<MediaAsset>(`media/${encodeURIComponent(id)}/restore`, 'POST', { expectedRevision }),
    mediaWhereUsed: (id: string, offset = 0) => request<Usage[]>(`media/${encodeURIComponent(id)}/where-used?offset=${offset}`),
    uploadMedia: async (file: Blob, filename: string): Promise<MediaAsset> => {
      const headers = new Headers(await options.headers?.()); headers.set('Content-Type', 'application/octet-stream'); headers.set('X-Grove-Filename', encodeURIComponent(filename));
      const response = await (options.fetch ?? globalThis.fetch)(`${base}/media`, { method: 'POST', headers, body: file, credentials: 'same-origin' });
      const value = await response.json();
      if (!response.ok) throw new GroveClientError(response.status, value.error?.code ?? 'http_error', value.error?.message ?? `HTTP ${response.status}`, value.error?.details);
      return value;
    },
    getDocument: (id: string) => request<Document>(path(id)),
    saveDocument: (id: string, input: SaveInput) => request<Document>(path(id), 'PUT', input),
    publish: (id: string, expectedRevision: number) => request<Document>(`${path(id)}/publish`, 'POST', { expectedRevision }),
    unpublish: (id: string, expectedRevision: number) => request<Document>(`${path(id)}/unpublish`, 'POST', { expectedRevision }),
    history: (id: string, options: { before?: number; limit?: number } = {}) => {
      const query = new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      return request<HistoryEntry[]>(`${path(id)}/history?${query}`);
    },
    restore: (id: string, targetRevision: number, expectedRevision: number) => request<Document>(`${path(id)}/restore`, 'POST', { targetRevision, expectedRevision }),
    deliver: (id: string, locale?: string) => request<DeliveredDocument>(`delivery/${encodeURIComponent(id)}${locale === undefined ? '' : `?locale=${encodeURIComponent(locale)}`}`),
  };
}
