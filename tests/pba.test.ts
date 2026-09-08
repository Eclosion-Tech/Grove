import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroveAdmin, GroveError, createAdminHandler, type Database } from '@eclosion-tech/grove/server';
import { pbaRegistrationsModule, parsePbaConnection, loadPbaModule, type PbaConnection } from '../apps/grove/src/pba.js';

const config: PbaConnection = {
  origin: 'https://pba.example', projectId: 'project123',
  scope: { tenantId: 'local', siteId: 'fieldnotes', environment: 'development' },
  actorId: 'local-developer', staffUserId: 'human-123',
  classes: [{ id: 'social-group', label: 'Social group', sanityClassId: 'drafts.class-123' }, { id: 'empty-group', label: 'Empty group', sanityClassId: 'class-empty' }],
};
const ctx = { actor: { id: config.actorId }, scope: config.scope };
const registration = (n: number, status = 'pending') => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, email: `person${n}@example.test`,
  firstName: 'Sample', lastName: `Person ${n}`, phone: null, status, createdAt: '2026-09-06T12:00:00.000Z',
  paidAt: null, amountPaidCents: null, fundingApprovedAt: null,
  registrationDetails: { answers: { medicalNotes: 'DO NOT PROJECT', paymentMethod: 'Mailed check' } },
});
const db = { query() { throw new Error('Read-only PBA must not use Grove storage'); } } as unknown as Database;
const forbidden = (e: unknown) => e instanceof GroveError && e.code === 'forbidden';

function fixture() {
  const requests: { url: string; init: RequestInit }[] = [];
  const state = {
    user: { id: 'project-member-123', sanityUserId: config.staffUserId, isRobot: false },
    project: { id: config.projectId, members: [{ id: 'project-member-123', isRobot: false, roles: [{ name: 'editor' }] }] },
    rows: [registration(2, 'registered'), registration(1), registration(3)],
    status: 200, raw: null as string | null, failure: false,
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (state.failure) throw new Error('SENSITIVE TOKEN AND REMOTE MESSAGE');
    if (url.endsWith('/users/me')) return Response.json(state.user);
    if (url.includes('/projects/')) return Response.json(state.project);
    return state.raw !== null ? new Response(state.raw, { headers: { 'Content-Type': 'application/json' } }) : Response.json(state.status === 200 ? { capacity: 10, registered: 1, waitlisted: 0, pending: 2, registrations: url.includes('class-empty') ? [] : state.rows } : { error: 'PRIVATE ERROR' }, { status: state.status });
  };
  const module = pbaRegistrationsModule(config, () => 'private-human-credential', fetcher);
  return { state, requests, module, admin: new GroveAdmin(db, () => true, [module]), fetcher };
}

test('PBA uses its real roster shape, configured class references, projected fields and read-only records', async () => {
  const { admin, requests } = fixture();
  const catalog = await admin.catalog(ctx);
  assert.deepEqual(catalog[0]?.resources.map(r => [r.id, r.label, r.actions]), [['social-group', 'Social group', []], ['empty-group', 'Empty group', []]]);
  assert.ok(!JSON.stringify(catalog).includes('credential'));
  const first = await admin.query(ctx, 'pba-registrations', 'social-group', { limit: 1 });
  assert.equal(first.records[0]?.id, registration(1).id);
  assert.equal(first.records[0]?.version, 0); assert.deepEqual(first.records[0]?.actions, []);
  assert.equal(first.records[0]?.values.name, 'Sample Person 1');
  assert.ok(!JSON.stringify(first).includes('medicalNotes')); assert.ok(!JSON.stringify(first).includes('DO NOT PROJECT'));
  const next = await admin.query(ctx, 'pba-registrations', 'social-group', { cursor: first.nextCursor, limit: 1 });
  assert.equal(next.records[0]?.id, registration(2).id);
  assert.deepEqual((await admin.query(ctx, 'pba-registrations', 'social-group', { filters: { status: 'pending' } })).records.map(r => r.id), [registration(1).id, registration(3).id]);
  assert.equal((await admin.get(ctx, 'pba-registrations', 'social-group', registration(2).id)).values.status, 'registered');
  assert.deepEqual((await admin.query(ctx, 'pba-registrations', 'empty-group')).records, []);
  assert.ok(requests.every(r => r.init.method === 'GET' && r.init.redirect === 'error' && r.init.cache === 'no-store' && r.init.signal));
  assert.equal(new URL(requests[2]!.url).searchParams.get('sanityClassId'), 'class-123');
  assert.equal(requests[0]!.url, 'https://project123.api.sanity.io/v2021-06-07/users/me');
});

