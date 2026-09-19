import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresDatabase, migrate, Grove, GroveError, createHandler, SessionStore, rolePermissions, permits, MEMBER_ROLES, type Context } from '@eclosion-tech/grove/server';
import { createClient, GroveClientError } from '../packages/grove/src/client.js';
import type { Scope } from '@eclosion-tech/grove';

const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
const isError = (code: GroveError['code']) => (error: unknown) => error instanceof GroveError && error.code === code;
const isStatus = (status: number) => (error: unknown) => error instanceof GroveClientError && error.status === status;
before(async () => { await migrate(db); });
after(async () => { await db.close(); });

/** A deployed host: the operator is a server identity; everyone else is authorized by Grove-owned membership. */
function workspace() {
  const scope: Scope = { tenantId: randomUUID(), siteId: 'site', environment: 'production' };
  const inScope = (requested: typeof scope) => requested.tenantId === scope.tenantId && requested.siteId === scope.siteId && requested.environment === scope.environment;
  const grove: Grove = new Grove(db, async (actor, requested, permission) => inScope(requested) && (actor.id === 'operator' ? true : grove.members.authorize(actor, requested, permission)));
  const as = (id: string): Context => ({ actor: { id }, scope });
  return { scope, grove, as, operator: as('operator') };
}

test('roles map to CMS permissions, owners hold everything, extra grants are application permissions only', () => {
  assert.equal(permits({ role: 'viewer', permissions: [] }, 'content:edit'), false);
  assert.equal(permits({ role: 'editor', permissions: [] }, 'content:edit'), true);
  assert.equal(permits({ role: 'editor', permissions: [] }, 'content:publish'), false);
  assert.equal(permits({ role: 'publisher', permissions: [] }, 'content:publish'), true);
  assert.equal(permits({ role: 'publisher', permissions: [] }, 'schema:write'), false);
  assert.equal(permits({ role: 'developer', permissions: [] }, 'schema:write'), true);
  assert.equal(permits({ role: 'developer', permissions: [] }, 'members:read'), true);
  assert.equal(permits({ role: 'developer', permissions: [] }, 'members:write'), false);
  assert.equal(permits({ role: 'owner', permissions: [] }, 'members:write'), true);
  assert.equal(permits({ role: 'owner', permissions: [] }, 'admin:anything:goes'), true);
  assert.equal(permits({ role: 'editor', permissions: ['admin:registrations:read'] }, 'admin:registrations:read'), true);
  assert.equal(permits({ role: 'editor', permissions: ['admin:registrations:read'] }, 'admin:registrations:confirm'), false);
  assert.equal(permits({ role: 'editor', permissions: ['content:publish'] }, 'content:publish'), false);
  for (const role of MEMBER_ROLES) assert.ok(rolePermissions[role].includes('content:read') && rolePermissions[role].includes('delivery:read'));
});

