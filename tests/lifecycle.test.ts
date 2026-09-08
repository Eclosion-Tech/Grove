import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createPostgresDatabase, migrate, Grove, GroveError, createHandler, type Context, type Permission } from '@eclosion-tech/grove/server';
import { createClient, GroveClientError } from '../packages/grove/src/client.js';
import { defineSchema, type Schema, type Content } from '../packages/grove/src/schema.js';
import { exampleApi } from '../apps/grove/src/example-api.js';

const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
const schema = defineSchema({
  locales: ['en', 'es'], defaultLocale: 'en',
  types: [{ name: 'article', fields: [
    { name: 'title', type: 'string', required: true, localized: true },
    { name: 'body', type: 'text' },
    { name: 'featured', type: 'boolean', default: false },
  ] }],
});
const grants: Record<string, Permission[]> = {
  admin: ['schema:read', 'schema:write', 'content:read', 'content:edit', 'content:publish', 'delivery:read'],
  editor: ['schema:read', 'content:read', 'content:edit'],
  reader: ['delivery:read'],
};
function fixture() {
  const scope = { tenantId: randomUUID(), siteId: 'site', environment: 'development' };
  const grove = new Grove(db, (actor, requested, permission) => requested.tenantId === scope.tenantId && requested.siteId === scope.siteId && requested.environment === scope.environment && !!grants[actor.id]?.includes(permission));
  const ctx: Context = { actor: { id: 'admin' }, scope };
  return { grove, ctx, initialize: () => grove.pushSchema(ctx, schema, 0) };
}
const isError = (code: GroveError['code']) => (error: unknown) => error instanceof GroveError && error.code === code;
before(async () => { await migrate(db); await migrate(db); });
after(async () => { await db.close(); });

test('draft → publish → edit → restore preserves live snapshot and records actors', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  const created = await grove.saveDocument(ctx, 'hello', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: { en: 'First' }, body: 'Original' } });
  assert.equal(created.revision, 1); assert.equal(created.draft.featured, false);
  await assert.rejects(grove.deliver(ctx, 'hello'), isError('not_found'));
  const published = await grove.publish(ctx, 'hello', 1);
  assert.equal(published.publishedRevision, 2);
  const edited = await grove.saveDocument({ ...ctx, actor: { id: 'editor' } }, 'hello', { type: 'article', expectedRevision: 2, expectedSchemaVersion: 1, data: { title: { en: 'Second', es: 'Segundo' } } });
  assert.equal(edited.draft.body, 'Original');
  assert.deepEqual((await grove.deliver(ctx, 'hello', 'es')).data.title, 'First');
  const restored = await grove.restore(ctx, 'hello', 1, 3);
  assert.equal(restored.revision, 4); assert.equal(restored.publishedRevision, 2);
  assert.deepEqual(restored.draft.title, { en: 'First' });
  const history = await grove.history(ctx, 'hello');
  assert.deepEqual(history.map(h => h.action), ['restore', 'save', 'publish', 'create']);
  assert.equal(history[1]?.actorId, 'editor');
  await grove.unpublish(ctx, 'hello', 4);
  await assert.rejects(grove.deliver(ctx, 'hello'), isError('not_found'));
  assert.equal((await grove.getDocument(ctx, 'hello')).revision, 5);
});

test('concurrent edits have exactly one winner, one conflict, and no duplicate history', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  await grove.saveDocument(ctx, 'race', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: {} });
  const outcomes = await Promise.allSettled(['one', 'two'].map(title => grove.saveDocument(ctx, 'race', { type: 'article', expectedRevision: 1, expectedSchemaVersion: 1, data: { title: { en: title } } })));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const failure = outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(isError('conflict')(failure.reason));
  assert.equal((await grove.getDocument(ctx, 'race')).revision, 2);
  assert.equal((await grove.history(ctx, 'race')).length, 2);
});

test('concurrent creation and registry pushes detect conflicts', async () => {
  const { grove, ctx } = fixture();
  const registry = await Promise.allSettled([grove.pushSchema(ctx, schema, 0), grove.pushSchema(ctx, schema, 0)]);
  assert.equal(registry.filter(r => r.status === 'fulfilled').length, 1);
  const input = { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: {} };
  const docs = await Promise.allSettled([grove.saveDocument(ctx, 'new', input), grove.saveDocument(ctx, 'new', input)]);
  assert.equal(docs.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await grove.history(ctx, 'new')).length, 1);
});

