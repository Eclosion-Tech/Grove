import { createHash } from 'node:crypto';
import type { AdminAction, AdminModule, AdminResource } from './admin.js';
import { AdminActionRejected, fieldsValid } from './admin.js';
import type { AdminRecord } from './admin-schema.js';
import type { Content } from './schema.js';
import type { Authorize, Context } from './service.js';
import { GroveError, requireCondition } from './errors.js';
import { canonical, identifier, object, revision } from './validation.js';
import { REMOTE_PROTOCOL_VERSION, REMOTE_VERSION_HEADER, type RemoteAccess, type RemoteCatalog, type RemoteContext, type RemoteDescriptor, type RemoteOutcome, type RemoteRecord } from './remote-schema.js';
import { signRequest, type SigningKey } from './signing.js';

/** Where a remote module lives. Grove stores only the endpoint; trust comes from Grove's signature, verified by the application. */
export type RemoteConnection = { id: string; endpoint: string; hostId: string };
export type RemoteModuleOptions = {
  connection: RemoteConnection;
  key: SigningKey;
  authorize: Authorize;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Poll a `running` outcome this many times before giving up as uncertain. */
  statusPolls?: number;
  /** Tests only: accept http on loopback. */
  allowLoopback?: boolean;
  onError?: (error: unknown) => void;
};
export class RemoteProtocolError extends Error { override readonly name = 'RemoteProtocolError'; constructor(message: string, readonly kind: 'network' | 'timeout' | 'status' | 'protocol', readonly status?: number) { super(message); } }

const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
const privateHost = (host: string) => loopback(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i.test(host) || host.endsWith('.local') || host.endsWith('.internal');
/** Endpoint rules: https, bare path, no credentials, no private or link-local hosts. Loopback http only when a test asks for it. */
export function validateEndpoint(value: string, allowLoopback = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new GroveError('invalid_request', 'The module endpoint must be a URL'); }
  requireCondition(!url.username && !url.password && !url.search && !url.hash, 'The module endpoint must not carry credentials, a query or a fragment');
  if (url.protocol === 'https:') requireCondition(!privateHost(url.hostname), 'The module endpoint must be a public host');
  else requireCondition(url.protocol === 'http:' && allowLoopback && loopback(url.hostname), 'The module endpoint must use https');
  return url.toString().replace(/\/+$/, '');
}
const text = (value: unknown, max = 2000): string => { requireCondition(typeof value === 'string' && value.length <= max, 'Invalid text in module descriptor'); return value; };
/** The catalog is untrusted input: bounded, typed, permission-namespaced, and free of anything executable. */
export function validateDescriptor(value: unknown): RemoteDescriptor {
  requireCondition(object(value), 'Invalid module descriptor');
  identifier(value.id, 'Module id');
  const prefix = `admin:${value.id}:`;
  const permission = (p: unknown) => { requireCondition(typeof p === 'string' && p.startsWith(prefix) && /^[a-z0-9:-]+$/.test(p) && p.length <= 200, `Module permissions must start with ${prefix}`); return p; };
  requireCondition(Array.isArray(value.resources) && value.resources.length > 0 && value.resources.length <= 50, 'A module needs 1–50 resources');
  const resources = value.resources.map((resource: unknown) => {
    requireCondition(object(resource), 'Invalid resource'); identifier(resource.id, 'Resource id');
    requireCondition(Array.isArray(resource.columns) && resource.columns.length > 0 && resource.columns.length <= 50, 'Provide 1–50 columns');
    const columns = resource.columns.map((c: unknown) => { requireCondition(object(c) && ['text', 'number', 'boolean', 'status'].includes(String(c.type)), 'Invalid column'); identifier(c.name, 'Column'); return { name: c.name as string, label: text(c.label, 200), type: c.type as 'text' | 'number' | 'boolean' | 'status', ...(c.permission !== undefined ? { permission: permission(c.permission) } : {}) }; });
    const filters = Array.isArray(resource.filters) ? resource.filters : []; fieldsValid(filters as never);
    requireCondition(Array.isArray(resource.actions) && resource.actions.length <= 30, 'At most 30 actions');
    const actions = resource.actions.map((a: unknown) => { requireCondition(object(a), 'Invalid action'); identifier(a.id, 'Action'); fieldsValid((Array.isArray(a.inputs) ? a.inputs : []) as never); return { id: a.id as string, label: text(a.label, 200), description: text(a.description), confirmation: text(a.confirmation), inputs: (Array.isArray(a.inputs) ? a.inputs : []) as never, permission: permission(a.permission) }; });
    return { id: resource.id as string, label: text(resource.label, 200), description: text(resource.description), permission: permission(resource.permission), columns, filters: filters as never, actions };
  });
  return { id: value.id as string, label: text(value.label, 200), description: text(value.description), resources };
}
function validateRecord(value: unknown, actionIds: string[]): RemoteRecord {
  requireCondition(object(value) && object(value.access) && typeof value.access.read === 'boolean' && object(value.access.actions), 'The module returned an invalid record');
  identifier(value.id, 'Record'); revision(value.version, 'Record version'); requireCondition(object(value.values), 'Record values must be an object');
  const actions: RemoteAccess['actions'] = {};
  for (const id of actionIds) { const decision = (value.access.actions as Record<string, unknown>)[id]; actions[id] = object(decision) ? { authorized: decision.authorized === true, available: decision.available === true } : { authorized: false, available: false }; }
  return { id: value.id, version: value.version, values: value.values as Content, access: { read: value.access.read, actions } };
}
export const inputHash = (recordId: string, expectedVersion: number, values: Content) => createHash('sha256').update(canonical({ recordId, expectedVersion, values })).digest('hex');

