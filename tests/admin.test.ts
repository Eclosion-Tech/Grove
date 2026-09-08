import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { GroveAdmin, Grove, GroveError, AdminActionRejected, createPostgresDatabase, migrate, createAdminHandler, type Authorize, type AdminModule } from '@eclosion-tech/grove/server';
import { createClient, GroveClientError } from '@eclosion-tech/grove/client';
import { seedAdminDemo, demoAdminModules } from '../apps/grove/src/admin-demo.js';
const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
before(async () => { await migrate(db); }); after(async () => { await db.close(); });
const error = (code: string) => (e: unknown) => e instanceof GroveError && e.code === code;
async function fixture() {
  const scope = { tenantId: randomUUID(), siteId: 'operations', environment: 'test' };
  await seedAdminDemo(db, scope);
  const grants: Record<string, string[]> = {
    'demo-coordinator': ['admin:registrations:read', 'admin:registrations:personal', 'admin:registrations:confirm'],
    'demo-reviewer': ['admin:curriculum:read', 'admin:curriculum:review'],
    'demo-observer': ['admin:registrations:read', 'admin:curriculum:read'],
  };
  const authorize: Authorize = (actor, target, permission) => target.tenantId === scope.tenantId && target.siteId === scope.siteId && target.environment === scope.environment && (actor.id === 'local-developer' || grants[actor.id]?.includes(permission) === true);
  const modules = demoAdminModules(db, scope); const admin = new GroveAdmin(db, authorize, modules);
  const ctx = { scope, actor: { id: 'local-developer' } }; const coordinator = { scope, actor: { id: 'demo-coordinator' } }; const observer = { scope, actor: { id: 'demo-observer' } }; const reviewer = { scope, actor: { id: 'demo-reviewer' } };
  const input = () => ({ requestId: randomUUID(), recordId: 'reg-01', expectedVersion: 1, values: {} });
  return { admin, modules, authorize, grants, ctx, coordinator, observer, reviewer, input };
}

test('admin works without a CMS schema; catalog, rows, fields, and actions are role-scoped', async () => {
  const { admin, ctx, coordinator, reviewer, observer } = await fixture();
  assert.equal(await new Grove(db, () => true).getSchema(ctx), null);
  assert.deepEqual((await admin.catalog(coordinator)).map(m => m.id), ['registrations']);
  assert.deepEqual((await admin.catalog(reviewer)).map(m => m.id), ['curriculum']);
  const catalog = await admin.catalog(observer);
  assert.equal(catalog.length, 2); assert.equal(catalog[0]!.resources[0]!.actions.length, 0);
  assert.ok(!JSON.stringify(catalog).includes('permission')); assert.ok(!JSON.stringify(catalog).includes('authorizeRecord'));
  assert.ok(!catalog[0]!.resources[0]!.columns.some(c => c.name === 'email'));
  const observed = await admin.query(observer, 'registrations', 'roster');
  assert.equal(observed.records.length, 3);
  assert.ok(observed.records.every(r => !('email' in r.values) && !('note' in r.values) && !('assignedTo' in r.values) && r.actions.length === 0));
  assert.deepEqual((await admin.query(coordinator, 'registrations', 'roster')).records.map(r => r.id), ['reg-01', 'reg-02']);
  assert.ok((await admin.get(coordinator, 'registrations', 'roster', 'reg-01')).values.email);
  await assert.rejects(admin.get(coordinator, 'registrations', 'roster', 'reg-03'), error('not_found'));
  await assert.rejects(admin.query(reviewer, 'registrations', 'roster'), error('forbidden'));
  assert.ok(!('email' in (await admin.get(observer, 'registrations', 'roster', 'reg-01')).values));
});

