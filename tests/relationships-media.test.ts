import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Grove, GroveError, createPostgresDatabase, createHandler, migrate, localStorage } from '@eclosion-tech/grove/server';
import { reference, assetReference, type Schema, type Content } from '@eclosion-tech/grove';
import { createClient } from '@eclosion-tech/grove/client';
import { exampleApi } from '../apps/grove/src/example-api.js';
import { upgradeDemo } from '../scripts/upgrade-demo.js';
import studioSchema from '../examples/studio-schema.js';
import { readPage } from '../apps/example-site/src/manifest.js';
const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
let directory: string;
before(async () => { await migrate(db); directory = await mkdtemp(join(tmpdir(), 'grove-media-')); });
after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
const schema: Schema = { locales: ['en', 'es'], defaultLocale: 'en', types: [
  { name: 'article', fields: [{ name: 'title', type: 'string', required: true }, { name: 'author', type: 'reference', to: ['author'] }, { name: 'related', type: 'reference', to: ['article'], multiple: true }, { name: 'cover', type: 'image', localized: true }, { name: 'layout', type: 'json' }] },
  { name: 'author', fields: [{ name: 'title', type: 'string', required: true }] },
] };
const code = (name: string) => (e: unknown) => e instanceof GroveError && e.code === name;
async function fixture() {
  const scope = { tenantId: randomUUID(), siteId: 'site', environment: 'test' };
  const ctx = { actor: { id: 'admin' }, scope };
  const grove = new Grove(db, (actor, _scope, permission) => actor.id === 'admin' || (actor.id === 'local-developer' && permission === 'delivery:read'), { storage: localStorage(directory) });
  await grove.pushSchema(ctx, schema, 0);
  const save = (id: string, type: string, data: Content, expectedRevision = 0) => grove.saveDocument(ctx, id, { type, data, expectedRevision, expectedSchemaVersion: 1 });
  return { grove, ctx, save };
}
const png = () => sharp({ create: { width: 20, height: 12, channels: 3, background: '#386643' } }).png().toBuffer();

test('typed relationships enforce scope, target collection, array uniqueness, and publication readiness', async () => {
  const { grove, ctx, save } = await fixture();
  await save('writer', 'author', { title: 'Writer' });
  const draft = await save('story', 'article', { title: 'Story', author: reference('writer', 'author') });
  await assert.rejects(grove.publish(ctx, 'story', draft.revision), code('invalid_request'));
  for (const data of [{ author: 'writer' }, { author: reference('writer', 'article') }, { author: reference('missing', 'author') }, { related: [reference('story', 'article'), reference('story', 'article')] }] as Content[]) await assert.rejects(save('bad', 'article', data), code('invalid_request'));
  const elsewhere = { ...ctx, scope: { ...ctx.scope, siteId: 'elsewhere' } };
  await grove.pushSchema(elsewhere, schema, 0);
  await grove.saveDocument(elsewhere, 'other-writer', { type: 'author', data: { title: 'Private author' }, expectedRevision: 0, expectedSchemaVersion: 1 });
  await assert.rejects(save('cross-scope', 'article', { author: reference('other-writer', 'author') }), code('invalid_request'));
  await grove.publish(ctx, 'writer', 1); await grove.publish(ctx, 'story', 1);
  assert.equal((await grove.whereUsed(ctx, 'writer')).length, 2);
  await assert.rejects(grove.unpublish(ctx, 'writer', 2), code('conflict'));
  assert.equal((await grove.getDocument(ctx, 'writer')).revision, 2);
});

test('draft and live edges remain independent, including references inside Puck JSON and history restore', async () => {
  const { grove, ctx, save } = await fixture();
  for (const id of ['a', 'b']) { await save(id, 'article', { title: id }); await grove.publish(ctx, id, 1); }
  await save('page', 'article', { title: 'Page', layout: { content: [{ props: { article: reference('a', 'article') } }] } });
  await grove.publish(ctx, 'page', 1);
  await save('page', 'article', { layout: { content: [{ props: { article: reference('b', 'article') } }] } }, 2);
  assert.deepEqual((await grove.whereUsed(ctx, 'a')).map(u => u.channel), ['published']);
  assert.deepEqual((await grove.whereUsed(ctx, 'b')).map(u => u.channel), ['draft']);
  assert.equal((await grove.whereUsed(ctx, 'b'))[0]?.path, '/layout/content/0/props/article');
  await grove.restore(ctx, 'page', 1, 3);
  assert.equal((await grove.whereUsed(ctx, 'b')).length, 0);
  assert.equal((await grove.whereUsed(ctx, 'a')).length, 2);
  await grove.unpublish(ctx, 'page', 4); await grove.unpublish(ctx, 'a', 2);
  assert.equal((await grove.whereUsed(ctx, 'a')).length, 1);
  await assert.rejects(grove.publish(ctx, 'page', 5), code('invalid_request'));
});