/** Builds an AdminModule whose sources and actions are served by an application over the signed remote protocol. */
export async function remoteModule(options: RemoteModuleOptions): Promise<AdminModule & { catalogRevision: string }> {
  const endpoint = validateEndpoint(options.connection.endpoint, options.allowLoopback);
  identifier(options.connection.id, 'Connection id'); requireCondition(typeof options.connection.hostId === 'string' && options.connection.hostId.length > 0 && options.connection.hostId.length <= 200, 'Host id is required');
  const fetcher = options.fetcher ?? fetch;
  const timeout = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 4_000_000;
  async function call(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
    const url = new URL(endpoint + path);
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store', ...signRequest(options.key, { method: 'POST', path: url.pathname, body }) };
    let response: Response;
    try { response = await fetcher(url.toString(), { method: 'POST', headers, body, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
    catch (error) { throw new RemoteProtocolError('The module could not be reached', error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'); }
    const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (bytes.byteLength > maxBytes) throw new RemoteProtocolError('The module response was too large', 'protocol', response.status);
    if ((response.headers.get(REMOTE_VERSION_HEADER) ?? '').split('.')[0] !== REMOTE_PROTOCOL_VERSION.split('.')[0]) throw new RemoteProtocolError('The module speaks an unsupported protocol version', 'protocol', response.status);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RemoteProtocolError('The module returned malformed JSON', 'protocol', response.status); }
    return { status: response.status, body: parsed };
  }
  const catalog = await call('/catalog', { context: { hostId: options.connection.hostId, connectionId: options.connection.id } });
  requireCondition(catalog.status === 200 && object(catalog.body) && typeof catalog.body.catalogRevision === 'string' && catalog.body.catalogRevision.length <= 200, 'The module returned no catalog');
  const revisionId = catalog.body.catalogRevision;
  const descriptor = validateDescriptor((catalog.body as RemoteCatalog).module);
  const access = new WeakMap<AdminRecord, RemoteAccess>();
  async function context(ctx: Context, resource: RemoteDescriptor['resources'][number]): Promise<RemoteContext> {
    const names = [...new Set([resource.permission, ...resource.columns.flatMap(c => c.permission ? [c.permission] : []), ...resource.actions.map(a => a.permission)])];
    const granted = await Promise.all(names.map(async name => await options.authorize(ctx.actor, ctx.scope, name as never) ? name : null));
    return { hostId: options.connection.hostId, connectionId: options.connection.id, scope: ctx.scope, actor: { id: ctx.actor.id, permissions: granted.filter((n): n is string => !!n) } };
  }
  const failure = (result: { status: number; body: unknown }) => { const message = object(result.body) && object(result.body.error) && typeof result.body.error.message === 'string' ? result.body.error.message : `The module refused the request (${result.status})`; return new RemoteProtocolError(message, 'status', result.status); };
  function resourceFor(resource: RemoteDescriptor['resources'][number]): AdminResource {
    const base = `/resources/${encodeURIComponent(resource.id)}`;
    const actionIds = resource.actions.map(a => a.id);
    const keep = (row: unknown) => { const record = validateRecord(row, actionIds); const plain: AdminRecord = { id: record.id, version: record.version, values: record.values }; access.set(plain, record.access); return plain; };
    return {
      id: resource.id, label: resource.label, description: resource.description, permission: resource.permission as never, columns: resource.columns as never, filters: resource.filters,
      source: {
        async query(ctx, { filters, cursor, limit }) {
          const result = await call(`${base}/query`, { context: await context(ctx, resource), catalogRevision: revisionId, filters, cursor, limit });
          if (result.status !== 200) throw failure(result);
          requireCondition(object(result.body) && Array.isArray(result.body.records) && result.body.records.length <= limit && (result.body.nextCursor === null || (typeof result.body.nextCursor === 'string' && result.body.nextCursor.length <= 500)), 'The module returned an invalid page');
          return { records: result.body.records.map(keep), nextCursor: result.body.nextCursor as string | null };
        },
        async get(ctx, id) {
          const result = await call(`${base}/records/${encodeURIComponent(id)}`, { context: await context(ctx, resource), catalogRevision: revisionId });
          if (result.status === 404) return null;
          if (result.status !== 200) throw failure(result);
          requireCondition(object(result.body) && object(result.body.record), 'The module returned an invalid record');
          return keep(result.body.record);
        },
        authorizeRecord: (_ctx, record, operation) => { const decision = access.get(record); return !!decision && (operation === 'read' ? decision.read : decision.actions[operation]?.authorized === true); },
      },
      actions: resource.actions.map((action): AdminAction => ({
        ...action, permission: action.permission as never,
        available: (_ctx, record) => access.get(record)?.actions[action.id]?.available === true,
        async execute(ctx, request) {
          const hash = inputHash(request.record.id, request.expectedVersion, request.values);
          const payload = { context: await context(ctx, resource), catalogRevision: revisionId, operationId: request.operationId, inputHash: hash, recordId: request.record.id, expectedVersion: request.expectedVersion, values: request.values };
          let outcome = interpret(await call(`${base}/actions/${encodeURIComponent(action.id)}`, payload), request.operationId, hash);
          for (let poll = 0; outcome.status === 'running' && poll < (options.statusPolls ?? 3); poll++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            outcome = interpret(await call(`/operations/${encodeURIComponent(request.operationId)}`, { context: payload.context, operationId: request.operationId, inputHash: hash }), request.operationId, hash);
          }
          if (outcome.status === 'succeeded') return;
          if (outcome.status === 'rejected' && outcome.noEffectsCommitted === true) throw new AdminActionRejected(outcome.error?.message ?? 'The application rejected this action');
          options.onError?.(new RemoteProtocolError(`Unresolved outcome: ${outcome.status}`, 'protocol'));
          throw new RemoteProtocolError(outcome.error?.message ?? 'The application did not confirm this action', 'protocol');
        },
      })),
    };
  }
  /** Only a well-formed outcome envelope for this operation counts; anything else is an unverifiable result. */
  function interpret(result: { status: number; body: unknown }, operationId: string, hash: string): RemoteOutcome {
    const body = result.body;
    if (!object(body) || body.operationId !== operationId || body.inputHash !== hash || !['succeeded', 'rejected', 'running', 'unknown'].includes(String(body.status))) throw new RemoteProtocolError(`The application returned no verifiable outcome (${result.status})`, 'protocol', result.status);
    const error = object(body.error) && typeof body.error.code === 'string' && typeof body.error.message === 'string' ? { code: body.error.code.slice(0, 100), message: body.error.message.slice(0, 500) } : undefined;
    return { operationId, inputHash: hash, status: body.status as RemoteOutcome['status'], noEffectsCommitted: body.noEffectsCommitted === true, error };
  }
  const built: AdminModule & { catalogRevision: string } = { id: descriptor.id, label: descriptor.label, description: descriptor.description, resources: descriptor.resources.map(resourceFor), catalogRevision: revisionId };
  return built;
}
