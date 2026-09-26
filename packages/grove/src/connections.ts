import type { Database, Row } from './database.js';
import type { AdminModule } from './admin.js';
import type { Connection, ConnectionInput, Scope } from './schema.js';
import type { Authorize, Context, Permission } from './service.js';
import { GroveError, requireCondition } from './errors.js';
import { identifier, object, scopeValid } from './validation.js';
import { scopeKeys, scopeSql } from './relationships.js';
import { remoteModule, validateEndpoint } from './remote.js';
import type { InstanceKeys } from './signing.js';

type Guard = (ctx: Context, permission: Permission) => Promise<void>;
const connection = (r: Row): Connection => ({ id: r.id, endpoint: r.endpoint, moduleId: r.module_id, label: r.label, catalogRevision: r.catalog_revision, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() });

export type ConnectionsOptions = {
  keys: InstanceKeys;
  /** This Grove instance's identity as applications see it, normally the public origin. */
  hostId: string;
  authorize: Authorize;
  fetcher?: typeof fetch;
  allowLoopback?: boolean;
  onError?: (error: unknown) => void;
};

/** Registered remote modules per workspace. Registering performs the catalog handshake and pins the catalog revision. */
export class Connections {
  constructor(private db: Database, private guard: Guard, private options: ConnectionsOptions) {}
  private async handshake(scope: Scope, id: string, endpoint: string): Promise<AdminModule> {
    return remoteModule({ connection: { id, endpoint, hostId: this.options.hostId }, key: await this.options.keys.current(), authorize: this.options.authorize, fetcher: this.options.fetcher, allowLoopback: this.options.allowLoopback, onError: this.options.onError });
  }
  async list(ctx: Context): Promise<Connection[]> {
    await this.guard(ctx, 'connections:read');
    return (await this.db.query(`SELECT * FROM grove_connections WHERE ${scopeSql} ORDER BY id`, scopeKeys(ctx.scope))).map(connection);
  }
  /** Registers or re-registers a connection after a successful catalog handshake. */
  async register(ctx: Context, input: ConnectionInput): Promise<Connection & { changed: boolean }> {
    await this.guard(ctx, 'connections:write');
    requireCondition(object(input), 'Provide a connection id and endpoint');
    identifier(input.id, 'Connection id');
    const endpoint = validateEndpoint(input.endpoint, this.options.allowLoopback);
    let module: AdminModule;
    try { module = await this.handshake(ctx.scope, input.id, endpoint); }
    catch (error) { if (error instanceof GroveError) throw error; this.options.onError?.(error); throw new GroveError('invalid_request', `The module at that endpoint could not be loaded${error instanceof Error && error.message ? `: ${error.message}` : ''}`); }
    const revision = (module as AdminModule & { catalogRevision?: string }).catalogRevision ?? '';
    const [existing] = await this.db.query(`SELECT * FROM grove_connections WHERE ${scopeSql} AND id = $4`, [...scopeKeys(ctx.scope), input.id]);
    const changed = !existing || existing.endpoint !== endpoint || existing.catalog_revision !== revision || existing.module_id !== module.id;
    const [row] = await this.db.query(`INSERT INTO grove_connections (tenant_id,site_id,environment,id,endpoint,module_id,label,catalog_revision,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (tenant_id,site_id,environment,id) DO UPDATE SET endpoint = EXCLUDED.endpoint, module_id = EXCLUDED.module_id, label = EXCLUDED.label, catalog_revision = EXCLUDED.catalog_revision, updated_at = CASE WHEN grove_connections.endpoint <> EXCLUDED.endpoint OR grove_connections.catalog_revision <> EXCLUDED.catalog_revision OR grove_connections.module_id <> EXCLUDED.module_id THEN now() ELSE grove_connections.updated_at END RETURNING *`,
      [...scopeKeys(ctx.scope), input.id, endpoint, module.id, module.label, revision, ctx.actor.id]);
    return { ...connection(row!), changed };
  }
  async remove(ctx: Context, id: string): Promise<void> {
    await this.guard(ctx, 'connections:write');
    identifier(id, 'Connection id');
    const rows = await this.db.query(`DELETE FROM grove_connections WHERE ${scopeSql} AND id = $4 RETURNING id`, [...scopeKeys(ctx.scope), id]);
    if (!rows.length) throw new GroveError('not_found', 'Connection not found');
  }
  /** Host-only: a fingerprint of the workspace's connections, so a host can cache loaded modules until something changes. */
  async fingerprint(scope: Scope): Promise<string> {
    scopeValid(scope);
    const [row] = await this.db.query(`SELECT coalesce(string_agg(id || '@' || catalog_revision || '@' || endpoint, '|' ORDER BY id), '') AS fingerprint FROM grove_connections WHERE ${scopeSql}`, scopeKeys(scope));
    return row!.fingerprint;
  }
  /** Host-only: loads every registered connection as an AdminModule. A connection whose catalog changed is skipped and reported. */
  async modules(scope: Scope): Promise<{ modules: AdminModule[]; failed: { id: string; reason: string }[] }> {
    scopeValid(scope);
    const rows = await this.db.query(`SELECT * FROM grove_connections WHERE ${scopeSql} ORDER BY id`, scopeKeys(scope));
    const modules: AdminModule[] = []; const failed: { id: string; reason: string }[] = [];
    for (const row of rows) {
      try {
        const module = await this.handshake(scope, row.id, row.endpoint);
        const revision = (module as AdminModule & { catalogRevision?: string }).catalogRevision;
        if (revision !== row.catalog_revision) { failed.push({ id: row.id, reason: 'The module contract changed since it was registered. Re-register the connection to review it.' }); continue; }
        if (module.id !== row.module_id) { failed.push({ id: row.id, reason: 'The endpoint now serves a different module.' }); continue; }
        modules.push(module);
      } catch (error) { this.options.onError?.(error); failed.push({ id: row.id, reason: 'The module could not be loaded.' }); }
    }
    return { modules, failed };
  }
}