test('stale publish and restore cannot overwrite newer edits', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  await grove.saveDocument(ctx, 'hello', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: { en: 'One' } } });
  await grove.saveDocument(ctx, 'hello', { type: 'article', expectedRevision: 1, expectedSchemaVersion: 1, data: { title: { en: 'Two' } } });
  await assert.rejects(grove.publish(ctx, 'hello', 1), isError('conflict'));
  await assert.rejects(grove.restore(ctx, 'hello', 1, 1), isError('conflict'));
  assert.equal((await grove.history(ctx, 'hello')).length, 2);
});

test('incomplete drafts save; invalid fields and incomplete publication fail atomically', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  await grove.saveDocument(ctx, 'draft', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: {} });
  await assert.rejects(grove.publish(ctx, 'draft', 1), isError('invalid_request'));
  for (const data of [{ featured: 'yes' }, { unknown: 'oops' }, { title: { fr: 'Non' } }, { title: 'plain' }] as Content[]) {
    await assert.rejects(grove.saveDocument(ctx, 'draft', { type: 'article', expectedRevision: 1, expectedSchemaVersion: 1, data }), isError('invalid_request'));
  }
  assert.equal((await grove.getDocument(ctx, 'draft')).revision, 1);
  assert.equal((await grove.history(ctx, 'draft')).length, 1);
});

test('schema dry-run, breaking diff, stale registry and removed field retention', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  await grove.saveDocument(ctx, 'old', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: { en: 'Title' }, body: 'Retain me' } });
  const next: Schema = { ...schema, types: [{ name: 'article', fields: [{ name: 'title', type: 'string', localized: true, required: true }] }] };
  const diff = await grove.pushSchema(ctx, next, 1, { dryRun: true });
  assert.equal(diff.applied, false); assert.ok(diff.changes.some(c => c.path === 'article.body' && c.breaking));
  assert.equal((await grove.getSchema(ctx))?.version, 1);
  await assert.rejects(grove.pushSchema(ctx, next, 1), isError('invalid_request'));
  await grove.pushSchema(ctx, next, 1, { allowBreaking: true });
  await assert.rejects(grove.publish(ctx, 'old', 1), isError('conflict'));
  await assert.rejects(grove.saveDocument(ctx, 'old', { type: 'article', expectedRevision: 1, expectedSchemaVersion: 1, data: {} }), isError('conflict'));
  const updated = await grove.saveDocument(ctx, 'old', { type: 'article', expectedRevision: 1, expectedSchemaVersion: 2, data: {} });
  assert.equal(updated.draft.body, 'Retain me');
  await grove.publish(ctx, 'old', 2);
  assert.equal((await grove.deliver(ctx, 'old')).data.body, undefined);
});

test('tenant, site and environment isolation hold even when the host grants all scopes', async () => {
  const grove = new Grove(db, () => true);
  const base = { tenantId: randomUUID(), siteId: 'site', environment: 'development' };
  const scopes = [base, { ...base, tenantId: randomUUID() }, { ...base, siteId: 'other' }, { ...base, environment: 'production' }];
  for (const [i, scope] of scopes.entries()) {
    const ctx = { actor: { id: 'admin' }, scope };
    await grove.pushSchema(ctx, schema, 0);
    await grove.saveDocument(ctx, 'same-id', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: { en: String(i) } } });
    await grove.publish(ctx, 'same-id', 1);
  }
  for (const [i, scope] of scopes.entries()) {
    const ctx = { actor: { id: 'admin' }, scope };
    assert.equal((await grove.listDocuments(ctx)).length, 1);
    assert.equal((await grove.deliver(ctx, 'same-id', 'en')).data.title, String(i));
    assert.equal((await grove.history(ctx, 'same-id')).length, 2);
  }
});

test('edit, publish, schema, and delivery permissions are independent and scope bound', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  await grove.saveDocument(ctx, 'private', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: {} });
  const editor = { ...ctx, actor: { id: 'editor' } };
  const reader = { ...ctx, actor: { id: 'reader' } };
  await assert.rejects(grove.publish(editor, 'private', 1), isError('forbidden'));
  await assert.rejects(grove.pushSchema(editor, schema, 1), isError('forbidden'));
  await assert.rejects(grove.getDocument(reader, 'private'), isError('forbidden'));
  await assert.rejects(grove.history(reader, 'private'), isError('forbidden'));
  await assert.rejects(grove.getDocument({ ...ctx, scope: { ...ctx.scope, tenantId: 'outside' } }, 'private'), isError('forbidden'));
});