test('PBA checks identity, human status, project and staff role before requesting private records, on every read', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.user.id = 'other-human'; },
    (f: ReturnType<typeof fixture>) => { f.state.user.sanityUserId = 'other-account'; },
    (f: ReturnType<typeof fixture>) => { f.state.user.isRobot = true; },
    (f: ReturnType<typeof fixture>) => { f.state.project.members[0]!.isRobot = true; },
    (f: ReturnType<typeof fixture>) => { f.state.project.id = 'anotherproject'; },
    (f: ReturnType<typeof fixture>) => { f.state.project.members = []; },
    (f: ReturnType<typeof fixture>) => { f.state.project.members[0]!.roles = [{ name: 'viewer' }]; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.admin.query(ctx, 'pba-registrations', 'social-group'), forbidden);
    assert.ok(f.requests.every(r => ['api.sanity.io', 'project123.api.sanity.io'].includes(new URL(r.url).hostname)));
  }
  const f = fixture();
  await f.admin.query(ctx, 'pba-registrations', 'social-group');
  f.state.project.members = [];
  await assert.rejects(f.admin.get(ctx, 'pba-registrations', 'social-group', registration(1).id), forbidden);
  assert.equal(f.requests.filter(r => new URL(r.url).hostname === 'pba.example').length, 1);
});

test('PBA rejects another scope, actor, arbitrary class, filter or action without upstream access', async () => {
  const { admin, requests } = fixture();
  for (const context of [
    { ...ctx, actor: { id: 'demo-coordinator' } },
    ...(['tenantId', 'siteId', 'environment'] as const).map(k => ({ ...ctx, scope: { ...ctx.scope, [k]: 'other' } })),
  ]) await assert.rejects(admin.query(context, 'pba-registrations', 'social-group'), forbidden);
  await assert.rejects(admin.query(ctx, 'pba-registrations', 'unconfigured'), { code: 'not_found' });
  await assert.rejects(admin.query(ctx, 'pba-registrations', 'social-group', { filters: { sanityClassId: 'other' } }), { code: 'invalid_request' });
  await assert.rejects(admin.run(ctx, 'pba-registrations', 'social-group', 'confirm', { requestId: 'test', recordId: registration(1).id, expectedVersion: 0, values: {} }), { code: 'not_found' });
  assert.equal(requests.length, 0);
});

test('PBA field permission removes personal details and stale pagination requires reload', async () => {
  const f = fixture(); const admin = new GroveAdmin(db, (_actor, _scope, permission) => !permission.endsWith(':personal'), [f.module]);
  const page = await admin.query(ctx, 'pba-registrations', 'social-group', { limit: 1 });
  assert.deepEqual(Object.keys(page.records[0]!.values), ['status', 'createdAt']);
  f.state.rows = f.state.rows.filter(r => r.id !== page.nextCursor);
  await assert.rejects(admin.query(ctx, 'pba-registrations', 'social-group', { cursor: page.nextCursor }), { code: 'conflict' });
});

test('PBA fails closed for malformed/oversized responses and redacts upstream failures', async () => {
  for (const raw of ['{}', 'not json', JSON.stringify({ registrations: [{ ...registration(1), status: 'unknown' }] }), JSON.stringify({ registrations: [registration(1), registration(1)] }), JSON.stringify({ registrations: [{ ...registration(1), createdAt: 'invalid' }] }), ' '.repeat(4_000_001)]) {
    const f = fixture(); f.state.raw = raw;
    await assert.rejects(f.admin.query(ctx, 'pba-registrations', 'social-group'));
  }
  for (const status of [401, 403, 500]) {
    const f = fixture(); f.state.status = status;
    await assert.rejects(f.admin.query(ctx, 'pba-registrations', 'social-group'), e => e instanceof Error && !e.message.includes('PRIVATE') && (status === 500 || forbidden(e)));
  }
  const f = fixture(); f.state.failure = true;
  const response = await createAdminHandler(f.admin, { authenticate: async () => ctx.actor })(new Request('https://grove.test/v1/tenants/local/sites/fieldnotes/environments/development/admin/pba-registrations/social-group/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes('SENSITIVE'));
});

test('PBA connection validates trusted origin, class allowlist and explicit scope; demo mode cannot load it', async () => {
  for (const origin of ['http://pba.example', 'https://pba.example/private', 'https://secret@pba.example', 'https://pba.example?secret=yes', 'https://pba.example/#fragment']) assert.throws(() => parsePbaConnection({ ...config, origin }));
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://pba.example']) assert.equal(parsePbaConnection({ ...config, origin }).origin, origin);
  assert.throws(() => parsePbaConnection({ ...config, actorId: 'demo-observer' }));
  assert.throws(() => parsePbaConnection({ ...config, classes: [...config.classes, config.classes[0]] }));
  assert.throws(() => parsePbaConnection({ ...config, token: 'never store here' }));
  await assert.rejects(loadPbaModule(config.scope, { GROVE_PBA_CONFIG: '/file-not-needed', GROVE_LOCAL_LOGIN: '1' }), /token login/);
  assert.deepEqual(await loadPbaModule(config.scope, {}), []);
});
