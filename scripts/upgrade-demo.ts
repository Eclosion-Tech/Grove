import { createHash } from 'node:crypto';
import type { Grove, Context } from '@eclosion-tech/grove/server';
import { reference, type Content, type Schema, type Document } from '@eclosion-tech/grove';
import nextSchema from '../examples/studio-schema.js';

/** Trusted, site-owned v1 → v2 migration. Each snapshot is transformed independently. */
export async function upgradeDemo(grove: Grove, ctx: Context) {
  const registry = await grove.getSchema(ctx);
  if (!registry) return;
  const definition: Schema = structuredClone(registry.definition);
  if (!definition.types.some(t => t.name === 'article') || !definition.types.some(t => t.name === 'page')) return;
  for (const next of nextSchema.types) {
    const current = definition.types.find(t => t.name === next.name);
    if (!current) { definition.types.push(structuredClone(next)); continue; }
    for (const field of next.fields) {
      const index = current.fields.findIndex(f => f.name === field.name);
      if (index < 0) current.fields.push(structuredClone(field));
      else if ((next.name === 'article' && field.name === 'author' && current.fields[index]?.type === 'string') || (next.name === 'page' && field.name === 'manifestVersion' && current.fields[index]?.default === 1)) current.fields[index] = structuredClone(field);
    }
  }
  const docs: Document[] = []; let after: string | undefined;
  do { const batch = await grove.listDocuments(ctx, { after, limit: 100 }); docs.push(...batch); after = batch.length === 100 ? batch.at(-1)!.id : undefined; } while (after);
  const liveNames = new Set(docs.filter(d => d.type === 'article' && typeof d.published?.author === 'string').map(d => d.published!.author as string));
  const names = new Set(docs.filter(d => d.type === 'article').flatMap(d => [d.draft.author, d.published?.author]).filter((name): name is string => typeof name === 'string' && !!name));
  const authorId = (name: string) => `author-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
  const version = (await grove.pushSchema(ctx, definition, registry.version, { allowBreaking: true })).version;
  for (const name of names) {
    const id = authorId(name); let doc = docs.find(d => d.id === id);
    if (!doc) doc = await grove.saveDocument(ctx, id, { type: 'author', expectedRevision: 0, expectedSchemaVersion: version, data: { title: name } });
    if (doc.type !== 'author') throw new Error(`Cannot migrate author: ${id} belongs to another collection.`);
    if (liveNames.has(name) && !doc.published) {
      if (doc.draft.title !== name) throw new Error(`Review and publish author ${id} before retrying the demo migration.`);
      await grove.publish(ctx, id, doc.revision);
    }
  }
  function transform(data: Content, type: string): Content {
    const next = structuredClone(data);
    if (type === 'article' && typeof next.author === 'string') next.author = next.author ? reference(authorId(next.author), 'author') : null;
    if (type === 'page' && next.manifestVersion === 1) {
      const layout = next.layout as { content?: { type: string; props: Record<string, any> }[] } | undefined;
      if (!layout || !Array.isArray(layout.content)) throw new Error('Cannot migrate an invalid page composition.');
      for (const block of layout.content) if (block.type === 'Article' && 'documentId' in block.props) {
        block.props.article = block.props.documentId ? reference(block.props.documentId, 'article') : null;
        delete block.props.documentId;
      }
      next.manifestVersion = 2;
    }
    return next;
  }
  for (const doc of docs.filter(d => ['article', 'page'].includes(d.type)).sort((a, b) => a.type.localeCompare(b.type))) {
    const draft = transform(doc.draft, doc.type); const published = doc.published ? transform(doc.published, doc.type) : null;
    if (JSON.stringify(draft) === JSON.stringify(doc.draft) && JSON.stringify(published) === JSON.stringify(doc.published) && doc.schemaVersion === version && (!doc.published || doc.publishedSchemaVersion === version)) continue;
    await grove.migrateDocument(ctx, doc.id, { expectedRevision: doc.revision, expectedSchemaVersion: version, draft, published });
  }
}
