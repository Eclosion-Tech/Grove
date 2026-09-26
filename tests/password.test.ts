import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Scope } from '@eclosion-tech/grove';
import { createPostgresDatabase, migrate, Grove, GroveError, SessionStore, Accounts, createHandler, hashPassword, verifyPassword } from '@eclosion-tech/grove/server';
import { passwordAccess } from '../apps/grove/src/password.js';
import { OPERATOR_ACTOR } from '../apps/grove/src/identity.js';
import { compose } from '../apps/grove/src/serve.js';

const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
const origin = 'http://127.0.0.1:4310';
const token = 'an-operator-token-with-at-least-thirty-two-characters';
const isError = (code: GroveError['code']) => (error: unknown) => error instanceof GroveError && error.code === code;
before(async () => { await migrate(db); });
after(async () => { await db.close(); });

function host(overrides: { maxFailures?: number; lockoutMs?: number } = {}) {
  const scope: Scope = { tenantId: randomUUID(), siteId: 'site', environment: 'production' };
  const inScope = (requested: typeof scope) => requested.tenantId === scope.tenantId && requested.siteId === scope.siteId && requested.environment === scope.environment;
  const authorize = async (actor: { id: string }, requested: Scope, permission: Parameters<Grove['members']['authorize']>[2]) => inScope(requested) && (actor.id === OPERATOR_ACTOR ? true : grove.members.authorize(actor, requested, permission));
  const grove: Grove = new Grove(db, authorize);
  const accounts = new Accounts(db);
  const access = passwordAccess({ accounts, authorize, sessions: new SessionStore(db), members: grove.members, scope, publicUrl: origin, operatorToken: token, maxFailures: overrides.maxFailures ?? 3, lockoutMs: overrides.lockoutMs ?? 60_000 });
  const route = compose({ access, email: async () => null, clientSite: async () => null, handler: createHandler(grove, { authenticate: access.authenticate }), static: async () => new Response('static') });
  return { scope, grove, accounts, access, route, operator: { actor: { id: OPERATOR_ACTOR }, scope }, api: `${origin}/v1/tenants/${scope.tenantId}/sites/site/environments/production` };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bearer = { authorization: `Bearer ${token}` };
const mint = async (h: ReturnType<typeof host>, email: string) => { const response = await h.route(post('/auth/invitations', { email }, bearer)); assert.equal(response.status, 201); const link = await response.json(); return { ...link, token: String(link.url).split('#token=')[1]! }; };

test('accounts hash passwords with scrypt, verify uniformly, and consume invitation links once', async t => {
  const accounts = new Accounts(db);
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  const email = `${randomUUID()}@example.org`;
  const invite = await accounts.invite(` ${email.toUpperCase()} `);
  assert.equal(invite.email, email); assert.match(invite.token, /^[a-f0-9]{64}$/);
  assert.equal(await accounts.verify(email, 'a-long-enough-password'), null, 'no password until the invitation is accepted');
  await assert.rejects(accounts.accept(invite.token, 'short'), isError('invalid_request'));
  await assert.rejects(accounts.accept('not-a-token', 'a-long-enough-password'), isError('invalid_request'));
  const account = await accounts.accept(invite.token, 'a-long-enough-password');
  assert.equal(account.email, email); assert.equal(account.hasPassword, true);
  await assert.rejects(accounts.accept(invite.token, 'a-long-enough-password'), isError('not_found'));
  assert.equal((await accounts.verify(email, 'a-long-enough-password'))?.id, account.id);
  assert.equal(await accounts.verify(email, 'a-long-enough-passwor'), null);
  assert.equal(await accounts.verify('nobody@example.org', 'a-long-enough-password'), null);
  assert.equal(await accounts.verify('not an email', 'a-long-enough-password'), null);
  await assert.rejects(accounts.changePassword(account.id, 'wrong-current-password', 'another-long-password'), isError('forbidden'));
  await assert.rejects(accounts.changePassword(account.id, 'a-long-enough-password', 'short'), isError('invalid_request'));
  await accounts.changePassword(account.id, 'a-long-enough-password', 'another-long-password');
  assert.equal(await accounts.verify(email, 'a-long-enough-password'), null);
  assert.equal((await accounts.verify(email, 'another-long-password'))?.id, account.id);
  const again = await accounts.invite(email); // a fresh link on an existing account is the password reset path
  assert.equal(again.id, account.id);
  assert.equal((await accounts.accept(again.token, 'a-third-long-password')).id, account.id);
  assert.equal((await accounts.verify(email, 'a-third-long-password'))?.id, account.id);
  const expiring = await accounts.invite(`${randomUUID()}@example.org`, 1000);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 2_000);
  await assert.rejects(accounts.accept(expiring.token, 'a-long-enough-password'), isError('not_found'));
});