test('HTTP client completes lifecycle; unauthenticated and malformed requests fail safely', async () => {
  const { grove, ctx } = fixture();
  const handler = createHandler(grove, { authenticate: async req => {
    const id = req.headers.get('authorization'); return id && grants[id] ? { id } : null;
  } });
  const client = createClient({ baseUrl: 'http://grove.test', scope: ctx.scope, headers: () => ({ authorization: 'admin' }), fetch: async (input, init) => handler(new Request(input, init)) });
  await client.pushSchema(schema, 0);
  await client.saveDocument('http', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: { en: 'HTTP' } } });
  await client.publish('http', 1);
  assert.equal((await client.deliver('http', 'es')).data.title, 'HTTP');
  await assert.rejects(client.publish('http', 1), error => error instanceof GroveClientError && error.status === 409 && error.code === 'conflict');
  const root = `http://grove.test/v1/tenants/${ctx.scope.tenantId}/sites/site/environments/development`;
  assert.equal((await handler(new Request(`${root}/documents`))).status, 401);
  for (const payload of ['{', 'null', '[]']) {
    assert.equal((await handler(new Request(`${root}/documents/http`, { method: 'PUT', headers: { authorization: 'admin', 'content-type': 'application/json' }, body: payload }))).status, 400);
  }
  const reader = createClient({ baseUrl: 'http://grove.test', scope: ctx.scope, headers: () => ({ authorization: 'reader' }), fetch: async (input, init) => handler(new Request(input, init)) });
  await assert.rejects(reader.getDocument('http'), error => error instanceof GroveClientError && error.status === 403);
  assert.equal((await reader.deliver('http')).revision, 2);
});

test('list and history cursors are bounded and deterministic', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  for (const id of ['c', 'a', 'b']) await grove.saveDocument(ctx, id, { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: {} });
  assert.deepEqual((await grove.listDocuments(ctx, { limit: 2 })).map(d => d.id), ['a', 'b']);
  assert.deepEqual((await grove.listDocuments(ctx, { after: 'b' })).map(d => d.id), ['c']);
  await assert.rejects(grove.listDocuments(ctx, { limit: 101 }), isError('invalid_request'));
  await grove.saveDocument(ctx, 'a', { type: 'article', expectedRevision: 1, expectedSchemaVersion: 1, data: {} });
  assert.deepEqual((await grove.history(ctx, 'a', { before: 2, limit: 1 })).map(h => h.revision), [1]);
});

test('unchanged schemas round-trip through JSONB without creating a new version', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  const result = await grove.pushSchema(ctx, schema, 1);
  assert.equal(result.version, 1); assert.equal(result.applied, false); assert.deepEqual(result.changes, []);
  const reordered = { types: schema.types, defaultLocale: schema.defaultLocale, locales: schema.locales };
  assert.equal((await grove.pushSchema(ctx, reordered, 1)).applied, false);
});

test('malformed schemas and dangerous JSON values fail before storage', async () => {
  const { grove, ctx, initialize } = fixture(); await initialize();
  const invalid = [
    { ...schema, surprise: true },
    { ...schema, locales: ['en', 'en'] },
    { ...schema, types: [{ name: 'article', fields: [{ name: 'x', type: 'number', default: 'bad' }] }] },
    { ...schema, types: [{ name: 'article', fields: [{ name: 'x', type: 'number', owner: 'inventory' }] }] },
    { ...schema, types: [{ name: 'article', fields: [{ name: 'x', type: 'string', required: 'yes' }] }] },
  ];
  for (const candidate of invalid) await assert.rejects(grove.pushSchema(ctx, candidate as Schema, 1), isError('invalid_request'));
  await assert.rejects(grove.saveDocument(ctx, 'bad', { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: JSON.parse('{"__proto__":{"polluted":true}}') }), isError('invalid_request'));
  assert.equal((await grove.listDocuments(ctx)).length, 0);
});