test('images are decoded, normalized and scoped; invalid formats and unauthorized uploads are rejected', async () => {
  const { grove, ctx } = await fixture();
  const uploaded = await grove.media.upload(ctx, '../../garden.png', await png());
  assert.equal(uploaded.filename, 'garden.webp'); assert.equal(uploaded.mimeType, 'image/webp'); assert.equal(uploaded.width, 20); assert.equal(uploaded.height, 12);
  const bytes = (await grove.media.read(ctx, uploaded.id)).bytes;
  assert.equal((await sharp(bytes).metadata()).format, 'webp');
  await assert.rejects(grove.media.upload(ctx, 'fake.png', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), code('invalid_request'));
  await assert.rejects(grove.media.upload(ctx, 'empty.png', new Uint8Array()), code('invalid_request'));
  await assert.rejects(grove.media.upload(ctx, 'large.png', new Uint8Array(10 * 1024 * 1024 + 1)), code('invalid_request'));
  await assert.rejects(grove.media.upload({ ...ctx, actor: { id: 'denied' } }, 'photo.png', await png()), code('forbidden'));
  await assert.rejects(grove.media.read({ ...ctx, scope: { ...ctx.scope, environment: 'other' } }, uploaded.id), code('not_found'));
  await assert.rejects(grove.media.read(ctx, uploaded.id, true), code('not_found'));
});

test('image metadata uses revisions, configured locales, focal points, and usage-protected archive/restore', async () => {
  const { grove, ctx, save } = await fixture();
  let asset = await grove.media.upload(ctx, 'portrait.png', await png());
  asset = await grove.media.update(ctx, asset.id, { expectedRevision: 1, alt: { en: 'A garden', es: 'Un jardín' }, focalPoint: { x: 0.1, y: 0.8 } });
  assert.equal(asset.revision, 2);
  await assert.rejects(grove.media.update(ctx, asset.id, { expectedRevision: 1, alt: { en: 'Stale' } }), code('conflict'));
  await assert.rejects(grove.media.update(ctx, asset.id, { expectedRevision: 2, caption: { fr: 'Unknown locale' } }), code('invalid_request'));
  await assert.rejects(grove.media.update(ctx, asset.id, { expectedRevision: 2, focalPoint: { x: -1, y: 2 } }), code('invalid_request'));
  await save('story', 'article', { title: 'Story', cover: { en: assetReference(asset.id) } });
  await assert.rejects(grove.media.setArchived(ctx, asset.id, 2, true), code('conflict'));
  await grove.publish(ctx, 'story', 1);
  assert.equal((await grove.media.read(ctx, asset.id, true)).asset.alt.es, 'Un jardín');
  await save('story', 'article', { cover: null }, 2);
  assert.deepEqual((await grove.media.whereUsed(ctx, asset.id)).map(u => u.channel), ['published']);
  await assert.rejects(grove.media.setArchived(ctx, asset.id, 2, true), code('conflict'));
  await grove.unpublish(ctx, 'story', 3);
  asset = await grove.media.setArchived(ctx, asset.id, 2, true);
  assert.equal((await grove.media.list(ctx)).length, 0); assert.equal((await grove.media.list(ctx, { archived: true })).length, 1);
  await assert.rejects(save('other', 'article', { cover: { en: assetReference(asset.id) } }), code('invalid_request'));
  await assert.rejects(grove.restore(ctx, 'story', 1, 4), code('invalid_request'));
  asset = await grove.media.setArchived(ctx, asset.id, asset.revision, false);
  await grove.restore(ctx, 'story', 1, 4);
  assert.equal((await grove.media.whereUsed(ctx, asset.id)).length, 1);
  assert.equal((await grove.media.read(ctx, asset.id)).bytes.length, asset.bytes);
});

