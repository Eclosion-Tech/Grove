import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { Scope } from '@eclosion-tech/grove';
import { createPostgresDatabase, migrate, GroveAdmin, GroveError, AdminActionRejected, InstanceKeys, generateSigningKey, loadSigningKey, signRequest, verifyRequest, SignatureError, createRemoteModuleHandler, remoteModule, validateEndpoint, validateDescriptor, describe, MemoryLedger, RemoteProtocolError, type AdminModule, type Context, type Permission, type SigningKey } from '@eclosion-tech/grove/server';

const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
const isError = (code: GroveError['code']) => (error: unknown) => error instanceof GroveError && error.code === code;
before(async () => { await migrate(db); });
after(async () => { await db.close(); });

/** The application side: an in-memory module with per-actor record authorization and a state machine. */
function application() {
  const rows = new Map<string, { id: string; version: number; owner: string; status: string; note: string; executions: number }>();
  rows.set('r1', { id: 'r1', version: 1, owner: 'alex', status: 'pending', note: 'first', executions: 0 });
  rows.set('r2', { id: 'r2', version: 1, owner: 'sam', status: 'pending', note: 'second', executions: 0 });
  rows.set('r3', { id: 'r3', version: 1, owner: 'alex', status: 'done', note: 'third', executions: 0 });
  rows.set('r4', { id: 'r4', version: 1, owner: 'boss', status: 'pending', note: 'fourth', executions: 0 });
  const record = (r: { id: string; version: number; owner: string; status: string; note: string }) => ({ id: r.id, version: r.version, values: { owner: r.owner, status: r.status, note: r.note } });
  const canSee = (ctx: Context, id: string) => ctx.actor.id === 'boss' || rows.get(id)?.owner === ctx.actor.id;
  const behaviour = { delayMs: 0, fail: '' as '' | 'crash' | 'reject' };
  const module: AdminModule = { id: 'app', label: 'Application', description: 'Remote records', resources: [{
    id: 'items', label: 'Items', description: 'Owned items', permission: 'admin:app:read',
    columns: [{ name: 'owner', label: 'Owner', type: 'text' }, { name: 'status', label: 'Status', type: 'status' }, { name: 'note', label: 'Note', type: 'text', permission: 'admin:app:notes' }],
    filters: [{ name: 'status', label: 'Status', type: 'string' }],
    source: {
      async query(ctx, { filters, cursor, limit }) { const all = [...rows.values()].filter(r => !filters.status || r.status === filters.status).map(record); const offset = cursor ? Number(cursor) : 0; return { records: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null }; },
      async get(_ctx, id) { const r = rows.get(id); return r ? record(r) : null; },
      authorizeRecord: (ctx, r) => canSee(ctx, r.id),
    },
    actions: [{ id: 'confirm', label: 'Confirm', description: 'Confirms the item.', confirmation: 'Confirm?', inputs: [{ name: 'note', label: 'Note', type: 'string' }], permission: 'admin:app:confirm',
      available: (_ctx, r) => r.values.status === 'pending',
      async execute(_ctx, request) {
        const r = rows.get(request.record.id)!; r.executions += 1;
        if (behaviour.delayMs) await new Promise(resolve => setTimeout(resolve, behaviour.delayMs));
        if (behaviour.fail === 'crash') throw new Error('database exploded with secret details');
        if (behaviour.fail === 'reject') throw new AdminActionRejected('Business rule says no');
        if (r.version !== request.expectedVersion) throw new AdminActionRejected('stale');
        r.status = 'done'; r.version += 1; if (typeof request.values.note === 'string') r.note = request.values.note;
      } }],
  }] };
  return { module, rows, behaviour };
}
async function serve(handler: (request: Request) => Promise<Response>): Promise<{ origin: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const response = await handler(new Request(`http://127.0.0.1:${(server.address() as { port: number }).port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'POST' ? body : undefined }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}
const grants: Record<string, Permission[]> = { boss: ['admin:app:read', 'admin:app:notes', 'admin:app:confirm'], alex: ['admin:app:read', 'admin:app:confirm'], sam: ['admin:app:read'] };
/** Grove side: a workspace whose authorize grants module permissions per actor. */
function grove(scope: Scope) {
  const authorize = async (actor: { id: string }, requested: Scope, permission: Permission) => requested.tenantId === scope.tenantId && (grants[actor.id]?.includes(permission) ?? false);
  const as = (id: string): Context => ({ actor: { id }, scope });
  return { authorize, as };
}

test('requests are signed with an instance key, verified by key id, and refused when tampered, stale or unknown', async () => {
  const generated = generateSigningKey();
  const key = loadSigningKey(generated.kid, generated.privateKeyPem);
  const body = JSON.stringify({ context: { hostId: 'grove-test', connectionId: 'app' } });
  const headers = signRequest(key, { method: 'POST', path: '/x/catalog', body });
  assert.match(headers['grove-signature']!, new RegExp(`^v1,kid=${key.kid},ts=\\d+,sig=[A-Za-z0-9_-]+$`));
  const resolveKey = (kid: string) => kid === key.kid ? key.publicJwk : undefined;
  assert.equal((await verifyRequest({ method: 'POST', path: '/x/catalog', body, headers, resolveKey })).kid, key.kid);
  await assert.rejects(verifyRequest({ method: 'POST', path: '/x/catalog', body: body + ' ', headers, resolveKey }), (e: unknown) => e instanceof SignatureError && /match/.test(e.message));
  await assert.rejects(verifyRequest({ method: 'POST', path: '/y/catalog', body, headers, resolveKey }), SignatureError);
  await assert.rejects(verifyRequest({ method: 'POST', path: '/x/catalog', body, headers, resolveKey: () => undefined }), /Unknown signing key/);
  await assert.rejects(verifyRequest({ method: 'POST', path: '/x/catalog', body, headers, resolveKey, now: () => Date.now() + 10 * 60_000 }), /out of range/);
  await assert.rejects(verifyRequest({ method: 'POST', path: '/x/catalog', body, headers: { ...headers, 'grove-admin-version': '2.0' }, resolveKey }), /protocol version/);
  await assert.rejects(verifyRequest({ method: 'POST', path: '/x/catalog', body, headers: { 'grove-admin-version': '1.0', 'grove-signature': 'v1,kid=x,ts=abc,sig=short' }, resolveKey }), /Malformed/);
  const keys = new InstanceKeys(db);
  const first = await keys.current(); const again = await keys.current();
  assert.equal(first.kid, again.kid);
  const rotated = await keys.rotate();
  assert.notEqual(rotated.kid, first.kid);
  const published = (await keys.published()).keys.map(k => k.kid);
  assert.ok(published.includes(rotated.kid) && published.includes(first.kid), 'retired key stays published for a grace period');
  assert.equal((await keys.current()).kid, rotated.kid);
});

test('endpoints and catalogs are validated as untrusted input', async () => {
  assert.equal(validateEndpoint('https://api.worm.so/grove-admin/v1/'), 'https://api.worm.so/grove-admin/v1');
  for (const bad of ['http://api.worm.so/x', 'https://user:pw@api.worm.so/x', 'https://api.worm.so/x?y=1', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://172.16.0.1/x', 'https://169.254.169.254/latest', 'https://internal.local/x', 'ftp://x', 'nope']) assert.throws(() => validateEndpoint(bad), isError('invalid_request'), bad);
  assert.throws(() => validateEndpoint('http://127.0.0.1:9/x'), isError('invalid_request'));
  assert.equal(validateEndpoint('http://127.0.0.1:9/x', true), 'http://127.0.0.1:9/x');
  const good = describe(application().module);
  assert.deepEqual(validateDescriptor(good).resources[0]!.actions[0]!.permission, 'admin:app:confirm');
  assert.throws(() => validateDescriptor({ ...good, resources: [{ ...good.resources[0], permission: 'admin:other:read' }] }), /must start with admin:app:/);
  assert.throws(() => validateDescriptor({ ...good, resources: [{ ...good.resources[0], columns: [{ name: 'x', label: 'X', type: 'html' }] }] }), isError('invalid_request'));
  assert.throws(() => validateDescriptor({ ...good, resources: [] }), /1–50 resources/);
  assert.throws(() => validateDescriptor({ ...good, id: '../evil' }), isError('invalid_request'));
});

test('a remote module serves catalog, records with access decisions, and journaled actions across the wire', async t => {
  const app = application();
  const keys = new InstanceKeys(db); const key = await keys.current();
  const scope: Scope = { tenantId: randomUUID(), siteId: 'site', environment: 'production' };
  const executions: string[] = [];
  const handler = createRemoteModuleHandler({ module: app.module, catalogRevision: 'app-1', resolveKey: async kid => (await keys.published()).keys.find(k => k.kid === kid), allow: c => c.hostId === 'grove-test' && (!c.scope || c.scope.tenantId === scope.tenantId), onError: e => executions.push(String(e)) });
  const { origin, server } = await serve(handler); t.after(() => server.close());
  const g = grove(scope);
  const module = await remoteModule({ connection: { id: 'app', endpoint: origin, hostId: 'grove-test' }, key, authorize: g.authorize, allowLoopback: true, timeoutMs: 1000, statusPolls: 1 });
  const admin = new GroveAdmin(db, g.authorize, [module]);
  const catalog = await admin.catalog(g.as('alex'));
  assert.equal(catalog[0]!.id, 'app'); assert.deepEqual(catalog[0]!.resources[0]!.columns.map(c => c.name), ['owner', 'status'], 'notes column hidden without its permission');
  assert.deepEqual((await admin.catalog(g.as('boss')))[0]!.resources[0]!.columns.map(c => c.name), ['owner', 'status', 'note']);
  assert.deepEqual(await admin.catalog(g.as('nobody')), []);
  const alexPage = await admin.query(g.as('alex'), 'app', 'items');
  assert.deepEqual(alexPage.records.map(r => [r.id, r.actions]), [['r1', ['confirm']], ['r3', []]], 'the application decides visibility and availability');
  assert.deepEqual((await admin.query(g.as('sam'), 'app', 'items')).records.map(r => [r.id, r.actions]), [['r2', []]], 'sam lacks the confirm permission');
  assert.deepEqual((await admin.query(g.as('boss'), 'app', 'items')).records.map(r => r.id), ['r1', 'r2', 'r3', 'r4']);
  assert.equal((await admin.query(g.as('boss'), 'app', 'items', { filters: { status: 'pending' }, limit: 1 })).nextCursor, '1');
  await assert.rejects(admin.get(g.as('sam'), 'app', 'items', 'r1'), isError('not_found'));
  const run = (actor: string, requestId: string, expectedVersion = 1, values = {}) => admin.run(g.as(actor), 'app', 'items', 'confirm', { requestId, recordId: 'r1', expectedVersion, values });
  await assert.rejects(run('sam', 'req-0'), isError('forbidden'));
  const done = await run('alex', 'req-1', 1, { note: 'confirmed remotely' });
  assert.equal(done.status, 'succeeded'); assert.equal(app.rows.get('r1')!.status, 'done'); assert.equal(app.rows.get('r1')!.note, 'confirmed remotely'); assert.equal(app.rows.get('r1')!.executions, 1);
  assert.equal((await admin.get(g.as('alex'), 'app', 'items', 'r1')).version, 2);
  assert.equal((await run('alex', 'req-1', 1, { note: 'confirmed remotely' })).status, 'succeeded', 'replaying the same request id returns the journal entry without executing');
  assert.equal(app.rows.get('r1')!.executions, 1);
  await assert.rejects(run('alex', 'req-2', 1), isError('conflict'), 'stale version is refused before dispatch');
  await assert.rejects(run('alex', 'req-3', 2), isError('conflict'), 'confirm is no longer available');
  app.behaviour.fail = 'reject';
  const rejected = await admin.run(g.as('boss'), 'app', 'items', 'confirm', { requestId: 'req-4', recordId: 'r2', expectedVersion: 1, values: {} });
  assert.equal(rejected.status, 'rejected'); assert.equal(app.rows.get('r2')!.status, 'pending');
  app.behaviour.fail = 'crash';
  const crashed = await admin.run(g.as('boss'), 'app', 'items', 'confirm', { requestId: 'req-5', recordId: 'r2', expectedVersion: 1, values: {} });
  assert.equal(crashed.status, 'uncertain');
  assert.ok(!JSON.stringify(crashed).includes('secret details'), 'application error text never reaches Grove');
  await assert.rejects(admin.run(g.as('boss'), 'app', 'items', 'confirm', { requestId: 'req-6', recordId: 'r2', expectedVersion: 1, values: {} }), isError('conflict'), 'uncertain outcome blocks the record');
  app.behaviour.fail = ''; app.behaviour.delayMs = 1500;
  const timedOut = await admin.run(g.as('boss'), 'app', 'items', 'confirm', { requestId: 'req-7', recordId: 'r4', expectedVersion: 1, values: {} });
  assert.equal(timedOut.status, 'uncertain', 'a timeout after dispatch is uncertain, never rejected');
  const activity = await admin.activity(g.as('boss'), 'app', 'items');
  assert.deepEqual(activity.map(a => [a.id, a.status]).sort(), [['req-4', 'rejected'], ['req-5', 'uncertain'], ['req-7', 'uncertain']]);
});

test('the application handler replays by operation id, reports status, and refuses bad signatures, workspaces and catalogs', async t => {
  const app = application();
  const key = loadSigningKey('k1', generateSigningKey().privateKeyPem);
  const other = loadSigningKey('k2', generateSigningKey().privateKeyPem);
  const ledger = new MemoryLedger();
  const handler = createRemoteModuleHandler({ module: app.module, catalogRevision: 'app-1', resolveKey: kid => kid === 'k1' ? key.publicJwk : undefined, allow: c => c.hostId === 'grove-test' && (!c.scope || c.scope.siteId === 'site'), ledger });
  const { origin, server } = await serve(handler); t.after(() => server.close());
  const scope: Scope = { tenantId: 'org', siteId: 'site', environment: 'production' };
  const context = { hostId: 'grove-test', connectionId: 'app', scope, actor: { id: 'boss', permissions: ['admin:app:read', 'admin:app:confirm'] } };
  const post = async (path: string, payload: unknown, signer: SigningKey = key) => { const body = JSON.stringify(payload); const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(signer, { method: 'POST', path, body }) }, body }); return { status: response.status, body: await response.json() as any }; };
  assert.equal((await post('/catalog', { context: { hostId: 'grove-test', connectionId: 'app' } }, other)).status, 401);
  assert.equal((await fetch(origin + '/catalog', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await post('/catalog', { context: { hostId: 'someone-else', connectionId: 'app' } })).status, 403);
  assert.equal((await post('/resources/items/query', { context: { ...context, scope: { ...scope, siteId: 'other' } }, catalogRevision: 'app-1', filters: {}, cursor: null, limit: 10 })).status, 403);
  assert.equal((await post('/resources/items/query', { context, catalogRevision: 'app-0', filters: {}, cursor: null, limit: 10 })).body.error.code, 'catalog_changed');
  const { inputHash } = await import('@eclosion-tech/grove/server');
  const hash = inputHash('r1', 1, { note: 'x' });
  const action = { context, catalogRevision: 'app-1', operationId: 'op-1', inputHash: hash, recordId: 'r1', expectedVersion: 1, values: { note: 'x' } };
  const stale = await post('/resources/items/actions/confirm', { ...action, catalogRevision: 'app-0' });
  assert.equal(stale.status, 409); assert.equal(stale.body.status, 'rejected'); assert.equal(stale.body.noEffectsCommitted, true); assert.equal(stale.body.error.code, 'catalog_changed');
  assert.equal((await post('/resources/items/actions/confirm', { ...action, inputHash: 'wrong' })).status, 400);
  assert.deepEqual((await post('/operations/op-1', { context, operationId: 'op-1', inputHash: hash })).body, { operationId: 'op-1', inputHash: hash, status: 'unknown' });
  const first = await post('/resources/items/actions/confirm', action);
  assert.equal(first.status, 200); assert.equal(first.body.status, 'succeeded'); assert.equal(app.rows.get('r1')!.executions, 1);
  const replay = await post('/resources/items/actions/confirm', action);
  assert.deepEqual(replay.body, first.body); assert.equal(app.rows.get('r1')!.executions, 1, 'the ledger answers a replay without executing again');
  assert.equal((await post('/resources/items/actions/confirm', { ...action, inputHash: inputHash('r1', 1, { note: 'y' }), values: { note: 'y' } })).body.error.code, 'idempotency_conflict');
  assert.equal((await post('/operations/op-1', { context, operationId: 'op-1', inputHash: hash })).body.status, 'succeeded');
  const late = await post('/resources/items/actions/confirm', { ...action, operationId: 'op-2', inputHash: inputHash('r1', 1, {}), values: {} });
  assert.equal(late.body.status, 'rejected'); assert.equal(late.body.error.code, 'stale_version');
  assert.equal((await post('/resources/items/actions/confirm', { ...action, operationId: 'op-3', context: { ...context, actor: { id: 'sam', permissions: ['admin:app:read'] } }, recordId: 'r2', inputHash: inputHash('r2', 1, { note: 'x' }) })).body.error.code, 'forbidden');
});

test('a running outcome is polled and resolved; an unverifiable outcome is uncertain', async () => {
  const key = loadSigningKey('k1', generateSigningKey().privateKeyPem);
  const scope: Scope = { tenantId: randomUUID(), siteId: 'site', environment: 'production' };
  const g = grove(scope);
  const catalogBody = JSON.stringify({ catalogRevision: 'app-1', module: describe(application().module) });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'grove-admin-version': '1.0' } });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const payload = JSON.parse(String(init?.body ?? '{}')); calls.push(url.pathname);
    if (url.pathname.endsWith('/catalog')) return reply(JSON.parse(catalogBody));
    if (url.pathname.endsWith('/records/r1')) return reply({ catalogRevision: 'app-1', record: { id: 'r1', version: 1, values: { owner: 'boss', status: 'pending', note: '' }, access: { read: true, actions: { confirm: { authorized: true, available: true } } } } });
    if (url.pathname.includes('/actions/')) return reply({ operationId: payload.operationId, inputHash: payload.inputHash, status: 'running' }, 202);
    if (url.pathname.includes('/operations/')) return reply({ operationId: payload.operationId, inputHash: payload.inputHash, status: calls.filter(c => c.includes('/operations/')).length >= 2 ? 'succeeded' : 'running' });
    return reply({ error: { code: 'not_found', message: 'no' } }, 404);
  };
  const module = await remoteModule({ connection: { id: 'app', endpoint: 'https://app.example', hostId: 'grove-test' }, key, authorize: g.authorize, fetcher, statusPolls: 3 });
  const admin = new GroveAdmin(db, g.authorize, [module]);
  const result = await admin.run(g.as('boss'), 'app', 'items', 'confirm', { requestId: 'poll-1', recordId: 'r1', expectedVersion: 1, values: {} });
  assert.equal(result.status, 'succeeded'); assert.equal(calls.filter(c => c.includes('/operations/')).length, 2);
  const bogus: typeof fetch = async (input, init) => { const url = new URL(String(input)); if (url.pathname.endsWith('/catalog')) return reply(JSON.parse(catalogBody)); if (url.pathname.endsWith('/records/r1')) return fetcher(input, init); return reply({ operationId: 'someone-else', status: 'succeeded' }); };
  const module2 = await remoteModule({ connection: { id: 'app2', endpoint: 'https://app.example', hostId: 'grove-test' }, key, authorize: g.authorize, fetcher: bogus });
  const admin2 = new GroveAdmin(db, g.authorize, [module2]);
  assert.equal((await admin2.run(g.as('boss'), 'app', 'items', 'confirm', { requestId: 'poll-2', recordId: 'r1', expectedVersion: 1, values: {} })).status, 'uncertain');
  await assert.rejects(remoteModule({ connection: { id: 'app3', endpoint: 'https://app.example', hostId: 'grove-test' }, key, authorize: g.authorize, fetcher: async () => new Response('{}', { status: 200, headers: { 'grove-admin-version': '3.0' } }) }), RemoteProtocolError);
});

test('applications resolve Grove keys from the well-known document with caching and one refresh on rotation', async () => {
  const { remoteKeyResolver } = await import('@eclosion-tech/grove/server');
  const a = generateSigningKey(); const b = generateSigningKey();
  let served = [a.publicJwk]; let fetches = 0;
  const fetcher: typeof fetch = async () => { fetches += 1; return new Response(JSON.stringify({ keys: served }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const resolve = remoteKeyResolver('https://grove.example/.well-known/grove-keys', { fetcher, ttlMs: 60_000 });
  assert.equal((await resolve(a.kid))?.x, a.publicJwk.x); assert.equal((await resolve(a.kid))?.x, a.publicJwk.x); assert.equal(fetches, 1, 'cached');
  assert.equal(await resolve(b.kid), undefined); assert.equal(fetches, 1, 'an unknown id right after a fetch does not refetch');
  const later = remoteKeyResolver('https://grove.example/.well-known/grove-keys', { fetcher, ttlMs: 60_000 });
  await later(a.kid); served = [b.publicJwk, a.publicJwk];
  assert.equal(await later(b.kid), undefined, 'still within the refresh guard');
  assert.throws(() => remoteKeyResolver('http://grove.example/.well-known/grove-keys'), /https/);
  const failing = remoteKeyResolver('https://grove.example/.well-known/grove-keys', { fetcher: async () => new Response('nope', { status: 500 }) });
  await assert.rejects(failing(a.kid), SignatureError);
});