test('an owner mints a one-time link for an invited email; accepting sets the password, binds membership and opens a session', async () => {
  const h = host();
  await h.grove.members.invite(h.operator, { email: 'editor@example.org', role: 'editor' });
  await h.grove.pushSchema(h.operator, { locales: ['en'], defaultLocale: 'en', types: [{ name: 'note', fields: [{ name: 'title', type: 'string' }] }] }, 0);
  assert.equal((await h.route(post('/auth/invitations', { email: 'editor@example.org' }))).status, 401);
  assert.equal((await h.route(post('/auth/invitations', { email: 'stranger@example.org' }, bearer))).status, 404);
  const link = await mint(h, 'Editor@example.org');
  assert.match(link.url, new RegExp(`^${origin}/accept#token=[a-f0-9]{64}$`)); assert.equal(link.email, 'editor@example.org');
  assert.equal((await h.route(new Request(`${origin}/auth/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.token, password: 'a-long-enough-password' }) }))).status, 403, 'cross-origin accept refused');
  assert.equal((await h.route(post('/auth/accept', { token: link.token, password: 'short' }))).status, 400);
  const accepted = await h.route(post('/auth/accept', { token: link.token, password: 'a-long-enough-password' }));
  assert.equal(accepted.status, 200);
  const view = await accepted.json();
  assert.equal(view.role, 'editor'); assert.equal(view.email, 'editor@example.org'); assert.equal(view.mode, 'password'); assert.equal(view.login, undefined); assert.match(view.csrf, /^[a-f0-9]{64}$/);
  const setCookie = accepted.headers.get('set-cookie')!; assert.match(setCookie, /^grove_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/);
  const cookie = setCookie.split(';')[0]!;
  assert.equal((await h.grove.members.list(h.operator))[0]!.subject, view.actor);
  assert.equal((await h.route(post('/auth/accept', { token: link.token, password: 'a-long-enough-password' }))).status, 404, 'link is single use');
  assert.deepEqual(await h.access.authenticate(new Request(origin, { headers: { cookie } })), { id: view.actor });
  const headers = { cookie, origin, 'x-grove-csrf': view.csrf, 'content-type': 'application/json' };
  assert.equal((await h.route(new Request(`${h.api}/documents/n1`, { method: 'PUT', headers, body: JSON.stringify({ type: 'note', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: 'Hi' } }) }))).status, 200);
  assert.equal((await h.route(new Request(`${h.api}/documents/n1/publish`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) }))).status, 403);
  assert.equal((await h.route(new Request(`${h.api}/documents/n1`, { method: 'PUT', headers: { ...headers, 'x-grove-csrf': 'nope' }, body: '{}' }))).status, 403);
  const session = await h.route(new Request(`${origin}/auth/session`, { headers: { cookie } }));
  assert.equal(session.status, 200); assert.equal((await session.json()).mode, 'password');
  assert.equal((await h.route(post('/auth/password', { current: 'a-long-enough-password', next: 'another-long-password' }, { cookie }))).status, 403, 'password change needs the CSRF token');
  assert.equal((await h.route(post('/auth/password', { current: 'wrong-current-password', next: 'another-long-password' }, { cookie, 'x-grove-csrf': view.csrf }))).status, 403);
  assert.equal((await h.route(post('/auth/password', { current: 'a-long-enough-password', next: 'another-long-password' }, { cookie, 'x-grove-csrf': view.csrf }))).status, 200);
  assert.equal((await h.route(post('/auth/login', { email: 'editor@example.org', password: 'another-long-password' }))).status, 200);
  assert.equal((await h.route(post('/auth/logout', {}, { cookie, 'x-grove-csrf': view.csrf }))).status, 200);
  assert.equal(await h.access.authenticate(new Request(origin, { headers: { cookie } })), null);
});

test('sign-in requires same origin, answers wrong email and wrong password alike, locks after repeated failures, and refuses non-members', async () => {
  const h = host({ maxFailures: 3 });
  await h.grove.members.invite(h.operator, { email: 'writer@example.org', role: 'publisher' });
  const link = await mint(h, 'writer@example.org');
  assert.equal((await h.route(post('/auth/accept', { token: link.token, password: 'a-long-enough-password' }))).status, 200);
  assert.equal((await h.route(new Request(`${origin}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'writer@example.org', password: 'a-long-enough-password' }) }))).status, 403);
  const wrong = await h.route(post('/auth/login', { email: 'writer@example.org', password: 'not-the-password' }));
  const unknown = await h.route(post('/auth/login', { email: 'nobody@example.org', password: 'not-the-password' }));
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401); assert.deepEqual(await wrong.json(), await unknown.json());
  assert.equal((await h.route(post('/auth/login', {}))).status, 401);
  const good = await h.route(post('/auth/login', { email: ' WRITER@example.org ', password: 'a-long-enough-password' }));
  assert.equal(good.status, 200); assert.equal((await good.json()).role, 'publisher');
  for (let i = 0; i < 3; i++) assert.equal((await h.route(post('/auth/login', { email: 'writer@example.org', password: 'nope-nope-nope' }))).status, 401);
  assert.equal((await h.route(post('/auth/login', { email: 'writer@example.org', password: 'a-long-enough-password' }))).status, 429, 'locked out after repeated failures');
  const elsewhere = host(); // another workspace shares the accounts table but has no membership for this account
  assert.equal((await elsewhere.route(post('/auth/login', { email: 'writer@example.org', password: 'a-long-enough-password' }))).status, 403);
  assert.deepEqual(await h.access.authenticate(new Request(origin, { headers: bearer })), { id: OPERATOR_ACTOR });
  assert.deepEqual(await (await h.route(new Request(`${origin}/auth/session`))).json(), { mode: 'password' });
  const staff = host();
  const owner = await staff.grove.members.invite(staff.operator, { email: 'owner@example.org', role: 'owner' });
  const ownerLink = await mint(staff, 'owner@example.org');
  const opened = await staff.route(post('/auth/accept', { token: ownerLink.token, password: 'a-long-enough-password' }));
  const ownerView = await opened.json(); const ownerCookie = opened.headers.get('set-cookie')!.split(';')[0]!;
  await staff.grove.members.invite(staff.operator, { email: 'new@example.org', role: 'viewer' });
  assert.equal((await staff.route(post('/auth/invitations', { email: 'new@example.org' }, { cookie: ownerCookie }))).status, 403, 'browser owners need the CSRF token');
  assert.equal((await staff.route(post('/auth/invitations', { email: 'new@example.org' }, { cookie: ownerCookie, 'x-grove-csrf': ownerView.csrf }))).status, 201);
  await staff.grove.members.invite(staff.operator, { email: 'second@example.org', role: 'owner' });
  await staff.grove.members.resolve(staff.scope, { subject: 'second-owner', email: 'second@example.org', emailVerified: true });
  await staff.grove.members.remove(staff.operator, owner.id);
  const gone = await staff.route(new Request(`${origin}/auth/session`, { headers: { cookie: ownerCookie } }));
  assert.equal(gone.status, 401); assert.match(gone.headers.get('set-cookie')!, /grove_session=; .*Max-Age=0/);
});