test('queries are declared, paginated after scope/assignment filters, and cannot escape their workspace', async () => {
  const { admin, ctx, coordinator } = await fixture();
  const first = await admin.query(coordinator, 'registrations', 'roster', { limit: 1 });
  assert.equal(first.records[0]?.id, 'reg-01'); assert.equal(first.nextCursor, 'reg-01');
  const second = await admin.query(coordinator, 'registrations', 'roster', { limit: 1, cursor: first.nextCursor });
  assert.equal(second.records[0]?.id, 'reg-02'); assert.equal(second.nextCursor, null);
  assert.equal((await admin.query(ctx, 'registrations', 'roster', { filters: { search: 'JORDAN', status: 'pending' } })).records[0]?.id, 'reg-03');
  for (const query of [{ filters: { sql: 'select * from users' } }, { filters: { search: 12 } }, { filters: { status: 'anything' } }, { limit: 101 }] as NonNullable<Parameters<GroveAdmin['query']>[3]>[]) await assert.rejects(admin.query(ctx, 'registrations', 'roster', query), error('invalid_request'));
  for (const scope of [{ ...ctx.scope, tenantId: 'elsewhere' }, { ...ctx.scope, siteId: 'other' }, { ...ctx.scope, environment: 'live' }]) {
    await assert.rejects(admin.query({ ...ctx, scope }, 'registrations', 'roster'), error('forbidden'));
    assert.deepEqual(await admin.catalog({ ...ctx, scope }), []);
  }
});

test('actions enforce server authorization, declared inputs, state, and expected versions', async () => {
  const { admin, observer, coordinator, reviewer, input } = await fixture();
  await assert.rejects(admin.run(observer, 'registrations', 'roster', 'confirm', input()), error('forbidden'));
  await assert.rejects(admin.run(coordinator, 'registrations', 'roster', 'confirm', { ...input(), recordId: 'reg-03' }), error('not_found'));
  await assert.rejects(admin.run(coordinator, 'registrations', 'roster', 'confirm', { ...input(), expectedVersion: 0 }), error('conflict'));
  await assert.rejects(admin.run(coordinator, 'registrations', 'roster', 'confirm', { ...input(), values: { role: 'owner' } }), error('invalid_request'));
  await assert.rejects(admin.run(coordinator, 'registrations', 'roster', 'confirm', { ...input(), recordId: 'reg-02' }), error('conflict'));
  await assert.rejects(admin.run(reviewer, 'curriculum', 'reviews', 'revise', { ...input(), recordId: 'lesson-01' }), error('invalid_request'));
  const result = await admin.run(reviewer, 'curriculum', 'reviews', 'revise', { ...input(), recordId: 'lesson-01', values: { feedback: 'Include a concrete practice example.' } });
  assert.equal(result.status, 'succeeded');
  const lesson = await admin.get(reviewer, 'curriculum', 'reviews', 'lesson-01');
  assert.equal(lesson.values.status, 'needs-revision'); assert.equal(lesson.values.feedback, 'Include a concrete practice example.'); assert.deepEqual(lesson.actions, []);
});

test('concurrent duplicate requests execute once; replay is durable and authorization is rechecked', async () => {
  const { admin, coordinator, ctx, modules, authorize, grants, input } = await fixture();
  const request = input();
  const results = await Promise.all([admin.run(coordinator, 'registrations', 'roster', 'confirm', request), admin.run(coordinator, 'registrations', 'roster', 'confirm', request)]);
  assert.ok(results.some(r => r.status === 'succeeded'));
  assert.equal((await admin.get(coordinator, 'registrations', 'roster', 'reg-01')).version, 2);
  const restarted = new GroveAdmin(db, authorize, modules);
  assert.equal((await restarted.run(coordinator, 'registrations', 'roster', 'confirm', request)).status, 'succeeded');
  assert.equal((await restarted.activity(coordinator, 'registrations', 'roster')).length, 1);
  assert.equal((await restarted.activity(ctx, 'registrations', 'roster')).length, 0);
  await assert.rejects(restarted.run(coordinator, 'registrations', 'roster', 'confirm', { ...request, expectedVersion: 2 }), error('conflict'));
  grants['demo-coordinator'] = ['admin:registrations:read'];
  await assert.rejects(restarted.run(coordinator, 'registrations', 'roster', 'confirm', request), error('forbidden'));
  assert.deepEqual(await restarted.activity(coordinator, 'registrations', 'roster'), []);
});

test('uncertain outcomes block new attempts and redact provider errors; a known rejection releases the record', async () => {
  const { ctx, modules, authorize, input } = await fixture();
  let calls = 0;
  modules[0]!.resources[0]!.actions[0]!.execute = async () => { calls++; throw new Error('secret-provider-token and private response'); };
  const admin = new GroveAdmin(db, authorize, modules); const request = input();
  const result = await admin.run(ctx, 'registrations', 'roster', 'confirm', request);
  assert.equal(result.status, 'uncertain'); assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal((await admin.run(ctx, 'registrations', 'roster', 'confirm', request)).status, 'uncertain'); assert.equal(calls, 1);
  await assert.rejects(admin.run(ctx, 'registrations', 'roster', 'confirm', input()), error('conflict'));
  const next = await fixture(); let reject = true;
  next.modules[0]!.resources[0]!.actions[0]!.execute = async () => { if (reject) throw new AdminActionRejected(); };
  const rejecting = new GroveAdmin(db, next.authorize, next.modules);
  assert.equal((await rejecting.run(next.ctx, 'registrations', 'roster', 'confirm', next.input())).status, 'rejected');
  reject = false;
  assert.equal((await rejecting.run(next.ctx, 'registrations', 'roster', 'confirm', next.input())).status, 'succeeded');
});

