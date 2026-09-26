import { createHash } from 'node:crypto';
import type { AdminActionInfo, AdminActionRequest, AdminColumn, AdminExecution, AdminInput, AdminModuleInfo, AdminPage, AdminRecord, AdminRecordView, AdminResourceInfo } from './admin-schema.js';
import type { Content } from './schema.js';
import type { Authorize, Context, Permission } from './service.js';
import type { Database, Row } from './database.js';
import { GroveError, requireCondition } from './errors.js';
import { canonical, contentValid, identifier, object, revision, scopeValid } from './validation.js';
import { scopeKeys, scopeSql } from './relationships.js';

/** Throw only when the adapter knows no effects committed (for example, a rolled-back transaction). */
export class AdminActionRejected extends Error { override readonly name = 'AdminActionRejected'; }
/** Modules built outside this package may not share its class identity; the name is the contract. */
export const isRejection = (error: unknown): boolean => error instanceof AdminActionRejected || (error instanceof Error && error.name === 'AdminActionRejected');

export type AdminPermission = `admin:${string}`;
export type AdminAction = AdminActionInfo & {
  permission: AdminPermission;
  /** Business-state availability, separate from authorization (also checked before execution). */
  available: (ctx: Context, record: AdminRecord) => boolean | Promise<boolean>;
  /** Must atomically enforce expectedVersion and domain rules; use operationId for provider idempotency. */
  execute: (ctx: Context, request: { record: AdminRecord; expectedVersion: number; values: Content; operationId: string }) => Promise<void>;
};
export type AdminResource = Omit<AdminResourceInfo, 'columns' | 'actions'> & {
  permission: AdminPermission;
  columns: (AdminColumn & { permission?: AdminPermission })[];
  actions: AdminAction[];
  /** Queries must apply actor/scope filters before pagination. Credentials belong in the adapter closure. */
  source: {
    query: (ctx: Context, request: { filters: Content; cursor: string | null; limit: number }) => Promise<{ records: AdminRecord[]; nextCursor: string | null }>;
    get: (ctx: Context, id: string) => Promise<AdminRecord | null>;
    /** Required second check before exposing each row or executing an action. */
    authorizeRecord: (ctx: Context, record: AdminRecord, operation: 'read' | string) => boolean | Promise<boolean>;
  };
};
export type AdminModule = Omit<AdminModuleInfo, 'resources'> & { resources: AdminResource[] };

export function fieldsValid(fields: AdminInput[]) {
  requireCondition(Array.isArray(fields) && fields.length <= 30, 'At most 30 input fields are supported');
  const names = new Set<string>();
  for (const field of fields) {
    identifier(field.name, 'Input name'); requireCondition(!names.has(field.name), 'Duplicate input field'); names.add(field.name);
    requireCondition(typeof field.label === 'string' && ['string', 'number', 'boolean'].includes(field.type), 'Invalid input definition');
    if (field.options) requireCondition(field.type === 'string' && field.options.length > 0 && field.options.every(o => typeof o.value === 'string' && typeof o.label === 'string'), 'Invalid input options');
  }
}
function validateInputs(fields: AdminInput[], input: Content) {
  contentValid(input);
  requireCondition(Object.keys(input).every(k => fields.some(f => f.name === k)), 'Unknown input field');
  for (const field of fields) {
    const value = input[field.name];
    const empty = value === undefined || value === null || (typeof value === 'string' && !value.trim());
    requireCondition(!field.required || !empty, `${field.label} is required`);
    if (empty) continue;
    requireCondition(typeof value === field.type, `${field.label} must be ${field.type}`);
    if (typeof value === 'string') requireCondition(value.length <= 2000, `${field.label} is too long`);
    if (field.options) requireCondition(field.options.some(o => o.value === value), `Choose a valid ${field.label.toLowerCase()}`);
  }
}
const execution = (r: Row): AdminExecution => ({ id: r.request_id, module: r.module_id, resource: r.resource_id, action: r.action_id, recordId: r.record_id, status: r.status, message: r.status === 'succeeded' ? 'Action completed.' : r.status === 'rejected' ? 'Action was rejected without applying changes. Reload the record and review it.' : r.status === 'running' ? 'Action is running. Check its result before trying again.' : 'The outcome could not be confirmed. An administrator must reconcile it before another attempt.', createdAt: new Date(r.created_at).toISOString(), completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null });

