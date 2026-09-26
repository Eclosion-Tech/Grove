import { randomUUID } from 'node:crypto';
import type { Database, Queryable, Row } from './database.js';
import type { Member, MemberInput, MemberRole, RoleGrants, Scope } from './schema.js';
import type { Actor, Context, Permission } from './service.js';
import { GroveError, requireCondition } from './errors.js';
import { identifier, scopeValid } from './validation.js';
import { scopeKeys, scopeSql } from './relationships.js';

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'developer', 'publisher', 'editor', 'viewer'];
const read: Permission[] = ['schema:read', 'content:read', 'media:read', 'delivery:read'];
const edit: Permission[] = [...read, 'content:edit', 'media:write'];
const publish: Permission[] = [...edit, 'content:publish', 'media:delete'];
/** CMS capabilities by role. Application-module permissions (admin:*) are granted per member; owners hold every permission. */
export const rolePermissions: Record<MemberRole, readonly Permission[]> = {
  viewer: read,
  editor: edit,
  publisher: publish,
  developer: [...publish, 'schema:write', 'members:read', 'connections:read'],
  owner: [...publish, 'schema:write', 'members:read', 'members:write'],
};
export function permits(member: Pick<Member, 'role' | 'permissions'>, permission: Permission, roleGrants: string[] = []): boolean {
  if (member.role === 'owner') return true;
  return rolePermissions[member.role].includes(permission) || (permission.startsWith('admin:') && (member.permissions.includes(permission) || roleGrants.includes(permission)));
}

type Guard = (ctx: Context, permission: Permission) => Promise<void>;
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const member = (r: Row): Member => ({
  id: r.id, email: r.email, subject: r.subject, role: r.role, permissions: r.permissions,
  createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, acceptedAt: iso(r.accepted_at),
});
const address = (value: unknown): string => {
  requireCondition(typeof value === 'string' && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()), 'Provide a valid email address');
  return value.trim().toLowerCase();
};
const role = (value: unknown): MemberRole => {
  requireCondition(typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value), `Role must be one of ${MEMBER_ROLES.join(', ')}`);
  return value as MemberRole;
};
const grants = (value: unknown): string[] => {
  if (value === undefined) return [];
  requireCondition(Array.isArray(value) && value.length <= 100 && value.every(p => typeof p === 'string' && /^admin:[a-z0-9-]+(:[a-z0-9-]+)+$/.test(p)), 'Extra permissions must be admin:<module>:<capability> names');
  return [...new Set(value as string[])].sort();
};
const lock = (tx: Queryable, scope: Scope) => tx.query('SELECT pg_advisory_xact_lock(718303, hashtext($1))', [JSON.stringify(scopeKeys(scope))]);