test('HTTP media lifecycle and record search work through the typed client; example delivery keeps unused images private', async () => {
  const { grove, ctx, save } = await fixture();
  const handler = createHandler(grove, { authenticate: async () => ctx.actor, onError: e => { throw e; } });
  const client = createClient({ baseUrl: 'http://test', scope: ctx.scope, fetch: async (url, init) => handler(new Request(url, init)) });
  const asset = await client.uploadMedia(new Blob([new Uint8Array(await png())]), 'garden.png');
  assert.equal((await client.listMedia({ search: 'garden' }))[0]?.id, asset.id);
  assert.equal((await handler(new Request(client.mediaContentUrl(asset.id)))).headers.get('content-type'), 'image/webp');
  await save('story', 'article', { title: 'A fresh garden', cover: { en: assetReference(asset.id) } });
  assert.equal((await client.listDocuments({ type: 'article', search: 'FRESH' }))[0]?.id, 'story');
  const site = exampleApi(grove, ctx.scope, async r => r.headers.has('authorization') ? ctx.actor : null);
  const url = `http://site/example-api/media/${asset.id}`;
  assert.equal((await site(new Request(url)))?.status, 404);
  assert.equal((await site(new Request(`${url}?mode=preview`)))?.status, 401);
  assert.equal((await site(new Request(`${url}?mode=preview`, { headers: { authorization: 'editor' } })))?.status, 200);
  await client.publish('story', 1);
  assert.equal((await site(new Request(url)))?.status, 200);
  assert.equal((await client.mediaWhereUsed(asset.id)).length, 2);
  await client.updateMedia(asset.id, { expectedRevision: 1, alt: { en: 'Garden' } });
  await client.unpublish('story', 2); await client.saveDocument('story', { type: 'article', data: { cover: null }, expectedRevision: 3, expectedSchemaVersion: 1 });
  await client.archiveMedia(asset.id, 2); await client.restoreMedia(asset.id, 3);
  assert.equal((await client.getMedia(asset.id)).revision, 4);
});

test('demo migration upgrades legacy IDs and authors while preserving separate draft/live content, timestamps and block IDs', async () => {
  const { grove, ctx } = await fixture();
  const old: Schema = structuredClone(studioSchema);
  old.types = old.types.filter(t => t.name !== 'author');
  const article = old.types.find(t => t.name === 'article')!;
  article.fields = article.fields.filter(f => !['relatedArticles', 'coverImage'].includes(f.name)).map(f => f.name === 'author' ? { name: 'author', type: 'string' } : f);
  old.types.find(t => t.name === 'page')!.fields.find(f => f.name === 'manifestVersion')!.default = 1;
  await grove.pushSchema(ctx, old, 1, { allowBreaking: true });
  await grove.saveDocument(ctx, 'story', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 2, data: { title: { en: 'Live story' }, slug: 'story', author: 'Live writer' } });
  await grove.publish(ctx, 'story', 1);
  await grove.saveDocument(ctx, 'story', { type: 'article', expectedRevision: 2, expectedSchemaVersion: 2, data: { title: { en: 'Private title' }, author: 'Draft writer' } });
  const page = { title: 'Live page', locale: 'en', manifestVersion: 1, layout: { root: { props: {} }, content: [{ type: 'Article', props: { id: 'stable-block', documentId: 'story', label: 'Story' } }] } };
  await grove.saveDocument(ctx, 'home', { type: 'page', expectedRevision: 0, expectedSchemaVersion: 2, data: page });
  const published = await grove.publish(ctx, 'home', 1);
  await grove.saveDocument(ctx, 'home', { type: 'page', expectedRevision: 2, expectedSchemaVersion: 2, data: { title: 'Private page' } });
  await upgradeDemo(grove, ctx);
  const result = await grove.getDocument(ctx, 'home');
  assert.equal(result.publishedAt, published.publishedAt);
  assert.equal(result.draft.title, 'Private page'); assert.equal(result.published?.title, 'Live page');
  const layout = readPage(result.draft); assert.equal(layout.content[0]?.props.id, 'stable-block');
  assert.deepEqual((layout.content[0]?.props as any).article, reference('story', 'article'));
  assert.equal((layout.content[0]?.props as any).documentId, undefined);
  const story = await grove.getDocument(ctx, 'story');
  assert.deepEqual(story.draft.title, { en: 'Private title' }); assert.deepEqual(story.published?.title, { en: 'Live story' });
  assert.notDeepEqual(story.draft.author, story.published?.author);
  assert.equal((await grove.whereUsed(ctx, 'story')).length, 2);
  assert.equal((await grove.history(ctx, 'home'))[0]?.action, 'migrate');
  await upgradeDemo(grove, ctx);
  assert.equal((await grove.getDocument(ctx, 'home')).revision, result.revision);
  await assert.rejects(grove.migrateDocument(ctx, 'home', { expectedRevision: result.revision, expectedSchemaVersion: result.schemaVersion, draft: result.draft, published: null }), code('invalid_request'));
});
