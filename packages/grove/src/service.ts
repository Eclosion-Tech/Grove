import type { Content, DeliveredDocument, Document, HistoryEntry, SaveInput, Schema, SchemaRecord, Scope } from './schema.js';
import type { Database, Queryable, Row } from './database.js';
import { GroveError, requireCondition } from './errors.js';
import { canonical, contentValid, identifier, projectContent, revision, schemaDiff, schemaValid, scopeValid, validateContent } from './validation.js';
import { indexLinks, protectReferenced, usages } from './relationships.js';
import { MediaLibrary } from './media.js';
import { Members } from './members.js';
import type { StorageAdapter } from './storage.js';

export type Permission = `admin:${string}` | 'schema:read' | 'schema:write' | 'content:read' | 'content:edit' | 'content:publish' | 'delivery:read' | 'media:read' | 'media:write' | 'media:delete' | 'members:read' | 'members:write';
export type Actor = { id: string };
export type Context = { actor: Actor; scope: Scope };
export type Authorize = (actor: Actor, scope: Scope, permission: Permission) => boolean | Promise<boolean>;
const keys = (scope: Scope) => [scope.tenantId, scope.siteId, scope.environment];
const scoped = 'tenant_id = $1 AND site_id = $2 AND environment = $3';
const iso = (v: Date | string | null) => v === null ? null : new Date(v).toISOString();
const document = (r: Row): Document => ({
  id: r.id, type: r.type, revision: r.revision, schemaVersion: r.schema_version,
  draft: r.draft, published: r.published, publishedRevision: r.published_revision,
  publishedSchemaVersion: r.published_schema_version, publishedAt: iso(r.published_at),
  updatedAt: iso(r.updated_at)!, updatedBy: r.updated_by,
});

export class Grove {
  readonly media: MediaLibrary;
  readonly members: Members;
  constructor(private readonly db: Database, private readonly authorize: Authorize, options: { storage?: StorageAdapter } = {}) {
    this.media = new MediaLibrary(db, options.storage, this.allowed.bind(this), this.mutate.bind(this));
    this.members = new Members(db, this.allowed.bind(this));
  }

