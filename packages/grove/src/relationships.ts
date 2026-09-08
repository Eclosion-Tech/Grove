import type { Content, Json, Scope, Usage } from './schema.js';
import type { Queryable } from './database.js';
import { GroveError, requireCondition } from './errors.js';
import { identifier, object } from './validation.js';

export const scopeKeys = (scope: Scope) => [scope.tenantId, scope.siteId, scope.environment];
export const scopeSql = 'tenant_id = $1 AND site_id = $2 AND environment = $3';
export type Link = { path: string; target_id: string; target_kind: 'document' | 'asset'; target_type: string | null };
export function linksIn(value: Json | Content): Link[] {
  const links: Link[] = [];
  function visit(value: Json, path: string) {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}/${i}`)); return; }
    if (!object(value)) return;
    if (value._type === 'reference' || value._type === 'asset') {
      identifier(value._ref, `Reference at ${path}`);
      if (value._type === 'reference') identifier(value._target, `Collection at ${path}`);
      requireCondition(Object.keys(value).every(k => ['_type', '_ref', ...(value._type === 'reference' ? ['_target'] : [])].includes(k)), `Reference ${path} contains unsupported properties`);
      links.push({ path, target_id: value._ref, target_kind: value._type === 'asset' ? 'asset' : 'document', target_type: value._type === 'reference' ? value._target as string : null });
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child as Json, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
  }
  visit(value, '');
  requireCondition(links.length <= 300, 'A document may contain at most 300 references');
  return links;
}

export async function indexLinks(tx: Queryable, scope: Scope, sourceId: string, sourceType: string, channel: 'draft' | 'published', data: Content): Promise<void> {
  const links = linksIn(data);
  const checked = new Set<string>();
  for (const link of links) {
    const key = `${link.target_kind}:${link.target_id}:${link.target_type}`;
    if (checked.has(key)) continue; checked.add(key);
    if (link.target_kind === 'document') {
      if (link.target_id === sourceId) { requireCondition(link.target_type === sourceType, 'Self-reference type does not match'); continue; }
      const [target] = await tx.query(`SELECT type, published FROM grove_documents WHERE ${scopeSql} AND id = $4`, [...scopeKeys(scope), link.target_id]);
      requireCondition(target && target.type === link.target_type, `Reference ${link.path} must point to an existing ${link.target_type} in this workspace`);
      requireCondition(channel !== 'published' || target.published !== null, `Publish the referenced ${link.target_type} (${link.target_id}) before publishing this document`);
    } else {
      const [target] = await tx.query(`SELECT archived FROM grove_media WHERE ${scopeSql} AND id = $4`, [...scopeKeys(scope), link.target_id]);
      requireCondition(target && !target.archived, `Image ${link.path} is missing or archived`);
    }
  }
  await tx.query(`DELETE FROM grove_relationships WHERE ${scopeSql} AND source_id = $4 AND channel = $5`, [...scopeKeys(scope), sourceId, channel]);
  if (links.length) await tx.query(`INSERT INTO grove_relationships (tenant_id,site_id,environment,source_id,channel,path,target_id,target_kind,target_type)
    SELECT $1,$2,$3,$4,$5,r.path,r.target_id,r.target_kind,r.target_type FROM jsonb_to_recordset($6::jsonb) AS r(path text,target_id text,target_kind text,target_type text)`, [...scopeKeys(scope), sourceId, channel, links]);
}
export async function usages(tx: Queryable, scope: Scope, kind: 'document' | 'asset', id: string, offset = 0, limit = 50): Promise<Usage[]> {
  requireCondition(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Invalid usage pagination');
  return (await tx.query(`SELECT r.source_id, d.type, COALESCE(CASE WHEN r.channel = 'draft' THEN d.draft ELSE d.published END -> 'title', to_jsonb(d.id)) AS title, r.path, r.channel
    FROM grove_relationships r JOIN grove_documents d ON d.tenant_id = r.tenant_id AND d.site_id = r.site_id AND d.environment = r.environment AND d.id = r.source_id
    WHERE r.tenant_id = $1 AND r.site_id = $2 AND r.environment = $3 AND r.target_kind = $4 AND r.target_id = $5
    ORDER BY r.source_id, r.channel, r.path LIMIT $6 OFFSET $7`, [...scopeKeys(scope), kind, id, limit, offset]))
    .map(r => ({ sourceId: r.source_id, sourceType: r.type, title: r.title, path: r.path, channel: r.channel }));
}
export async function protectReferenced(tx: Queryable, scope: Scope, kind: 'document' | 'asset', id: string, publishedOnly: boolean) {
  const rows = await tx.query(`SELECT source_id FROM grove_relationships WHERE ${scopeSql} AND target_kind = $4 AND target_id = $5
    AND ($6::boolean = false OR channel = 'published') AND NOT (target_kind = 'document' AND source_id = target_id) LIMIT 1`, [...scopeKeys(scope), kind, id, publishedOnly]);
  if (rows.length) throw new GroveError('conflict', publishedOnly ? 'Published content still links to this record. Remove those links before unpublishing.' : 'This image is still used in a draft or published document. Remove those references before archiving.');
}
