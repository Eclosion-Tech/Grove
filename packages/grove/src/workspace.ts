import type { Grove } from './service.js';
import type { Context } from './service.js';
import type { Connections } from './connections.js';
import type { WorkspaceConfig, WorkspaceConfigResult } from './schema.js';
import { GroveError, requireCondition } from './errors.js';
import { object } from './validation.js';

export type WorkspaceConfigRequest = WorkspaceConfig & { expectedSchemaVersion?: number; allowBreaking?: boolean; dryRun?: boolean };

/**
 * Applies a declarative workspace configuration pushed from the client repository: schema, remote module connections and
 * role grants. Each part is authorized by its own service. Omitting a part leaves it untouched; connections listed here are
 * registered or re-registered, never removed. A dry run reports the plan without writing.
 */
export async function applyWorkspaceConfig(ctx: Context, deps: { grove: Grove; connections?: Connections }, input: WorkspaceConfigRequest): Promise<WorkspaceConfigResult> {
  requireCondition(object(input) && input.formatVersion === 1, 'Unsupported workspace config format; expected formatVersion 1');
  const dryRun = input.dryRun === true;
  const result: WorkspaceConfigResult = { applied: !dryRun, schema: null, connections: [], roleGrants: null };
  if (input.schema !== undefined) {
    requireCondition(Number.isInteger(input.expectedSchemaVersion), 'Provide expectedSchemaVersion when the config includes a schema');
    result.schema = await deps.grove.pushSchema(ctx, input.schema, input.expectedSchemaVersion!, { dryRun, allowBreaking: input.allowBreaking === true });
  }
  if (input.roleGrants !== undefined) {
    if (dryRun) {
      const current = await deps.grove.members.roleGrants(ctx);
      const roles = ['developer', 'publisher', 'editor', 'viewer'] as const;
      requireCondition(object(input.roleGrants) && Object.keys(input.roleGrants).every(k => (roles as readonly string[]).includes(k)), 'Role grants may only name developer, publisher, editor or viewer');
      const normalize = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(String))].sort() : [];
      result.roleGrants = { changed: roles.some(r => JSON.stringify(normalize(current[r])) !== JSON.stringify(normalize(input.roleGrants![r]))) };
    } else result.roleGrants = { changed: (await deps.grove.members.setRoleGrants(ctx, input.roleGrants)).changed };
  }
  if (input.connections !== undefined) {
    requireCondition(Array.isArray(input.connections) && input.connections.length <= 50, 'Provide up to 50 connections');
    if (!deps.connections) throw new GroveError('invalid_request', 'This host does not support remote module connections');
    const existing = dryRun ? await deps.connections.list(ctx) : [];
    for (const item of input.connections) {
      requireCondition(object(item) && typeof item.id === 'string' && typeof item.endpoint === 'string', 'Each connection needs an id and endpoint');
      if (dryRun) { const found = existing.find(c => c.id === item.id); result.connections.push({ id: item.id, status: found && found.endpoint === item.endpoint.replace(/\/+$/, '') ? 'unchanged' : 'registered' }); continue; }
      try { const registered = await deps.connections.register(ctx, { id: item.id, endpoint: item.endpoint }); result.connections.push({ id: item.id, status: registered.changed ? 'registered' : 'unchanged' }); }
      catch (error) { if (error instanceof GroveError && error.code === 'forbidden') throw error; result.connections.push({ id: item.id, status: 'failed', reason: error instanceof GroveError ? error.message : 'The connection could not be registered.' }); }
    }
  }
  return result;
}