/** Developer-defined workspace membership. Identity comes from the host; Grove decides what each member may do. */
export class Members {
  constructor(private db: Database, private guard: Guard) {}
  private async row(tx: Queryable, scope: Scope, id: string): Promise<Row> {
    identifier(id, 'Member id');
    const [row] = await tx.query(`SELECT * FROM grove_members WHERE ${scopeSql} AND id = $4 FOR UPDATE`, [...scopeKeys(scope), id]);
    if (!row) throw new GroveError('not_found', 'Member not found');
    return row;
  }
  /** Owners who have signed in. A pending owner invitation cannot keep a workspace reachable, so it never counts. */
  private async otherOwners(tx: Queryable, scope: Scope, id: string): Promise<number> {
    const [row] = await tx.query(`SELECT count(*)::int AS n FROM grove_members WHERE ${scopeSql} AND role = 'owner' AND subject IS NOT NULL AND id <> $4`, [...scopeKeys(scope), id]);
    return row!.n;
  }
  private async lastOwner(tx: Queryable, scope: Scope, current: Row): Promise<boolean> {
    return current.role === 'owner' && current.subject !== null && await this.otherOwners(tx, scope, current.id) === 0;
  }
  async list(ctx: Context): Promise<Member[]> {
    await this.guard(ctx, 'members:read');
    return (await this.db.query(`SELECT * FROM grove_members WHERE ${scopeSql} ORDER BY created_at, id`, scopeKeys(ctx.scope))).map(member);
  }
  async invite(ctx: Context, input: MemberInput): Promise<Member> {
    await this.guard(ctx, 'members:write');
    requireCondition(input && typeof input === 'object', 'Provide an email address and role');
    const value = { email: address(input.email), role: role(input.role), permissions: grants(input.permissions) };
    return this.db.transaction(async tx => {
      await lock(tx, ctx.scope);
      const [existing] = await tx.query(`SELECT id FROM grove_members WHERE ${scopeSql} AND email = $4`, [...scopeKeys(ctx.scope), value.email]);
      if (existing) throw new GroveError('conflict', 'That email address is already a member of this workspace');
      const [row] = await tx.query(`INSERT INTO grove_members (tenant_id,site_id,environment,id,email,role,permissions,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
        [...scopeKeys(ctx.scope), randomUUID(), value.email, value.role, value.permissions, ctx.actor.id]);
      return member(row!);
    });
  }
  async update(ctx: Context, id: string, input: Partial<Pick<MemberInput, 'role' | 'permissions'>>): Promise<Member> {
    await this.guard(ctx, 'members:write');
    requireCondition(input && typeof input === 'object' && (input.role !== undefined || input.permissions !== undefined), 'Provide a role or permissions to change');
    return this.db.transaction(async tx => {
      await lock(tx, ctx.scope);
      const current = await this.row(tx, ctx.scope, id);
      const next = { role: input.role === undefined ? current.role as MemberRole : role(input.role), permissions: input.permissions === undefined ? current.permissions as string[] : grants(input.permissions) };
      if (next.role !== 'owner' && await this.lastOwner(tx, ctx.scope, current)) throw new GroveError('conflict', 'Keep at least one signed-in owner in this workspace');
      const [row] = await tx.query(`UPDATE grove_members SET role = $5, permissions = $6::jsonb, updated_at = now() WHERE ${scopeSql} AND id = $4 RETURNING *`, [...scopeKeys(ctx.scope), id, next.role, next.permissions]);
      return member(row!);
    });
  }
  async remove(ctx: Context, id: string): Promise<void> {
    await this.guard(ctx, 'members:write');
    await this.db.transaction(async tx => {
      await lock(tx, ctx.scope);
      const current = await this.row(tx, ctx.scope, id);
      if (await this.lastOwner(tx, ctx.scope, current)) throw new GroveError('conflict', 'Keep at least one signed-in owner in this workspace');
      await tx.query(`DELETE FROM grove_members WHERE ${scopeSql} AND id = $4`, [...scopeKeys(ctx.scope), id]);
    });
  }
  /** Host-only. The host must have verified this identity with its provider. Binds a pending invitation to its subject on first verified sign-in. */
  async resolve(scope: Scope, identity: { subject: string; email: string; emailVerified: boolean }): Promise<Member | null> {
    scopeValid(scope);
    identifier(identity.subject, 'Subject');
    if (identity.emailVerified !== true) return null;
    let email: string;
    try { email = address(identity.email); } catch { return null; }
    return this.db.transaction(async tx => {
      await lock(tx, scope);
      const [bySubject] = await tx.query(`SELECT * FROM grove_members WHERE ${scopeSql} AND subject = $4`, [...scopeKeys(scope), identity.subject]);
      if (bySubject) return member(bySubject);
      const [bound] = await tx.query(`UPDATE grove_members SET subject = $4, accepted_at = now(), updated_at = now() WHERE ${scopeSql} AND email = $5 AND subject IS NULL RETURNING *`, [...scopeKeys(scope), identity.subject, email]);
      return bound ? member(bound) : null;
    });
  }
  /** Host-only: the current membership of a signed-in subject, or null once it has been removed. */
  async membership(scope: Scope, subject: string): Promise<Member | null> {
    scopeValid(scope);
    if (typeof subject !== 'string' || !subject) return null;
    const [row] = await this.db.query(`SELECT * FROM grove_members WHERE ${scopeSql} AND subject = $4`, [...scopeKeys(scope), subject]);
    return row ? member(row) : null;
  }
  /** Host-only: the membership or pending invitation for an email address in this workspace. */
  async byEmail(scope: Scope, email: unknown): Promise<Member | null> {
    scopeValid(scope);
    let value: string;
    try { value = address(email); } catch { return null; }
    const [row] = await this.db.query(`SELECT * FROM grove_members WHERE ${scopeSql} AND email = $4`, [...scopeKeys(scope), value]);
    return row ? member(row) : null;
  }
  /** Workspace-level application grants per role, set by owners so module permissions need not be granted person by person. */
  async roleGrants(ctx: Context): Promise<RoleGrants> {
    await this.guard(ctx, 'members:read');
    const rows = await this.db.query(`SELECT role, permissions FROM grove_role_grants WHERE ${scopeSql}`, scopeKeys(ctx.scope));
    return Object.fromEntries(rows.map(r => [r.role, r.permissions])) as RoleGrants;
  }
  /** Replaces the workspace's role grants as a whole. Returns whether anything changed. */
  async setRoleGrants(ctx: Context, input: RoleGrants): Promise<{ grants: RoleGrants; changed: boolean }> {
    await this.guard(ctx, 'members:write');
    requireCondition(input && typeof input === 'object' && !Array.isArray(input), 'Provide role grants as an object');
    const roles = ['developer', 'publisher', 'editor', 'viewer'] as const;
    requireCondition(Object.keys(input).every(k => (roles as readonly string[]).includes(k)), 'Role grants may only name developer, publisher, editor or viewer');
    const next = Object.fromEntries(roles.map(r => [r, grants(input[r] ?? [])])) as Record<typeof roles[number], string[]>;
    return this.db.transaction(async tx => {
      await lock(tx, ctx.scope);
      const before = await tx.query(`SELECT role, permissions FROM grove_role_grants WHERE ${scopeSql}`, scopeKeys(ctx.scope));
      const previous = Object.fromEntries(roles.map(r => [r, (before.find(b => b.role === r)?.permissions as string[] | undefined) ?? []]));
      const changed = roles.some(r => JSON.stringify(previous[r]) !== JSON.stringify(next[r]));
      for (const r of roles) {
        if (next[r].length) await tx.query(`INSERT INTO grove_role_grants (tenant_id,site_id,environment,role,permissions,updated_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (tenant_id,site_id,environment,role) DO UPDATE SET permissions = EXCLUDED.permissions, updated_by = EXCLUDED.updated_by, updated_at = now()`, [...scopeKeys(ctx.scope), r, next[r], ctx.actor.id]);
        else await tx.query(`DELETE FROM grove_role_grants WHERE ${scopeSql} AND role = $4`, [...scopeKeys(ctx.scope), r]);
      }
      return { grants: Object.fromEntries(roles.filter(r => next[r].length).map(r => [r, next[r]])) as RoleGrants, changed };
    });
  }
  /** Authorize callback for hosts: a member holds the permissions of their role, the workspace's grants for that role, and explicit personal grants. */
  async authorize(actor: Actor, scope: Scope, permission: Permission): Promise<boolean> {
    scopeValid(scope);
    if (!actor || typeof actor.id !== 'string' || !actor.id) return false;
    const [row] = await this.db.query(`SELECT m.role, m.permissions, coalesce(g.permissions, '[]'::jsonb) AS role_grants FROM grove_members m LEFT JOIN grove_role_grants g ON g.tenant_id = m.tenant_id AND g.site_id = m.site_id AND g.environment = m.environment AND g.role = m.role WHERE m.tenant_id = $1 AND m.site_id = $2 AND m.environment = $3 AND m.subject = $4`, [...scopeKeys(scope), actor.id]);
    return !!row && permits({ role: row.role, permissions: row.permissions }, permission, row.role_grants);
  }
}