test('headless HTTP/client contract rejects forged actors and unauthorized direct action calls', async () => {
  const { admin, ctx, coordinator, input } = await fixture();
  const handler = createAdminHandler(admin, { authenticate: async request => request.headers.get('authorization') === 'coordinator' ? coordinator.actor : request.headers.get('authorization') === 'observer' ? { id: 'demo-observer' } : null });
  const client = (actor: string) => createClient({ baseUrl: 'http://admin.test', scope: ctx.scope, headers: () => ({ authorization: actor }), fetch: async (url, init) => handler(new Request(url, init)) });
  const staff = client('coordinator');
  assert.equal((await staff.adminModules()).length, 1);
  assert.equal((await staff.adminQuery('registrations', 'roster')).records.length, 2);
  assert.equal((await staff.adminGet('registrations', 'roster', 'reg-01')).version, 1);
  await assert.rejects(client('observer').adminRun('registrations', 'roster', 'confirm', input()), e => e instanceof GroveClientError && e.status === 403);
  await assert.rejects(staff.adminRun('registrations', 'roster', 'confirm', { ...input(), actor: { id: 'local-developer' } } as any), e => e instanceof GroveClientError && e.status === 400);
  assert.equal((await staff.adminRun('registrations', 'roster', 'confirm', input())).status, 'succeeded');
  assert.equal((await staff.adminActivity('registrations', 'roster')).length, 1);
  await assert.rejects(client('anonymous').adminModules(), e => e instanceof GroveClientError && e.status === 401);
});

test('an HTTP-owned resource participates without copying its records into the CMS', async () => {
  const { ctx, authorize } = await fixture(); let version = 1; let calls = 0; let operationId = '';
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer adapter-test-only') { response.writeHead(401); response.end(); return; }
    if (request.method === 'POST') {
      if (Number(request.headers['if-match']) !== version) { response.writeHead(409); response.end(); return; }
      operationId = String(request.headers['idempotency-key']); calls++; version++;
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'external-lesson', version, values: { title: 'Remote curriculum', status: version === 1 ? 'pending' : 'approved' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const url = `http://127.0.0.1:${address.port}`;
  try {
    async function read() { return (await fetch(url, { headers: { authorization: 'Bearer adapter-test-only' } })).json(); }
    const modules: AdminModule[] = [{ id: 'remote', label: 'Remote learning', description: 'HTTP adapter test', resources: [{ id: 'lessons', label: 'Lessons', description: 'Remote lessons', permission: 'admin:remote:read', columns: [{ name: 'title', label: 'Title', type: 'text' }], filters: [], source: { query: async () => ({ records: [await read()], nextCursor: null }), get: async (_ctx, id) => id === 'external-lesson' ? read() : null, authorizeRecord: async () => true }, actions: [{ id: 'approve', label: 'Approve', description: 'Approve remote lesson', confirmation: 'Approve this lesson?', inputs: [], permission: 'admin:remote:approve', available: (_ctx, record) => record.values.status === 'pending', execute: async (_ctx, request) => { const result = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer adapter-test-only', 'if-match': String(request.expectedVersion), 'idempotency-key': request.operationId } }); if (!result.ok) throw new AdminActionRejected(); } }] }] }];
    const admin = new GroveAdmin(db, authorize, modules);
    assert.equal((await admin.query(ctx, 'remote', 'lessons')).records[0]?.values.title, 'Remote curriculum');
    const request = { requestId: randomUUID(), recordId: 'external-lesson', expectedVersion: 1, values: {} };
    await admin.run(ctx, 'remote', 'lessons', 'approve', request); await admin.run(ctx, 'remote', 'lessons', 'approve', request);
    assert.equal(calls, 1); assert.match(operationId, /^[a-f0-9]{64}$/);
    assert.equal((await new Grove(db, () => true).listDocuments(ctx)).length, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