test('CLI pushes a TypeScript schema and saves/publishes/restores through the real host', { timeout: 20_000 }, async () => {
  const token = randomUUID();
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: '0', DATABASE_URL: process.env.TEST_DATABASE_URL,
    GROVE_DEV_TOKEN: token, GROVE_TOKEN: token, GROVE_TENANT: randomUUID(), GROVE_SITE: 'demo', GROVE_ENVIRONMENT: 'development',
  };
  const host = spawn(process.execPath, ['apps/grove/dist/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  host.stderr.on('data', data => { stderr += data; });
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${stderr}`)), 5_000);
      host.once('error', error => { clearTimeout(timer); reject(error); });
      host.once('exit', () => { clearTimeout(timer); reject(new Error(`Host exited: ${stderr}`)); });
      host.stdout.on('data', data => {
        const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const cli = async (...args: string[]) => {
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', ...args], { env: { ...env, GROVE_URL: baseUrl } });
      return JSON.parse(result.stdout);
    };
    const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { origin: baseUrl, authorization: `Bearer ${token}` } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const browserSession = await login.json();
    const browserApi = `${baseUrl}/v1/tenants/${env.GROVE_TENANT}/sites/demo/environments/development`;
    assert.equal((await fetch(`${browserApi}/schema`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${browserApi}/schema`, { method: 'PUT', headers: { cookie, origin: baseUrl, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${baseUrl}/auth/session`, { headers: { cookie } })).status, 200);
    assert.ok(browserSession.csrf);
    assert.equal((await fetch(`${baseUrl}/v1/tenants/local/sites/demo/environments/development/schema`)).status, 401);
    assert.deepEqual(await cli('admin', 'modules'), []); // Normal token mode exposes no practice modules.
    assert.equal((await cli('schema', 'push', 'examples/schema.ts', '--expected', '0', '--dry-run')).applied, false);
    assert.equal((await cli('schema', 'push', 'examples/schema.ts', '--expected', '0')).version, 1);
    assert.equal((await cli('documents', 'save', 'hello', 'examples/article.json', '--type', 'article', '--expected', '0', '--schema', '1')).revision, 1);
    assert.equal((await cli('documents', 'publish', 'hello', '--expected', '1')).revision, 2);
    assert.equal((await cli('delivery', 'hello', '--locale', 'es')).data.title, 'Un lugar para tu contenido');
    assert.equal((await cli('documents', 'restore', 'hello', '--revision', '1', '--expected', '2')).revision, 3);
    assert.equal((await cli('delivery', 'hello')).revision, 2);
    assert.equal((await cli('documents', 'history', 'hello')).length, 3);
    await assert.rejects(cli('documents', 'publish', 'hello', '--expected', '1'));
  } finally {
    if (host.exitCode === null) {
      const exited = once(host, 'exit');
      host.kill('SIGTERM');
      await exited;
    }
  }
});

test('example site exposes published content but requires authentication for draft pages and referenced records', async () => {
  const grove = new Grove(db, () => true);
  const scope = { tenantId: randomUUID(), siteId: 'demo', environment: 'development' };
  const ctx = { actor: { id: 'local-developer' }, scope };
  await grove.pushSchema(ctx, schema, 0);
  for (const id of ['page', 'referenced-article']) {
    await grove.saveDocument(ctx, id, { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: { en: `Live ${id}` } } });
    await grove.publish(ctx, id, 1);
    await grove.saveDocument(ctx, id, { type: 'article', expectedRevision: 2, expectedSchemaVersion: 1, data: { title: { en: `Private ${id}` } } });
  }
  const handler = exampleApi(grove, scope, async request => request.headers.get('authorization') === 'editor' ? ctx.actor : null);
  for (const id of ['page', 'referenced-article']) {
    const live = await handler(new Request(`http://site.test/example-api/content/${id}`));
    assert.equal(live?.status, 200); assert.equal((await live!.json()).data.title, `Live ${id}`);
    assert.equal((await handler(new Request(`http://site.test/example-api/content/${id}?mode=preview`)))?.status, 401);
    const preview = await handler(new Request(`http://site.test/example-api/content/${id}?mode=preview`, { headers: { authorization: 'editor' } }));
    assert.equal(preview?.headers.get('cache-control'), 'no-store'); assert.equal((await preview!.json()).data.title.en, `Private ${id}`);
  }
});