  private async allowed(ctx: Context, permission: Permission): Promise<void> {
    scopeValid(ctx.scope);
    if (!ctx.actor || typeof ctx.actor.id !== 'string' || !ctx.actor.id.trim()) throw new GroveError('unauthenticated', 'An authenticated actor is required');
    if (!await this.authorize(ctx.actor, ctx.scope, permission)) throw new GroveError('forbidden', `Missing ${permission} permission for this scope`);
  }
  private async mutate<T>(ctx: Context, permission: Permission, work: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.allowed(ctx, permission);
    return this.db.transaction(async tx => {
      // One lock per tenant/site/environment keeps schema changes and document writes ordered.
      // Hash collisions only serialize unrelated scopes; all queries still use the full scope.
      await tx.query('SELECT pg_advisory_xact_lock(718302, hashtext($1))', [JSON.stringify(keys(ctx.scope))]);
      return work(tx);
    });
  }
  private async registry(tx: Queryable, scope: Scope): Promise<SchemaRecord | null> {
    const [row] = await tx.query(`SELECT version, definition FROM grove_schema_versions WHERE ${scoped} ORDER BY version DESC LIMIT 1`, keys(scope));
    return row ? { version: row.version, definition: row.definition } : null;
  }
  private async requiredRegistry(tx: Queryable, scope: Scope, expected?: number): Promise<SchemaRecord> {
    const registry = await this.registry(tx, scope);
    if (!registry) throw new GroveError('not_found', 'Push a schema before creating content');
    if (expected !== undefined && registry.version !== expected) throw new GroveError('conflict', 'Schema changed; reload the registry and review your changes', { currentSchemaVersion: registry.version });
    return registry;
  }
  async getSchema(ctx: Context): Promise<SchemaRecord | null> {
    await this.allowed(ctx, 'schema:read');
    return this.registry(this.db, ctx.scope);
  }
  async pushSchema(ctx: Context, definition: Schema, expectedVersion: number, options: { dryRun?: boolean; allowBreaking?: boolean } = {}) {
    schemaValid(definition);
    revision(expectedVersion, 'expectedVersion');
    return this.mutate(ctx, 'schema:write', async tx => {
      const current = await this.registry(tx, ctx.scope);
      if ((current?.version ?? 0) !== expectedVersion) throw new GroveError('conflict', 'Schema registry changed', { currentSchemaVersion: current?.version ?? 0 });
      const changes = schemaDiff(current?.definition ?? null, definition);
      const changed = canonical(current?.definition) !== canonical(definition);
      const version = changed ? expectedVersion + 1 : expectedVersion;
      if (options.dryRun || !changed) return { version, changes, applied: false };
      requireCondition(options.allowBreaking || !changes.some(c => c.breaking), 'Breaking schema changes require allowBreaking after reviewing the diff');
      await tx.query(`INSERT INTO grove_schema_versions (tenant_id, site_id, environment, version, definition, actor_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [...keys(ctx.scope), version, definition, ctx.actor.id]);
      return { version, changes, applied: true };
    });
  }
  private async find(tx: Queryable, scope: Scope, id: string): Promise<Document | null> {
    identifier(id, 'Document id');
    const [row] = await tx.query(`SELECT * FROM grove_documents WHERE ${scoped} AND id = $4`, [...keys(scope), id]);
    return row ? document(row) : null;
  }
  private async requireDocument(tx: Queryable, scope: Scope, id: string, expected?: number): Promise<Document> {
    const doc = await this.find(tx, scope, id);
    if (!doc) throw new GroveError('not_found', 'Document not found');
    if (expected !== undefined && doc.revision !== expected) throw new GroveError('conflict', 'Document changed; reload before saving', { currentRevision: doc.revision });
    return doc;
  }
  private async snapshot(tx: Queryable, ctx: Context, doc: Document, action: HistoryEntry['action']): Promise<void> {
    await tx.query(`INSERT INTO grove_document_history (tenant_id, site_id, environment, document_id, revision, schema_version, data, action, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [...keys(ctx.scope), doc.id, doc.revision, doc.schemaVersion, doc.draft, action, ctx.actor.id]);
  }
  async getDocument(ctx: Context, id: string): Promise<Document> {
    await this.allowed(ctx, 'content:read');
    return this.requireDocument(this.db, ctx.scope, id);
  }
  async listDocuments(ctx: Context, options: { type?: string; after?: string; limit?: number; search?: string } = {}): Promise<Document[]> {
    await this.allowed(ctx, 'content:read');
    const { type, after = '', limit = 50, search = '' } = options;
    requireCondition(typeof search === 'string' && search.length <= 200, 'Search must be at most 200 characters');
    requireCondition(Number.isInteger(limit) && limit > 0 && limit <= 100, 'limit must be 1–100');
    return (await this.db.query(`SELECT * FROM grove_documents WHERE ${scoped} AND ($4::text IS NULL OR type = $4) AND id > $5 AND (strpos(lower(COALESCE(draft->>'title','')),lower($7))>0 OR strpos(lower(id),lower($7))>0) ORDER BY id LIMIT $6`, [...keys(ctx.scope), type ?? null, after, limit, search])).map(document);
  }
  async saveDocument(ctx: Context, id: string, input: SaveInput): Promise<Document> {
    identifier(id, 'Document id');
    identifier(input.type, 'Content type');
    revision(input.expectedRevision);
    revision(input.expectedSchemaVersion, 'expectedSchemaVersion');
    contentValid(input.data);
    return this.mutate(ctx, 'content:edit', async tx => {
      const registry = await this.requiredRegistry(tx, ctx.scope, input.expectedSchemaVersion);
      const type = registry.definition.types.find(t => t.name === input.type);
      requireCondition(type, 'Unknown content type');
      for (const field of Object.keys(input.data)) requireCondition(type.fields.some(f => f.name === field), `Unknown field ${field}`);
      const old = await this.find(tx, ctx.scope, id);
      if ((old?.revision ?? 0) !== input.expectedRevision) throw new GroveError('conflict', 'Document changed; reload before saving', { currentRevision: old?.revision ?? 0 });
      requireCondition(!old || old.type === input.type, 'Document type cannot be changed');
      const defaults = Object.fromEntries(type.fields.filter(f => f.default !== undefined).map(f => [f.name, f.default!]));
      const data = { ...(old?.draft ?? defaults), ...input.data };
      validateContent(type, data, registry.definition, false);
      const [row] = await tx.query(`INSERT INTO grove_documents (tenant_id,site_id,environment,id,type,revision,schema_version,draft,updated_by)
        VALUES ($1,$2,$3,$4,$5,1,$6,$7::jsonb,$8)
        ON CONFLICT (tenant_id,site_id,environment,id) DO UPDATE SET revision = grove_documents.revision + 1, schema_version = EXCLUDED.schema_version, draft = EXCLUDED.draft, updated_at = now(), updated_by = EXCLUDED.updated_by RETURNING *`,
      [...keys(ctx.scope), id, input.type, registry.version, data, ctx.actor.id]);
      const saved = document(row!);
      await indexLinks(tx, ctx.scope, id, saved.type, 'draft', projectContent(type, saved.draft));
      await this.snapshot(tx, ctx, saved, old ? 'save' : 'create');
      return saved;
    });
  }
  async publish(ctx: Context, id: string, expectedRevision: number): Promise<Document> {
    revision(expectedRevision);
    return this.mutate(ctx, 'content:publish', async tx => {
      const doc = await this.requireDocument(tx, ctx.scope, id, expectedRevision);
      const registry = await this.requiredRegistry(tx, ctx.scope, doc.schemaVersion);
      const type = registry.definition.types.find(t => t.name === doc.type);
      requireCondition(type, 'Content type no longer exists');
      validateContent(type, doc.draft, registry.definition, true);
      const [row] = await tx.query(`UPDATE grove_documents SET revision = revision + 1, published = $5::jsonb, published_revision = revision + 1, published_schema_version = schema_version, published_at = now(), updated_at = now(), updated_by = $6 WHERE ${scoped} AND id = $4 RETURNING *`, [...keys(ctx.scope), id, projectContent(type, doc.draft), ctx.actor.id]);
      const saved = document(row!);
      await indexLinks(tx, ctx.scope, id, saved.type, 'published', saved.published!);
      await this.snapshot(tx, ctx, saved, 'publish');
      return saved;
    });
  }
  async unpublish(ctx: Context, id: string, expectedRevision: number): Promise<Document> {
    revision(expectedRevision);
    return this.mutate(ctx, 'content:publish', async tx => {
      await this.requireDocument(tx, ctx.scope, id, expectedRevision);
      await protectReferenced(tx, ctx.scope, 'document', id, true);
      const [row] = await tx.query(`UPDATE grove_documents SET revision = revision + 1, published = NULL, published_revision = NULL, published_schema_version = NULL, published_at = NULL, updated_at = now(), updated_by = $5 WHERE ${scoped} AND id = $4 RETURNING *`, [...keys(ctx.scope), id, ctx.actor.id]);
      const saved = document(row!);
      await tx.query(`DELETE FROM grove_relationships WHERE ${scoped} AND source_id=$4 AND channel='published'`, [...keys(ctx.scope), id]);
      await this.snapshot(tx, ctx, saved, 'unpublish');
      return saved;
    });
  }
  async history(ctx: Context, id: string, options: { before?: number; limit?: number } = {}): Promise<HistoryEntry[]> {
    await this.allowed(ctx, 'content:read');
    await this.requireDocument(this.db, ctx.scope, id);
    const { before = 2_147_483_647, limit = 50 } = options;
    revision(before, 'before');
    requireCondition(Number.isInteger(limit) && limit > 0 && limit <= 100, 'limit must be 1–100');
    return (await this.db.query(`SELECT * FROM grove_document_history WHERE ${scoped} AND document_id = $4 AND revision < $5 ORDER BY revision DESC LIMIT $6`, [...keys(ctx.scope), id, before, limit]))
      .map(r => ({ revision: r.revision, schemaVersion: r.schema_version, data: r.data, action: r.action, actorId: r.actor_id, createdAt: iso(r.created_at)! }));
  }
  async restore(ctx: Context, id: string, targetRevision: number, expectedRevision: number): Promise<Document> {
    revision(targetRevision, 'targetRevision');
    revision(expectedRevision);
    return this.mutate(ctx, 'content:edit', async tx => {
      const doc = await this.requireDocument(tx, ctx.scope, id, expectedRevision);
      const registry = await this.requiredRegistry(tx, ctx.scope);
      const [snapshot] = await tx.query(`SELECT data FROM grove_document_history WHERE ${scoped} AND document_id = $4 AND revision = $5`, [...keys(ctx.scope), id, targetRevision]);
      if (!snapshot) throw new GroveError('not_found', 'History revision not found');
      const type = registry.definition.types.find(t => t.name === doc.type);
      requireCondition(type, 'Content type no longer exists');
      // Restores obey today's schema. Old data is retained, but removed fields stay hidden on publication.
      validateContent(type, snapshot.data, registry.definition, false);
      const [row] = await tx.query(`UPDATE grove_documents SET revision = revision + 1, draft = $5::jsonb, schema_version = $6, updated_at = now(), updated_by = $7 WHERE ${scoped} AND id = $4 RETURNING *`, [...keys(ctx.scope), id, snapshot.data, registry.version, ctx.actor.id]);
      const saved = document(row!);
      await indexLinks(tx, ctx.scope, id, saved.type, 'draft', projectContent(type, saved.draft));
      await this.snapshot(tx, ctx, saved, 'restore');
      return saved;
    });
  }
  async whereUsed(ctx: Context, id: string, offset = 0) {
    await this.allowed(ctx, 'content:read'); await this.requireDocument(this.db, ctx.scope, id);
    return usages(this.db, ctx.scope, 'document', id, offset);
  }
  /** Trusted schema tooling supplies data, never executable client code. Migrates both channels separately. */
  async migrateDocument(ctx: Context, id: string, input: { expectedRevision: number; expectedSchemaVersion: number; draft: Content; published: Content | null }): Promise<Document> {
    await this.allowed(ctx, 'content:edit'); await this.allowed(ctx, 'content:publish');
    revision(input.expectedRevision); revision(input.expectedSchemaVersion, 'expectedSchemaVersion');
    contentValid(input.draft); if (input.published !== null) contentValid(input.published);
    return this.mutate(ctx, 'schema:write', async tx => {
      const old = await this.requireDocument(tx, ctx.scope, id, input.expectedRevision);
      requireCondition((old.published === null) === (input.published === null), 'Migration must preserve whether the document is published');
      const registry = await this.requiredRegistry(tx, ctx.scope, input.expectedSchemaVersion);
      const type = registry.definition.types.find(t => t.name === old.type); requireCondition(type, 'Unknown content type');
      validateContent(type, input.draft, registry.definition, false);
      if (input.published) validateContent(type, input.published, registry.definition, true);
      const published = input.published ? projectContent(type, input.published) : null;
      const [row] = await tx.query(`UPDATE grove_documents SET draft=$5::jsonb,published=$6::jsonb,schema_version=$7::integer,published_schema_version=CASE WHEN published IS NULL THEN NULL ELSE $7::integer END,published_revision=CASE WHEN published IS NULL THEN NULL ELSE revision+1 END,revision=revision+1,updated_at=now(),updated_by=$8 WHERE ${scoped} AND id=$4 RETURNING *`, [...keys(ctx.scope), id, input.draft, published, registry.version, ctx.actor.id]);
      const saved = document(row!);
      await indexLinks(tx, ctx.scope, id, saved.type, 'draft', projectContent(type, saved.draft));
      if (saved.published) await indexLinks(tx, ctx.scope, id, saved.type, 'published', saved.published);
      await this.snapshot(tx, ctx, saved, 'migrate'); return saved;
    });
  }
  async deliver(ctx: Context, id: string, locale?: string): Promise<DeliveredDocument> {
    await this.allowed(ctx, 'delivery:read');
    identifier(id, 'Document id');
    const [row] = await this.db.query(`SELECT d.id, d.type, d.published, d.published_revision, d.published_schema_version, s.definition
      FROM grove_documents d JOIN grove_schema_versions s ON s.tenant_id = d.tenant_id AND s.site_id = d.site_id AND s.environment = d.environment AND s.version = d.published_schema_version
      WHERE d.tenant_id = $1 AND d.site_id = $2 AND d.environment = $3 AND d.id = $4 AND d.published IS NOT NULL`, [...keys(ctx.scope), id]);
    if (!row) throw new GroveError('not_found', 'Published document not found');
    let data: Content = row.published;
    if (locale !== undefined) {
      const schema: Schema = row.definition;
      requireCondition(schema.locales.includes(locale), 'Unknown locale');
      const type = schema.types.find(t => t.name === row.type)!;
      data = { ...data };
      for (const field of type.fields.filter(f => f.localized)) {
        const map = data[field.name] as Content | null | undefined;
        if (map) data[field.name] = map[locale] ?? map[schema.defaultLocale] ?? null;
      }
    }
    return { id: row.id, type: row.type, revision: row.published_revision, schemaVersion: row.published_schema_version, data };
  }
}
