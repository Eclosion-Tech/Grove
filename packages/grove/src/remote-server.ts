import type { AdminModule } from './admin.js';
import { isRejection } from './admin.js';
import type { AdminRecord } from './admin-schema.js';
import type { Context } from './service.js';
import { GroveError, requireCondition } from './errors.js';
import { identifier, object, revision, scopeValid } from './validation.js';
import { inputHash } from './remote.js';
import { REMOTE_PROTOCOL_VERSION, REMOTE_VERSION_HEADER, type RemoteContext, type RemoteDescriptor, type RemoteOutcome, type RemoteRecord } from './remote-schema.js';
import { SignatureError, verifyRequest, type PublicJwk } from './signing.js';

/** An application's durable record of Grove operations. Record success in the same transaction as the mutation. */
export type OperationLedger = {
  lookup(operationId: string): Promise<RemoteOutcome | null>;
  record(outcome: RemoteOutcome): Promise<void>;
};
export class MemoryLedger implements OperationLedger {
  private outcomes = new Map<string, RemoteOutcome>();
  async lookup(operationId: string) { return this.outcomes.get(operationId) ?? null; }
  async record(outcome: RemoteOutcome) { this.outcomes.set(outcome.operationId, outcome); }
}
export type RemoteServerOptions = {
  module: AdminModule;
  /** Changes whenever the module's contract changes; Grove refuses to execute against a revision it did not review. */
  catalogRevision: string;
  resolveKey: (kid: string) => PublicJwk | undefined | Promise<PublicJwk | undefined>;
  /** Which Grove instances and workspaces this application serves. */
  allow: (context: { hostId: string; connectionId: string; scope?: RemoteContext['scope'] }) => boolean | Promise<boolean>;
  ledger?: OperationLedger;
  now?: () => number;
  maxBytes?: number;
  onError?: (error: unknown) => void;
};

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', [REMOTE_VERSION_HEADER]: REMOTE_PROTOCOL_VERSION } });
const refuse = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
const contextValid = (value: unknown, full: boolean): RemoteContext => {
  requireCondition(object(value) && typeof value.hostId === 'string' && value.hostId.length <= 200 && typeof value.connectionId === 'string' && value.connectionId.length <= 100, 'Invalid context');
  if (!full) return { hostId: value.hostId, connectionId: value.connectionId, scope: { tenantId: '', siteId: '', environment: '' }, actor: { id: '', permissions: [] } };
  scopeValid(value.scope as never); requireCondition(object(value.actor) && typeof value.actor.id === 'string' && value.actor.id.length > 0 && Array.isArray(value.actor.permissions) && value.actor.permissions.every(p => typeof p === 'string'), 'Invalid actor');
  return value as RemoteContext;
};
export function describe(module: AdminModule): RemoteDescriptor {
  return { id: module.id, label: module.label, description: module.description, resources: module.resources.map(r => ({
    id: r.id, label: r.label, description: r.description, permission: r.permission, columns: r.columns, filters: r.filters,
    actions: r.actions.map(a => ({ id: a.id, label: a.label, description: a.description, confirmation: a.confirmation, inputs: a.inputs, permission: a.permission })),
  })) };
}

/**
 * Serves an in-process AdminModule over the signed remote protocol. Mount it on any Fetch-compatible server.
 * The module's own authorizeRecord and available predicates become per-record decisions in every response.
 */