test('an invitation binds to its verified subject on first sign-in and then authorizes by subject', async () => {
  const { scope, grove, as, operator } = workspace();
  const invited = await grove.members.invite(operator, { email: ' Editor@Example.org ', role: 'editor', permissions: ['admin:registrations:read', 'admin:registrations:read'] });
  assert.equal(invited.email, 'editor@example.org'); assert.equal(invited.subject, null); assert.equal(invited.acceptedAt, null);
  assert.deepEqual(invited.permissions, ['admin:registrations:read']); assert.equal(invited.createdBy, 'operator');
  assert.equal(await grove.members.resolve(scope, { subject: 'sub-1', email: 'editor@example.org', emailVerified: false }), null);
  assert.equal(await grove.members.authorize({ id: 'sub-1' }, scope, 'content:read'), false);
  const bound = await grove.members.resolve(scope, { subject: 'sub-1', email: 'EDITOR@example.org', emailVerified: true });
  assert.equal(bound?.id, invited.id); assert.equal(bound?.subject, 'sub-1'); assert.ok(bound?.acceptedAt);
  assert.equal((await grove.members.resolve(scope, { subject: 'sub-1', email: 'renamed@example.org', emailVerified: true }))?.id, invited.id);
  assert.equal(await grove.members.resolve(scope, { subject: 'sub-2', email: 'editor@example.org', emailVerified: true }), null);
  assert.equal(await grove.members.resolve({ ...scope, siteId: 'other' }, { subject: 'sub-1', email: 'editor@example.org', emailVerified: true }), null);
  assert.equal(await grove.members.authorize({ id: 'sub-1' }, scope, 'content:edit'), true);
  assert.equal(await grove.members.authorize({ id: 'sub-1' }, scope, 'content:publish'), false);
  assert.equal(await grove.members.authorize({ id: 'sub-1' }, scope, 'admin:registrations:read'), true);
  assert.equal(await grove.members.authorize({ id: 'sub-1' }, { ...scope, environment: 'development' }, 'content:read'), false);
  assert.equal(await grove.members.authorize({ id: 'sub-2' }, scope, 'content:read'), false);
  assert.equal((await grove.members.membership(scope, 'sub-1'))?.role, 'editor');
  assert.equal(await grove.members.membership(scope, 'sub-2'), null);
  await grove.pushSchema(operator, { locales: ['en'], defaultLocale: 'en', types: [{ name: 'note', fields: [{ name: 'title', type: 'string' }] }] }, 0);
  const saved = await grove.saveDocument(as('sub-1'), 'n1', { type: 'note', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: 'Hi' } });
  assert.equal(saved.updatedBy, 'sub-1');
  await assert.rejects(grove.publish(as('sub-1'), 'n1', 1), isError('forbidden'));
  await assert.rejects(grove.getDocument(as('sub-2'), 'n1'), isError('forbidden'));
});

test('only owners manage members; the last signed-in owner cannot be removed or demoted', async () => {
  const { scope, grove, as, operator } = workspace();
  const mistaken = await grove.members.invite(operator, { email: 'owner@example.org', role: 'owner' });
  await grove.members.remove(operator, mistaken.id); // a pending owner invitation can always be corrected
  const first = await grove.members.invite(operator, { email: 'owner@example.org', role: 'owner' });
  await grove.members.resolve(scope, { subject: 'owner-1', email: 'owner@example.org', emailVerified: true });
  const owner = as('owner-1');
  await grove.members.invite(owner, { email: 'second@example.org', role: 'owner' });
  await assert.rejects(grove.members.update(owner, first.id, { role: 'editor' }), isError('conflict')); // a pending owner keeps nobody in
  await assert.rejects(grove.members.remove(owner, first.id), isError('conflict'));
  await grove.members.resolve(scope, { subject: 'owner-2', email: 'second@example.org', emailVerified: true });
  assert.equal((await grove.members.update(owner, first.id, { role: 'developer' })).role, 'developer');
  assert.equal((await grove.members.list(owner)).length, 2);
  await assert.rejects(grove.members.invite(owner, { email: 'x@example.org', role: 'viewer' }), isError('forbidden'));
  const editor = await grove.members.invite(as('owner-2'), { email: 'ed@example.org', role: 'editor' });
  await grove.members.resolve(scope, { subject: 'ed-1', email: 'ed@example.org', emailVerified: true });
  await assert.rejects(grove.members.list(as('ed-1')), isError('forbidden'));
  await assert.rejects(grove.members.remove(as('ed-1'), editor.id), isError('forbidden'));
  await assert.rejects(grove.members.list(as('nobody')), isError('forbidden'));
  await assert.rejects(grove.members.remove(as('owner-2'), (await grove.members.list(as('owner-2'))).find(m => m.subject === 'owner-2')!.id), isError('conflict'));
});

