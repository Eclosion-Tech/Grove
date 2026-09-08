import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { Database, Queryable, Row } from './database.js';
import type { MediaAsset, MediaPatch } from './schema.js';
import type { Context, Permission } from './service.js';
import type { StorageAdapter } from './storage.js';
import { GroveError, requireCondition } from './errors.js';
import { identifier, object, revision } from './validation.js';
import { scopeKeys, scopeSql, usages, protectReferenced } from './relationships.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
type Guard = (ctx: Context, permission: Permission) => Promise<void>;
type Mutation = <T>(ctx: Context, permission: Permission, work: (tx: Queryable) => Promise<T>) => Promise<T>;
const asset = (r: Row): MediaAsset => ({ id: r.id, filename: r.filename, mimeType: r.mime_type, bytes: r.bytes, width: r.width, height: r.height, revision: r.revision, alt: r.alt, caption: r.caption, focalPoint: r.focal_point, archived: r.archived, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), updatedBy: r.updated_by });

export class MediaLibrary {
  constructor(private db: Database, private storage: StorageAdapter | undefined, private guard: Guard, private mutate: Mutation) {}
  private configured(): StorageAdapter { requireCondition(this.storage, 'Media storage has not been configured by the host'); return this.storage; }
  private async row(tx: Queryable, ctx: Context, id: string) {
    identifier(id, 'Asset id');
    const [row] = await tx.query(`SELECT * FROM grove_media WHERE ${scopeSql} AND id = $4`, [...scopeKeys(ctx.scope), id]);
    if (!row) throw new GroveError('not_found', 'Image not found'); return row;
  }
  private async history(tx: Queryable, ctx: Context, value: MediaAsset, action: string) {
    await tx.query('INSERT INTO grove_media_history (tenant_id,site_id,environment,asset_id,revision,action,metadata,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [...scopeKeys(ctx.scope), value.id, value.revision, action, value, ctx.actor.id]);
  }
  async upload(ctx: Context, filename: string, bytes: Uint8Array): Promise<MediaAsset> {
    await this.guard(ctx, 'media:write');
    const storage = this.configured();
    requireCondition(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_UPLOAD_BYTES, 'Choose an image up to 10 MB');
    requireCondition(typeof filename === 'string' && filename.length > 0 && filename.length <= 250, 'Provide an image filename');
    let output: Buffer;
    let width: number; let height: number;
    try {
      const image = sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning' });
      const metadata = await image.metadata();
      requireCondition(['jpeg', 'png', 'webp'].includes(metadata.format ?? '') && (metadata.pages ?? 1) === 1, 'Use a still JPEG, PNG, or WebP image');
      const result = await image.rotate().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
      output = result.data; width = result.info.width; height = result.info.height;
    } catch (error) { if (error instanceof GroveError) throw error; throw new GroveError('invalid_request', 'This image could not be decoded. Use a JPEG, PNG, or WebP under 25 megapixels.'); }
    requireCondition(output.length <= MAX_UPLOAD_BYTES, 'Processed image exceeds 10 MB');
    const id = randomUUID(); const key = [...scopeKeys(ctx.scope), `${id}.webp`].join('/');
    const safeName = (filename.split(/[\\/]/).at(-1) ?? 'image').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 140) || 'image';
    await storage.put(key, output, 'image/webp');
    try {
      return await this.mutate(ctx, 'media:write', async tx => {
        const [row] = await tx.query(`INSERT INTO grove_media (tenant_id,site_id,environment,id,storage_key,filename,mime_type,bytes,width,height,updated_by) VALUES ($1,$2,$3,$4,$5,$6,'image/webp',$7,$8,$9,$10) RETURNING *`, [...scopeKeys(ctx.scope), id, key, `${safeName}.webp`, output.length, width, height, ctx.actor.id]);
        const value = asset(row!); await this.history(tx, ctx, value, 'upload'); return value;
      });
    } catch (error) { await storage.remove(key).catch(() => {}); throw error; }
  }
  async list(ctx: Context, options: { search?: string; after?: string; limit?: number; archived?: boolean } = {}) {
    await this.guard(ctx, 'media:read');
    const { search = '', after = '', limit = 40, archived = false } = options;
    requireCondition(typeof search === 'string' && search.length <= 200 && Number.isInteger(limit) && limit > 0 && limit <= 100 && typeof archived === 'boolean', 'Invalid media filters');
    return (await this.db.query(`SELECT * FROM grove_media WHERE ${scopeSql} AND id > $4 AND archived = $5 AND strpos(lower(filename), lower($6)) > 0 ORDER BY id LIMIT $7`, [...scopeKeys(ctx.scope), after, archived, search, limit])).map(asset);
  }
  async get(ctx: Context, id: string) { await this.guard(ctx, 'media:read'); return asset(await this.row(this.db, ctx, id)); }
  async update(ctx: Context, id: string, input: MediaPatch): Promise<MediaAsset> {
    requireCondition(object(input) && Object.keys(input).every(k => ['expectedRevision', 'alt', 'caption', 'focalPoint'].includes(k)), 'Invalid media metadata');
    revision(input.expectedRevision);
    return this.mutate(ctx, 'media:write', async tx => {
      const current = await this.row(tx, ctx, id);
      if (current.revision !== input.expectedRevision) throw new GroveError('conflict', 'Image metadata changed. Reload before saving.', { currentRevision: current.revision });
      const [schema] = await tx.query(`SELECT definition FROM grove_schema_versions WHERE ${scopeSql} ORDER BY version DESC LIMIT 1`, scopeKeys(ctx.scope));
      for (const map of [input.alt, input.caption]) if (map !== undefined) {
        requireCondition(object(map) && Object.entries(map).every(([locale, value]) => schema?.definition.locales.includes(locale) && typeof value === 'string' && value.length <= 2000), 'Use configured locales and text up to 2,000 characters for media metadata');
      }
      const point = input.focalPoint ?? current.focal_point;
      requireCondition(object(point) && ['x', 'y'].every(k => typeof point[k] === 'number' && Number.isFinite(point[k]) && point[k] >= 0 && point[k] <= 1) && Object.keys(point).length === 2, 'Focal point coordinates must be between 0 and 1');
      const [row] = await tx.query(`UPDATE grove_media SET alt=$5::jsonb,caption=$6::jsonb,focal_point=$7::jsonb,revision=revision+1,updated_at=now(),updated_by=$8 WHERE ${scopeSql} AND id=$4 RETURNING *`, [...scopeKeys(ctx.scope), id, input.alt ?? current.alt, input.caption ?? current.caption, point, ctx.actor.id]);
      const value = asset(row!); await this.history(tx, ctx, value, 'update'); return value;
    });
  }
  async setArchived(ctx: Context, id: string, expectedRevision: number, archived: boolean): Promise<MediaAsset> {
    revision(expectedRevision); requireCondition(typeof archived === 'boolean', 'archived must be boolean');
    return this.mutate(ctx, 'media:delete', async tx => {
      const current = await this.row(tx, ctx, id);
      if (current.revision !== expectedRevision) throw new GroveError('conflict', 'Image changed. Reload before continuing.');
      if (archived) await protectReferenced(tx, ctx.scope, 'asset', id, false);
      const [row] = await tx.query(`UPDATE grove_media SET archived=$5,revision=revision+1,updated_at=now(),updated_by=$6 WHERE ${scopeSql} AND id=$4 RETURNING *`, [...scopeKeys(ctx.scope), id, archived, ctx.actor.id]);
      const value = asset(row!); await this.history(tx, ctx, value, archived ? 'archive' : 'restore'); return value;
    });
  }
  async whereUsed(ctx: Context, id: string, offset = 0) { await this.guard(ctx, 'media:read'); await this.guard(ctx, 'content:read'); await this.row(this.db, ctx, id); return usages(this.db, ctx.scope, 'asset', id, offset); }
  async read(ctx: Context, id: string, publishedOnly = false): Promise<{ asset: MediaAsset; bytes: Uint8Array }> {
    await this.guard(ctx, publishedOnly ? 'delivery:read' : 'media:read');
    const row = await this.row(this.db, ctx, id);
    if (publishedOnly) {
      const [used] = await this.db.query(`SELECT 1 FROM grove_relationships WHERE ${scopeSql} AND target_kind='asset' AND target_id=$4 AND channel='published' LIMIT 1`, [...scopeKeys(ctx.scope), id]);
      if (!used || row.archived) throw new GroveError('not_found', 'Published image not found');
    }
    return { asset: asset(row), bytes: await this.configured().get(row.storage_key) };
  }
}