/** Independent of the CMS registry/document store. Only its action journal uses Grove's database. */
export class GroveAdmin {
  private modules: AdminModule[];
  constructor(private db: Database, private authorize: Authorize, modules: AdminModule[]) {
    const ids = new Set<string>();
    for (const module of modules) {
      identifier(module.id, 'Module'); requireCondition(!ids.has(module.id), 'Duplicate admin module'); ids.add(module.id);
      const resources = new Set<string>();
      for (const resource of module.resources) {
        identifier(resource.id, 'Resource'); requireCondition(!resources.has(resource.id), 'Duplicate resource'); resources.add(resource.id);
        requireCondition(resource.permission.startsWith(`admin:${module.id}:`), 'Resource permission must use its module namespace');
        fieldsValid(resource.filters);
        const columns = new Set<string>();
        requireCondition(resource.columns.length > 0 && resource.columns.length <= 50, 'Provide 1–50 columns');
        for (const col of resource.columns) { requireCondition(['text', 'number', 'boolean', 'status'].includes(col.type), 'Invalid column type'); identifier(col.name, 'Column'); requireCondition(!columns.has(col.name), 'Duplicate column'); columns.add(col.name); if (col.permission) requireCondition(col.permission.startsWith(`admin:${module.id}:`), 'Column permission must use its module namespace'); }
        const actions = new Set<string>();
        for (const action of resource.actions) {
          identifier(action.id, 'Action'); requireCondition(!actions.has(action.id), 'Duplicate action'); actions.add(action.id);
          requireCondition(action.permission.startsWith(`admin:${module.id}:`) && !!action.confirmation && !!action.description, 'Actions need a scoped permission, description and confirmation'); fieldsValid(action.inputs);
        }
        requireCondition(typeof resource.source.authorizeRecord === 'function', 'Provide record authorization');
      }
    }
    this.modules = modules;
  }
  private context(ctx: Context) { scopeValid(ctx.scope); if (!ctx.actor?.id?.trim()) throw new GroveError('unauthenticated', 'Authentication required'); }
  private async permitted(ctx: Context, permission: Permission) { this.context(ctx); return !!await this.authorize(ctx.actor, ctx.scope, permission); }
  private async allowed(ctx: Context, permission: Permission) { if (!await this.permitted(ctx, permission)) throw new GroveError('forbidden', 'This operation is not available to your account.'); }
  private async resource(ctx: Context, moduleId: string, resourceId: string) {
    this.context(ctx); identifier(moduleId, 'Module'); identifier(resourceId, 'Resource');
    const resource = this.modules.find(m => m.id === moduleId)?.resources.find(r => r.id === resourceId);
    if (!resource) throw new GroveError('not_found', 'Admin resource not found');
    await this.allowed(ctx, resource.permission); return resource;
  }
  private async columns(ctx: Context, resource: AdminResource) {
    const visible = await Promise.all(resource.columns.map(async c => !c.permission || await this.permitted(ctx, c.permission) ? c : null));
    return visible.filter((c): c is AdminResource['columns'][number] => !!c);
  }
  private async actions(ctx: Context, resource: AdminResource, record?: AdminRecord) {
    const allowed = await Promise.all(resource.actions.map(async action => await this.permitted(ctx, action.permission) && (!record || (await resource.source.authorizeRecord(ctx, record, action.id) && await action.available(ctx, record))) ? action : null));
    return allowed.filter((a): a is AdminAction => !!a);
  }
  async catalog(ctx: Context): Promise<AdminModuleInfo[]> {
    this.context(ctx); const result: AdminModuleInfo[] = [];
    for (const module of this.modules) {
      const resources: AdminResourceInfo[] = [];
      for (const resource of module.resources) {
        if (!await this.permitted(ctx, resource.permission)) continue;
        resources.push({ id: resource.id, label: resource.label, description: resource.description, filters: resource.filters.map(({ name, label, type, required, options }) => ({ name, label, type, required, options })), columns: (await this.columns(ctx, resource)).map(({ name, label, type }) => ({ name, label, type })), actions: (await this.actions(ctx, resource)).map(({ id, label, description, confirmation, inputs }) => ({ id, label, description, confirmation, inputs: inputs.map(({ name, label, type, required, options }) => ({ name, label, type, required, options })) })) });
      }
      if (resources.length) result.push({ id: module.id, label: module.label, description: module.description, resources });
    }
    return result;
  }
  private validRecord(record: AdminRecord) { identifier(record.id, 'Record'); revision(record.version, 'Record version'); contentValid(record.values); }
  private async find(ctx: Context, resource: AdminResource, id: string) {
    identifier(id, 'Record'); const record = await resource.source.get(ctx, id);
    if (!record) throw new GroveError('not_found', 'Record not found');
    this.validRecord(record); requireCondition(record.id === id, 'Adapter returned the wrong record');
    if (!await resource.source.authorizeRecord(ctx, record, 'read')) throw new GroveError('not_found', 'Record not found'); return record;
  }
  private async project(ctx: Context, resource: AdminResource, record: AdminRecord): Promise<AdminRecordView> {
    this.validRecord(record);
    const cols = await this.columns(ctx, resource);
    const values = Object.fromEntries(cols.map(c => {
      const value = record.values[c.name] ?? null;
      requireCondition(value === null || typeof value === (['text', 'status'].includes(c.type) ? 'string' : c.type), 'Adapter returned an invalid column value');
      return [c.name, value];
    }));
    return { id: record.id, version: record.version, values, actions: (await this.actions(ctx, resource, record)).map(a => a.id) };
  }
  async query(ctx: Context, module: string, id: string, input: { filters?: Content; cursor?: string | null; limit?: number } = {}): Promise<AdminPage> {
    const resource = await this.resource(ctx, module, id);
    requireCondition(object(input) && Object.keys(input).every(k => ['filters', 'cursor', 'limit'].includes(k)), 'Invalid query');
    const { filters = {}, cursor = null, limit = 30 } = input; validateInputs(resource.filters, filters);
    requireCondition((cursor === null || (typeof cursor === 'string' && cursor.length <= 500)) && Number.isInteger(limit) && limit > 0 && limit <= 100, 'Invalid pagination');
    const result = await resource.source.query(ctx, { filters, cursor, limit });
    requireCondition(Array.isArray(result.records) && result.records.length <= limit && (result.nextCursor === null || (typeof result.nextCursor === 'string' && result.nextCursor.length <= 500)), 'Invalid adapter page');
    const records: AdminRecordView[] = [];
    for (const record of result.records) if (await resource.source.authorizeRecord(ctx, record, 'read')) records.push(await this.project(ctx, resource, record));
    return { records, nextCursor: result.nextCursor };
  }
  async get(ctx: Context, module: string, id: string, recordId: string) { const resource = await this.resource(ctx, module, id); return this.project(ctx, resource, await this.find(ctx, resource, recordId)); }
  async run(ctx: Context, module: string, resourceId: string, actionId: string, input: AdminActionRequest): Promise<AdminExecution> {
    const resource = await this.resource(ctx, module, resourceId); identifier(actionId, 'Action');
    const action = resource.actions.find(a => a.id === actionId); if (!action) throw new GroveError('not_found', 'Action not found');
    await this.allowed(ctx, action.permission);
    requireCondition(object(input) && Object.keys(input).every(k => ['requestId', 'recordId', 'expectedVersion', 'values'].includes(k)), 'Invalid action request');
    identifier(input.requestId, 'Request id'); identifier(input.recordId, 'Record'); revision(input.expectedVersion); validateInputs(action.inputs, input.values);
    const record = await this.find(ctx, resource, input.recordId);
    if (!await resource.source.authorizeRecord(ctx, record, action.id)) throw new GroveError('forbidden', 'This action is not available for this record.');
    const hash = createHash('sha256').update(canonical({ module, resourceId, actionId, recordId: input.recordId, expectedVersion: input.expectedVersion, values: input.values })).digest('hex');
    const previous = await this.db.query(`SELECT * FROM grove_admin_actions WHERE ${scopeSql} AND actor_id=$4 AND request_id=$5`, [...scopeKeys(ctx.scope), ctx.actor.id, input.requestId]);
    if (previous[0]) { if (previous[0].input_hash !== hash) throw new GroveError('conflict', 'That request id was already used for a different action.'); return execution(previous[0]); }
    if (record.version !== input.expectedVersion) throw new GroveError('conflict', 'This record changed. Reload and review it before continuing.');
    if (!await action.available(ctx, record)) throw new GroveError('conflict', 'This action is no longer available. Reload the record.');
    // Unique request and active-target indexes serialize attempts without holding a DB transaction across external I/O.
    const [claim] = await this.db.query(`INSERT INTO grove_admin_actions (tenant_id,site_id,environment,actor_id,request_id,module_id,resource_id,action_id,record_id,input_hash,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running') ON CONFLICT DO NOTHING RETURNING *`, [...scopeKeys(ctx.scope), ctx.actor.id, input.requestId, module, resourceId, actionId, input.recordId, hash]);
    if (!claim) {
      const [existing] = await this.db.query(`SELECT * FROM grove_admin_actions WHERE ${scopeSql} AND actor_id=$4 AND request_id=$5`, [...scopeKeys(ctx.scope), ctx.actor.id, input.requestId]);
      if (existing && existing.input_hash === hash) return execution(existing);
      throw new GroveError('conflict', 'An action is already running or needs reconciliation for this record. Check recent activity.');
    }
    try {
      await action.execute(ctx, { record, expectedVersion: input.expectedVersion, values: input.values, operationId: createHash('sha256').update(JSON.stringify([...scopeKeys(ctx.scope), ctx.actor.id, input.requestId])).digest('hex') });
    } catch (error) {
      const [uncertain] = await this.db.query(`UPDATE grove_admin_actions SET status=$6,completed_at=now() WHERE ${scopeSql} AND actor_id=$4 AND request_id=$5 RETURNING *`, [...scopeKeys(ctx.scope), ctx.actor.id, input.requestId, isRejection(error) ? 'rejected' : 'uncertain']);
      return execution(uncertain!);
    }
    const [complete] = await this.db.query(`UPDATE grove_admin_actions SET status='succeeded',completed_at=now() WHERE ${scopeSql} AND actor_id=$4 AND request_id=$5 RETURNING *`, [...scopeKeys(ctx.scope), ctx.actor.id, input.requestId]);
    return execution(complete!);
  }
  async activity(ctx: Context, module: string, resourceId: string): Promise<AdminExecution[]> {
    const resource = await this.resource(ctx, module, resourceId);
    const rows = await this.db.query(`SELECT * FROM grove_admin_actions WHERE ${scopeSql} AND actor_id=$4 AND module_id=$5 AND resource_id=$6 ORDER BY created_at DESC,request_id DESC LIMIT 50`, [...scopeKeys(ctx.scope), ctx.actor.id, module, resourceId]);
    const result: AdminExecution[] = [];
    for (const row of rows) {
      const action = resource.actions.find(a => a.id === row.action_id);
      if (!action || !await this.permitted(ctx, action.permission)) continue;
      const record = await resource.source.get(ctx, row.record_id);
      if (record && await resource.source.authorizeRecord(ctx, record, 'read') && await resource.source.authorizeRecord(ctx, record, action.id)) result.push(execution(row));
    }
    return result;
  }
}