export function createRemoteModuleHandler(options: RemoteServerOptions) {
  const ledger = options.ledger ?? new MemoryLedger();
  const resource = (id: string) => options.module.resources.find(r => r.id === id) ?? null;
  async function decide(ctx: Context, res: AdminModule['resources'][number], record: AdminRecord, permissions: string[]): Promise<RemoteRecord> {
    const read = await res.source.authorizeRecord(ctx, record, 'read');
    const actions: RemoteRecord['access']['actions'] = {};
    for (const action of res.actions) {
      const authorized = read && permissions.includes(action.permission) && await res.source.authorizeRecord(ctx, record, action.id);
      actions[action.id] = { authorized, available: authorized && await action.available(ctx, record) };
    }
    return { ...record, access: { read, actions } };
  }
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return refuse('method_not_allowed', 'Use POST', 405);
    const path = new URL(request.url).pathname;
    const body = await request.text();
    if (body.length > (options.maxBytes ?? 1_000_000)) return refuse('too_large', 'Request too large', 413);
    try { await verifyRequest({ method: 'POST', path, body, headers: request.headers, resolveKey: options.resolveKey, now: options.now }); }
    catch (error) { return refuse('unauthorized', error instanceof SignatureError ? error.message : 'Signature verification failed', 401); }
    let payload: Record<string, unknown>;
    try { const parsed = JSON.parse(body); requireCondition(object(parsed), 'Body must be an object'); payload = parsed; } catch { return refuse('invalid_request', 'Malformed JSON body', 400); }
    try {
      if (/\/catalog$/.test(path)) {
        const context = contextValid(payload.context, false);
        if (!await options.allow({ hostId: context.hostId, connectionId: context.connectionId })) return refuse('forbidden', 'This Grove instance is not allowed here', 403);
        return json({ catalogRevision: options.catalogRevision, module: describe(options.module) });
      }
      const context = contextValid(payload.context, true);
      if (!await options.allow(context)) return refuse('forbidden', 'This Grove instance or workspace is not allowed here', 403);
      const ctx: Context = { actor: { id: context.actor.id }, scope: context.scope };
      const operation = /\/operations\/([^/]+)$/.exec(path);
      if (operation) {
        const operationId = decodeURIComponent(operation[1]!); identifier(operationId, 'Operation');
        const found = await ledger.lookup(operationId);
        return json(found && found.inputHash === payload.inputHash ? found : { operationId, inputHash: payload.inputHash, status: 'unknown' });
      }
      const match = /\/resources\/([^/]+)\/(query|records\/([^/]+)|actions\/([^/]+))$/.exec(path);
      if (!match) return refuse('not_found', 'Unknown route', 404);
      const res = resource(decodeURIComponent(match[1]!));
      if (!res) return refuse('not_found', 'Unknown resource', 404);
      const stale = payload.catalogRevision !== options.catalogRevision;
      if (stale && !match[4]) return refuse('catalog_changed', 'The module contract changed. Refresh the connection.', 409);
      if (match[2] === 'query') {
        const limit = payload.limit; requireCondition(Number.isInteger(limit) && (limit as number) > 0 && (limit as number) <= 100, 'Invalid limit');
        const page = await res.source.query(ctx, { filters: object(payload.filters) ? payload.filters as never : {}, cursor: typeof payload.cursor === 'string' ? payload.cursor : null, limit: limit as number });
        const records: RemoteRecord[] = [];
        for (const record of page.records) { const decided = await decide(ctx, res, record, context.actor.permissions); if (decided.access.read) records.push(decided); }
        return json({ catalogRevision: options.catalogRevision, records, nextCursor: page.nextCursor });
      }
      if (match[3]) {
        const id = decodeURIComponent(match[3]); identifier(id, 'Record');
        const record = await res.source.get(ctx, id);
        const decided = record ? await decide(ctx, res, record, context.actor.permissions) : null;
        if (!decided?.access.read) return refuse('not_found', 'Record not found', 404);
        return json({ catalogRevision: options.catalogRevision, record: decided });
      }
      const action = res.actions.find(a => a.id === decodeURIComponent(match[4]!));
      if (!action) return refuse('not_found', 'Unknown action', 404);
      identifier(payload.operationId, 'Operation'); identifier(payload.recordId, 'Record'); revision(payload.expectedVersion, 'expectedVersion'); requireCondition(object(payload.values), 'Values must be an object');
      const hash = inputHash(payload.recordId, payload.expectedVersion, payload.values as never);
      requireCondition(payload.inputHash === hash, 'Input hash mismatch');
      const rejected = (code: string, message: string): RemoteOutcome => ({ operationId: payload.operationId as string, inputHash: hash, status: 'rejected', noEffectsCommitted: true, error: { code, message } });
      if (stale) return json(rejected('catalog_changed', 'The module contract changed. Refresh the connection and review the action again.'), 409);
      // Duplicate lookup precedes every other check: a committed earlier attempt must never look like a fresh stale rejection.
      const previous = await ledger.lookup(payload.operationId);
      if (previous) return previous.inputHash === hash ? json(previous, previous.status === 'succeeded' ? 200 : 409) : refuse('idempotency_conflict', 'That operation id was used with different inputs', 409);
      const record = await res.source.get(ctx, payload.recordId);
      const decided = record ? await decide(ctx, res, record, context.actor.permissions) : null;
      if (!decided?.access.read) { const outcome = rejected('not_found', 'Record not found'); await ledger.record(outcome); return json(outcome, 409); }
      if (record!.version !== payload.expectedVersion) { const outcome = rejected('stale_version', 'This record changed. Reload it and review it before continuing.'); await ledger.record(outcome); return json(outcome, 409); }
      const decision = decided.access.actions[action.id];
      if (!decision?.authorized) { const outcome = rejected('forbidden', 'This action is not available for this record.'); await ledger.record(outcome); return json(outcome, 409); }
      if (!decision.available) { const outcome = rejected('not_available', 'This action is no longer available. Reload the record.'); await ledger.record(outcome); return json(outcome, 409); }
      try {
        await action.execute(ctx, { record: record!, expectedVersion: payload.expectedVersion, values: payload.values as never, operationId: payload.operationId });
        const outcome: RemoteOutcome = { operationId: payload.operationId, inputHash: hash, status: 'succeeded' };
        await ledger.record(outcome); return json(outcome);
      } catch (error) {
        if (isRejection(error)) { const outcome = rejected('rejected', error instanceof Error && error.message ? error.message : 'The application rejected this action.'); await ledger.record(outcome); return json(outcome, 409); }
        options.onError?.(error);
        return json({ operationId: payload.operationId, inputHash: hash, status: 'unknown', error: { code: 'unknown', message: 'The application could not confirm the outcome.' } }, 500);
      }
    } catch (error) {
      if (error instanceof GroveError) return refuse(error.code, error.message, error.status);
      options.onError?.(error);
      return refuse('internal_error', 'The application could not handle the request', 500);
    }
  };
}
