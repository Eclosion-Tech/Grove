import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { Scope, WorkspaceConfig } from '@eclosion-tech/grove';
import { createPostgresDatabase, migrate, Grove, GroveAdmin, GroveError, InstanceKeys, createHandler, createRemoteModuleHandler, MemoryLedger, applyWorkspaceConfig, type AdminModule, type Context, type Permission } from '@eclosion-tech/grove/server';
import { createClient, GroveClientError } from '../packages/grove/src/client.js';
import { connectionsFor, moduleProvider } from '../apps/grove/src/modules.js';
import { compose } from '../apps/grove/src/serve.js';

const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
const isError = (code: GroveError['code']) => (error: unknown) => error instanceof GroveError && error.code === code;
const isStatus = (status: number) => (error: unknown) => error instanceof GroveClientError && error.status === status;
before(async () => { await migrate(db); });
after(async () => { await db.close(); });

const HOST = 'http://grove.test';
function application(): AdminModule {
  const rows = new Map([['r1', { id: 'r1', version: 1, values: { title: 'One', status: 'pending' } }]]);
  return { id: 'app', label: 'Application', description: 'Remote records', resources: [{
    id: 'items', label: 'Items', description: 'Items', permission: 'admin:app:read',
    columns: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'status', label: 'Status', type: 'status' }], filters: [],
    source: { async query() { return { records: [...rows.values()], nextCursor: null }; }, async get(_c, id) { return rows.get(id) ?? null; }, authorizeRecord: () => true },
    actions: [{ id: 'close', label: 'Close', description: 'Closes.', confirmation: 'Close?', inputs: [], permission: 'admin:app:close', available: (_c, r) => r.values.status === 'pending', async execute(_c, { record }) { const r = rows.get(record.id)!; r.values = { ...r.values, status: 'closed' }; r.version += 1; } }],
  }] };
}
async function serveApp(keys: InstanceKeys, revision: { current: string }): Promise<{ origin: string; server: Server }> {
  const options = { module: application(), catalogRevision: revision.current, resolveKey: async (kid: string) => (await keys.published()).keys.find(k => k.kid === kid), allow: (c: { hostId: string }) => c.hostId === HOST, ledger: new MemoryLedger() };
  const handler = createRemoteModuleHandler(options);
  const server = createServer(async (req, res) => {
    options.catalogRevision = revision.current;
    let body = ''; for await (const chunk of req) body += chunk;
    const response = await handler(new Request(`http://127.0.0.1:${(server.address() as { port: number }).port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'POST' ? body : undefined }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}
/** A deployed-style workspace: operator plus Grove-owned membership, connections signed by the instance key. */
function workspace() {
  const scope: Scope = { tenantId: randomUUID(), siteId: 'site', environment: 'production' };
  const inScope = (requested: Scope) => requested.tenantId === scope.tenantId && requested.siteId === scope.siteId && requested.environment === scope.environment;
  const authorize = async (actor: { id: string }, requested: Scope, permission: Permission) => inScope(requested) && (actor.id === 'operator' ? true : grove.members.authorize(actor, requested, permission));
  const grove: Grove = new Grove(db, authorize);
  const keys = new InstanceKeys(db);
  const connections = connectionsFor(db, { keys, hostId: HOST, authorize, allowLoopback: true });
  const admin = new GroveAdmin(db, authorize, moduleProvider({ modules: [], connections }));
  const as = (id: string): Context => ({ actor: { id }, scope });
  const handler = createHandler(grove, { admin, connections, authenticate: async request => { const id = request.headers.get('authorization')?.replace('Bearer ', ''); return id ? { id } : null; } });
  const client = (actor: string) => createClient({ baseUrl: HOST, scope, headers: () => ({ Authorization: `Bearer ${actor}` }), fetch: (input, init) => handler(new Request(input, init)) });
  return { scope, grove, keys, connections, admin, as, operator: as('operator'), client, handler };
}

test('owners register connections after a signed catalog handshake; endpoints and catalog changes are enforced', async t => {
  const w = workspace();
  const revision = { current: 'app-1' };
  const { origin, server } = await serveApp(w.keys, revision); t.after(() => server.close());
  await w.grove.members.invite(w.operator, { email: 'owner@example.org', role: 'owner' }); await w.grove.members.resolve(w.scope, { subject: 'owner-1', email: 'owner@example.org', emailVerified: true });
  await w.grove.members.invite(w.operator, { email: 'dev@example.org', role: 'developer' }); await w.grove.members.resolve(w.scope, { subject: 'dev-1', email: 'dev@example.org', emailVerified: true });
  await assert.rejects(w.connections.register(w.as('dev-1'), { id: 'app', endpoint: origin }), isError('forbidden'));
  await assert.rejects(w.connections.register(w.as('owner-1'), { id: 'app', endpoint: 'http://api.example/x' }), isError('invalid_request'));
  await assert.rejects(w.connections.register(w.as('owner-1'), { id: 'app', endpoint: 'http://127.0.0.1:1/grove' }), /could not be loaded/);
  assert.equal((await w.connections.register(w.as('owner-1'), { id: 'mounted', endpoint: `${origin}/any/base` })).moduleId, 'app', 'the handler serves under any mount path');
  await w.connections.remove(w.as('owner-1'), 'mounted');
  const first = await w.connections.register(w.as('owner-1'), { id: 'app', endpoint: origin + '/' });
  assert.equal(first.changed, true); assert.equal(first.moduleId, 'app'); assert.equal(first.catalogRevision, 'app-1'); assert.equal(first.endpoint, origin);
  assert.equal((await w.connections.register(w.as('owner-1'), { id: 'app', endpoint: origin })).changed, false);
  assert.deepEqual((await w.connections.list(w.as('dev-1'))).map(c => c.id), ['app'], 'developers can read connections');
  assert.deepEqual(await w.admin.catalog(w.as('owner-1')).then(c => c.map(m => m.id)), ['app'], 'the registered module appears in the workspace catalog');
  assert.deepEqual(await w.admin.catalog(w.as('dev-1')), [], 'a developer holds no module permission yet');
  const fingerprint = await w.connections.fingerprint(w.scope);
  revision.current = 'app-2';
  const loaded = await w.connections.modules(w.scope);
  assert.equal(loaded.modules.length, 0); assert.match(loaded.failed[0]!.reason, /contract changed/);
  assert.equal((await w.connections.register(w.as('owner-1'), { id: 'app', endpoint: origin })).catalogRevision, 'app-2', 're-registering reviews the new contract');
  assert.notEqual(await w.connections.fingerprint(w.scope), fingerprint);
  assert.equal((await w.connections.modules(w.scope)).modules.length, 1);
  await w.connections.remove(w.as('owner-1'), 'app');
  await assert.rejects(w.connections.remove(w.as('owner-1'), 'app'), isError('not_found'));
  assert.deepEqual(await w.admin.catalog(w.as('owner-1')), []);
});

test('role grants give every member with a role the module permissions owners chose', async t => {
  const w = workspace();
  const { origin, server } = await serveApp(w.keys, { current: 'app-1' }); t.after(() => server.close());
  await w.connections.register(w.operator, { id: 'app', endpoint: origin });
  await w.grove.members.invite(w.operator, { email: 'ed@example.org', role: 'editor' }); await w.grove.members.resolve(w.scope, { subject: 'ed-1', email: 'ed@example.org', emailVerified: true });
  assert.deepEqual(await w.admin.catalog(w.as('ed-1')), []);
  await assert.rejects(w.grove.members.setRoleGrants(w.as('ed-1'), { editor: ['admin:app:read'] }), isError('forbidden'));
  await assert.rejects(w.grove.members.setRoleGrants(w.operator, { owner: ['admin:app:read'] } as never), isError('invalid_request'));
  await assert.rejects(w.grove.members.setRoleGrants(w.operator, { editor: ['content:publish'] }), isError('invalid_request'));
  const set = await w.grove.members.setRoleGrants(w.operator, { editor: ['admin:app:read', 'admin:app:read'], viewer: [] });
  assert.deepEqual(set, { grants: { editor: ['admin:app:read'] }, changed: true });
  assert.equal((await w.grove.members.setRoleGrants(w.operator, { editor: ['admin:app:read'] })).changed, false);
  assert.deepEqual(await w.grove.members.roleGrants(w.operator), { editor: ['admin:app:read'] });
  assert.deepEqual((await w.admin.catalog(w.as('ed-1'))).map(m => m.id), ['app']);
  assert.deepEqual((await w.admin.query(w.as('ed-1'), 'app', 'items')).records.map(r => [r.id, r.actions]), [['r1', []]], 'read granted by role, close still not');
  await w.grove.members.setRoleGrants(w.operator, { editor: ['admin:app:read', 'admin:app:close'] });
  assert.deepEqual((await w.admin.query(w.as('ed-1'), 'app', 'items')).records[0]!.actions, ['close']);
  assert.equal((await w.admin.run(w.as('ed-1'), 'app', 'items', 'close', { requestId: 'r-1', recordId: 'r1', expectedVersion: 1, values: {} })).status, 'succeeded');
  await w.grove.members.setRoleGrants(w.operator, {});
  assert.deepEqual(await w.admin.catalog(w.as('ed-1')), []);
});

test('a workspace config pushes schema, connections and role grants declaratively, with a dry run first', async t => {
  const w = workspace();
  const { origin, server } = await serveApp(w.keys, { current: 'app-1' }); t.after(() => server.close());
  const config: WorkspaceConfig = { formatVersion: 1, schema: { locales: ['en'], defaultLocale: 'en', types: [{ name: 'note', fields: [{ name: 'title', type: 'string' }] }] }, connections: [{ id: 'app', endpoint: origin }], roleGrants: { editor: ['admin:app:read'] } };
  const operator = w.client('operator');
  const plan = await operator.pushConfig(config, { expectedSchemaVersion: 0, dryRun: true });
  assert.equal(plan.applied, false); assert.equal(plan.schema!.applied, false); assert.equal(plan.schema!.changes.length, 1);
  assert.deepEqual(plan.connections, [{ id: 'app', status: 'registered' }]); assert.deepEqual(plan.roleGrants, { changed: true });
  assert.equal(await w.grove.getSchema(w.operator), null, 'dry run wrote nothing'); assert.deepEqual(await w.connections.list(w.operator), []);
  const applied = await operator.pushConfig(config, { expectedSchemaVersion: 0 });
  assert.equal(applied.applied, true); assert.equal(applied.schema!.version, 1); assert.deepEqual(applied.connections, [{ id: 'app', status: 'registered' }]); assert.deepEqual(applied.roleGrants, { changed: true });
  const again = await operator.pushConfig(config, { expectedSchemaVersion: 1 });
  assert.equal(again.schema!.version, 1); assert.deepEqual(again.connections, [{ id: 'app', status: 'unchanged' }]); assert.deepEqual(again.roleGrants, { changed: false });
  const broken = await operator.pushConfig({ formatVersion: 1, connections: [{ id: 'broken', endpoint: 'https://10.0.0.1/x' }] });
  assert.equal(broken.connections[0]!.status, 'failed'); assert.match(broken.connections[0]!.reason!, /public host/);
  await assert.rejects(operator.pushConfig({ formatVersion: 2 } as never), isStatus(400));
  await assert.rejects(operator.pushConfig({ formatVersion: 1, schema: config.schema }), isStatus(400), 'a schema needs an expected version');
  await w.grove.members.invite(w.operator, { email: 'ed@example.org', role: 'editor' }); await w.grove.members.resolve(w.scope, { subject: 'ed-1', email: 'ed@example.org', emailVerified: true });
  await assert.rejects(w.client('ed-1').pushConfig({ formatVersion: 1, roleGrants: {} }), isStatus(403));
  assert.deepEqual((await w.client('ed-1').listConnections().catch(e => e)).status, 403);
  assert.deepEqual((await operator.listConnections()).map(c => [c.id, c.catalogRevision]), [['app', 'app-1']]);
  assert.deepEqual(await operator.roleGrants(), { editor: ['admin:app:read'] });
  assert.deepEqual(await operator.removeConnection('app'), { ok: true });
  await assert.rejects(applyWorkspaceConfig(w.operator, { grove: w.grove }, { formatVersion: 1, connections: [] }), isError('invalid_request'), 'hosts without connections refuse them');
});

test('the well-known route publishes the instance keys', async () => {
  const keys = new InstanceKeys(db);
  const route = compose({ keys, access: { authenticate: async () => null, protect: () => null, route: async () => null }, email: async () => null, clientSite: async () => null, handler: async () => new Response('api'), static: async () => new Response('static') });
  const response = await route(new Request('http://grove.test/.well-known/grove-keys'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  const body = await response.json();
  assert.equal(body.keys[0].kid, (await keys.current()).kid); assert.equal(body.keys[0].kty, 'OKP'); assert.equal(body.keys[0].crv, 'Ed25519'); assert.ok(!JSON.stringify(body).includes('PRIVATE'));
  assert.equal((await route(new Request('http://grove.test/.well-known/grove-keys', { method: 'POST' }))).status, 405);
  assert.equal(await (await route(new Request('http://grove.test/other'))).text(), 'static');
});
