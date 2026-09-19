import type { GroveAdmin } from './admin.js';
import type { AdminActionRequest } from './admin-schema.js';
import type { Actor, Context, Grove } from './service.js';
import type { Schema, SaveInput, MediaPatch, MemberInput } from './schema.js';
import { GroveError, requireCondition } from './errors.js';
import { MAX_UPLOAD_BYTES } from './media.js';
import { object } from './validation.js';

export type HandlerOptions = {
  /** The host verifies sessions or credentials. Never trust actor IDs from request bodies. */
  authenticate: (request: Request) => Promise<Actor | null>;
  admin?: GroveAdmin;
  onError?: (error: unknown) => void;
};
const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
async function bytesBody(request: Request, max: number): Promise<Uint8Array> {
  requireCondition(request.body, 'Request body is required');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCondition(size <= max, `Request body exceeds ${max} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  requireCondition(request.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json', 'Use Content-Type: application/json');
  const bytes = await bytesBody(request, 1_000_000);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new GroveError('invalid_request', 'Malformed JSON'); }
  requireCondition(object(value), 'JSON body must be an object');
  return value;
}

/** Framework-independent Fetch handler; host authentication + core authorization are both required. */
export function createHandler(grove: Grove | null, options: HandlerOptions): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const actor = await options.authenticate(request);
      if (!actor) throw new GroveError('unauthenticated', 'Authentication required');
      const url = new URL(request.url);
      const adminMatch = /^\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/environments\/([^/]+)\/admin(?:\/(.*))?$/.exec(url.pathname);
      if (adminMatch && options.admin) {
        let parts: string[]; try { parts = adminMatch.slice(1, 4).map(decodeURIComponent); } catch { throw new GroveError('invalid_request', 'Invalid URL encoding'); }
        const ctx = { actor, scope: { tenantId: parts[0]!, siteId: parts[1]!, environment: parts[2]! } };
        const route = adminMatch[4] ?? '';
        if (route === 'modules' && request.method === 'GET') return json(await options.admin.catalog(ctx));
        const resource = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/(query|activity|records\/([A-Za-z0-9_-]+)|actions\/([A-Za-z0-9_-]+))$/.exec(route);
        if (resource) {
          const [, module, id, action, record, operation] = resource;
          if (action === 'query' && request.method === 'POST') return json(await options.admin.query(ctx, module!, id!, await body(request)));
          if (action === 'activity' && request.method === 'GET') return json(await options.admin.activity(ctx, module!, id!));
          if (record && request.method === 'GET') return json(await options.admin.get(ctx, module!, id!, record));
          if (operation && request.method === 'POST') { const result = await options.admin.run(ctx, module!, id!, operation, await body(request) as AdminActionRequest); return json(result, result.status === 'succeeded' ? 200 : 202); }
        }
        throw new GroveError('not_found', 'Admin route not found');
      }
      const match = /^\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/environments\/([^/]+)\/(schema|documents|delivery|media|members)(?:\/([^/]+))?(?:\/(history|publish|unpublish|restore|where-used|migrate|content|archive))?\/?$/.exec(url.pathname);
      if (!grove || !match) throw new GroveError('not_found', 'Route not found');
      let parts: string[];
      try { parts = match.slice(1).map(p => p === undefined ? '' : decodeURIComponent(p)); }
      catch { throw new GroveError('invalid_request', 'Invalid URL encoding'); }
      const [tenantId, siteId, environment, resource, id, action] = parts as [string, string, string, string, string, string];
      const ctx: Context = { actor, scope: { tenantId, siteId, environment } };
      const method = request.method;
      if (resource === 'members' && !action) {
        if (!id && method === 'GET') return json(await grove.members.list(ctx));
        if (!id && method === 'POST') return json(await grove.members.invite(ctx, await body(request) as MemberInput), 201);
        if (id && method === 'PATCH') return json(await grove.members.update(ctx, id, await body(request) as Partial<MemberInput>));
        if (id && method === 'DELETE') { await grove.members.remove(ctx, id); return json({ ok: true }); }
      }
      if (resource === 'schema' && !id && !action) {
        if (method === 'GET') return json(await grove.getSchema(ctx));
        if (method === 'PUT') {
          const input = await body(request);
          requireCondition(input.dryRun === undefined || typeof input.dryRun === 'boolean', 'dryRun must be boolean');
          requireCondition(input.allowBreaking === undefined || typeof input.allowBreaking === 'boolean', 'allowBreaking must be boolean');
          return json(await grove.pushSchema(ctx, input.definition as Schema, input.expectedVersion as number, { dryRun: input.dryRun as boolean, allowBreaking: input.allowBreaking as boolean }));
        }
      }
      if (resource === 'delivery' && id && !action && method === 'GET') return json(await grove.deliver(ctx, id, url.searchParams.get('locale') ?? undefined));
      if (resource === 'media') {
        if (!id && method === 'GET') return json(await grove.media.list(ctx, { search: url.searchParams.get('search') ?? undefined, after: url.searchParams.get('after') ?? undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined, archived: url.searchParams.get('archived') === 'true' }));
        if (!id && method === 'POST') {
          let filename: string;
          try { filename = decodeURIComponent(request.headers.get('X-Grove-Filename') ?? 'image'); }
          catch { throw new GroveError('invalid_request', 'Invalid filename encoding'); }
          return json(await grove.media.upload(ctx, filename, await bytesBody(request, MAX_UPLOAD_BYTES)), 201);
        }
        if (id && !action && method === 'GET') return json(await grove.media.get(ctx, id));
        if (id && !action && method === 'PATCH') return json(await grove.media.update(ctx, id, await body(request) as MediaPatch));
        if (id && action === 'where-used' && method === 'GET') return json(await grove.media.whereUsed(ctx, id, Number(url.searchParams.get('offset') ?? 0)));
        if (id && action === 'content' && method === 'GET') {
          const result = await grove.media.read(ctx, id);
          return new Response(new Uint8Array(result.bytes), { headers: { 'Content-Type': result.asset.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        if (id && ['archive', 'restore'].includes(action) && method === 'POST') {
          const input = await body(request); return json(await grove.media.setArchived(ctx, id, input.expectedRevision as number, action === 'archive'));
        }
      }
      if (resource === 'documents') {
        if (!id && !action && method === 'GET') return json(await grove.listDocuments(ctx, {
          search: url.searchParams.get('search') ?? undefined,
          type: url.searchParams.get('type') ?? undefined,
          after: url.searchParams.get('after') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        }));
        if (id && !action && method === 'GET') return json(await grove.getDocument(ctx, id));
        if (id && !action && method === 'PUT') return json(await grove.saveDocument(ctx, id, await body(request) as SaveInput));
        if (id && action === 'where-used' && method === 'GET') return json(await grove.whereUsed(ctx, id, Number(url.searchParams.get('offset') ?? 0)));
        if (id && action === 'migrate' && method === 'POST') return json(await grove.migrateDocument(ctx, id, await body(request) as Parameters<Grove['migrateDocument']>[2]));
        if (id && action === 'history' && method === 'GET') return json(await grove.history(ctx, id, {
          before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        }));
        if (id && ['publish', 'unpublish', 'restore'].includes(action) && method === 'POST') {
          const input = await body(request);
          if (action === 'restore') return json(await grove.restore(ctx, id, input.targetRevision as number, input.expectedRevision as number));
          return json(await grove[action as 'publish' | 'unpublish'](ctx, id, input.expectedRevision as number));
        }
      }
      throw new GroveError('not_found', 'Route or method not found');
    } catch (error) {
      if (error instanceof GroveError) return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
      options.onError?.(error);
      return json({ error: { code: 'internal_error', message: 'An unexpected error occurred' } }, 500);
    }
  };
}

/** A headless admin host needs no CMS instance or content schema. */
export function createAdminHandler(admin: GroveAdmin, options: Omit<HandlerOptions, 'admin'>) { return createHandler(null, { ...options, admin }); }