test('invalid invitations are rejected before storage and emails are unique per workspace', async () => {
  const { grove, operator } = workspace();
  await assert.rejects(grove.members.invite(operator, { email: 'not-an-email', role: 'editor' }), isError('invalid_request'));
  await assert.rejects(grove.members.invite(operator, { email: 'a@b.co', role: 'admin' as never }), isError('invalid_request'));
  await assert.rejects(grove.members.invite(operator, { email: 'a@b.co', role: 'editor', permissions: ['content:publish'] }), isError('invalid_request'));
  await assert.rejects(grove.members.invite(operator, { email: 'a@b.co', role: 'editor', permissions: ['admin:module'] }), isError('invalid_request'));
  await assert.rejects(grove.members.invite(operator, null as never), isError('invalid_request'));
  await grove.members.invite(operator, { email: 'a@b.co', role: 'editor' });
  await assert.rejects(grove.members.invite(operator, { email: 'A@B.CO', role: 'viewer' }), isError('conflict'));
  await assert.rejects(grove.members.update(operator, randomUUID(), { role: 'viewer' }), isError('not_found'));
  await assert.rejects(grove.members.update(operator, 'x', {}), isError('invalid_request'));
  await assert.rejects(grove.members.remove(operator, '../x'), isError('invalid_request'));
});

test('HTTP routes and the typed client expose membership under the same authorization', async () => {
  const { scope, grove } = workspace();
  const tokens: Record<string, string> = { 'operator-token': 'operator', 'editor-token': 'ed-1' };
  const handler = createHandler(grove, { authenticate: async request => { const id = tokens[request.headers.get('authorization')?.replace('Bearer ', '') ?? '']; return id ? { id } : null; } });
  const client = (token: string) => createClient({ baseUrl: 'http://grove.test', scope, headers: () => ({ Authorization: `Bearer ${token}` }), fetch: (input, init) => handler(new Request(input, init)) });
  const operator = client('operator-token');
  const invited = await operator.inviteMember({ email: 'ed@example.org', role: 'editor' });
  await grove.members.resolve(scope, { subject: 'ed-1', email: 'ed@example.org', emailVerified: true });
  assert.equal((await operator.listMembers()).length, 1);
  const updated = await operator.updateMember(invited.id, { permissions: ['admin:registrations:read'] });
  assert.deepEqual(updated.permissions, ['admin:registrations:read']); assert.equal(updated.role, 'editor');
  await assert.rejects(client('editor-token').listMembers(), isStatus(403));
  await assert.rejects(client('editor-token').inviteMember({ email: 'x@example.org', role: 'owner' }), isStatus(403));
  await assert.rejects(operator.inviteMember({ email: 'bad', role: 'editor' }), isStatus(400));
  await assert.rejects(client('nope').listMembers(), isStatus(401));
  assert.deepEqual(await operator.removeMember(invited.id), { ok: true });
  await assert.rejects(operator.removeMember(invited.id), isStatus(404));
});

test('sessions store only hashes, expire on the host clock, and login attempts are consumed once', async t => {
  const sessions = new SessionStore(db);
  const subject = randomUUID();
  const id = await sessions.create('session', 1000, { subject, email: 'e@x.co', csrf: 'c', data: { name: 'E' } });
  assert.match(id, /^[a-f0-9]{64}$/);
  const [row] = await db.query('SELECT id_hash FROM grove_sessions WHERE subject = $1', [subject]);
  assert.ok(row && row.id_hash !== id && row.id_hash.length === 64);
  assert.equal((await sessions.read('session', id))?.email, 'e@x.co');
  assert.deepEqual((await sessions.read('session', id))?.data, { name: 'E' });
  assert.equal(await sessions.read('login', id), null);
  assert.equal(await sessions.read('session', 'not-an-id'), null);
  assert.equal(await sessions.read('session', undefined), null);
  const login = await sessions.create('login', 1000, { data: { state: 'st' } });
  assert.equal((await sessions.consume('login', login))?.data.state, 'st');
  assert.equal(await sessions.consume('login', login), null);
  await assert.rejects(sessions.create('session', 0), isError('invalid_request'));
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 2_000);
  assert.equal(await sessions.read('session', id), null);
  await sessions.purge();
  assert.equal((await db.query('SELECT 1 FROM grove_sessions WHERE subject = $1', [subject])).length, 0);
});
