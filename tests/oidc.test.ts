import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { Scope } from '@eclosion-tech/grove';
import { createPostgresDatabase, migrate, Grove, SessionStore, createHandler } from '@eclosion-tech/grove/server';
import { OidcClient } from '../apps/grove/src/oidc-client.js';
import { oidcAccess } from '../apps/grove/src/oidc.js';
import { OPERATOR_ACTOR } from '../apps/grove/src/identity.js';
import { compose } from '../apps/grove/src/serve.js';

type User = { sub: string; email: string; email_verified: boolean; name?: string; org?: { id: string; owner_type: string } };
const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
const clientId = 'grove-test'; const clientSecret = 'grove-test-secret';
const origin = 'http://127.0.0.1:4310';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A stand-in OpenID Connect provider: discovery, PKCE-checked code exchange, opaque access tokens, an id_token, userinfo that can be switched off. */
const provider = {
  server: null as Server | null, issuer: '', issuerClaim: '', user: null as User | null, userinfo: 'up' as 'up' | 'down', audience: clientId, expiresIn: 3600,
  codes: new Map<string, { challenge: string; user: User; redirect: string }>(), tokens: new Map<string, User>(), revoked: [] as string[], lastAuthorize: {} as Record<string, string>,
};
const idToken = (user: User) => `${b64({ alg: 'RS256', kid: 'k' })}.${b64({ iss: provider.issuer, aud: provider.audience, exp: Math.floor(Date.now() / 1000) + provider.expiresIn, ...user })}.signature`;
before(async () => {
  await migrate(db);
  provider.server = createServer(async (req, res) => {
    const url = new URL(req.url!, provider.issuer);
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const form = async () => { let body = ''; for await (const chunk of req) body += chunk; return new URLSearchParams(body); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: provider.issuerClaim || provider.issuer, authorization_endpoint: `${provider.issuer}/authorize`, token_endpoint: `${provider.issuer}/token`, userinfo_endpoint: `${provider.issuer}/userinfo`, revocation_endpoint: `${provider.issuer}/revoke` });
    if (url.pathname === '/authorize') {
      provider.lastAuthorize = Object.fromEntries(url.searchParams);
      const code = randomUUID();
      provider.codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', user: provider.user!, redirect: url.searchParams.get('redirect_uri') ?? '' });
      const back = new URL(url.searchParams.get('redirect_uri')!); back.searchParams.set('code', code); back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const input = await form();
      const grant = provider.codes.get(input.get('code') ?? ''); provider.codes.delete(input.get('code') ?? '');
      const challenge = createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url');
      if (!grant || input.get('grant_type') !== 'authorization_code' || input.get('client_secret') !== clientSecret || input.get('client_id') !== clientId || input.get('redirect_uri') !== grant.redirect || challenge !== grant.challenge) return json(400, { error: 'invalid_grant' });
      const access = randomUUID(); provider.tokens.set(access, grant.user);
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, id_token: idToken(grant.user) });
    }
    if (url.pathname === '/userinfo') {
      if (provider.userinfo === 'down') return json(404, { error: 'not_found' });
      const user = provider.tokens.get((req.headers.authorization ?? '').replace('Bearer ', ''));
      return user ? json(200, user) : json(401, { error: 'invalid_token' });
    }
    if (url.pathname === '/revoke' && req.method === 'POST') { provider.revoked.push((await form()).get('token') ?? ''); return json(200, {}); }
    json(404, { error: 'unknown' });
  });
  provider.server.listen(0, '127.0.0.1'); await once(provider.server, 'listening');
  provider.issuer = `http://127.0.0.1:${(provider.server.address() as { port: number }).port}`;
});
after(async () => { provider.server?.close(); await db.close(); });

function host(overrides: { secret?: string; operatorToken?: string; sessionTtlMs?: number; tenantClaim?: string | null } = {}) {
  const scope: Scope = { tenantId: randomUUID(), siteId: 'site', environment: 'production' };
  const inScope = (requested: typeof scope) => requested.tenantId === scope.tenantId && requested.siteId === scope.siteId && requested.environment === scope.environment;
  const grove: Grove = new Grove(db, async (actor, requested, permission) => inScope(requested) && (actor.id === OPERATOR_ACTOR ? true : grove.members.authorize(actor, requested, permission)));
  const client = new OidcClient({ issuer: provider.issuer, clientId, clientSecret: overrides.secret ?? clientSecret, redirectUri: `${origin}/auth/callback`, scopes: ['openid', 'email', 'profile', 'org'] });
  const make = () => oidcAccess({ client, tenantClaim: overrides.tenantClaim === null ? undefined : overrides.tenantClaim ?? 'org.id', sessions: new SessionStore(db), members: grove.members, scope, publicUrl: origin, operatorToken: overrides.operatorToken, sessionTtlMs: overrides.sessionTtlMs, onError: () => {} });
  const access = make();
  const route = compose({ access, email: async () => null, clientSite: async () => null, handler: createHandler(grove, { authenticate: access.authenticate }), static: async () => new Response('static') });
  const member = (email: string, sub: string = randomUUID()): User => ({ sub, email, email_verified: true, name: 'Member', org: { id: scope.tenantId, owner_type: 'org' } });
  return { scope, grove, access, route, make, member, operator: { actor: { id: OPERATOR_ACTOR }, scope }, api: `${origin}/v1/tenants/${scope.tenantId}/sites/site/environments/production` };
}
async function signIn(h: ReturnType<typeof host>, user: User) {
  provider.user = user;
  const login = await h.route(new Request(`${origin}/auth/login`));
  assert.equal(login.status, 302);
  const loginCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const hop = await fetch(login.headers.get('location')!, { redirect: 'manual' });
  const back = hop.headers.get('location')!;
  const callback = await h.route(new Request(back, { headers: { cookie: loginCookie } }));
  const set = callback.headers.getSetCookie();
  return { login, loginCookie, back, callback, set, sessionCookie: set.find(c => c.startsWith('grove_session=') && !c.includes('Max-Age=0'))?.split(';')[0] };
}

test('sign-in redirects to the provider with PKCE, binds the invitation, and creates a persistent server session', async () => {
  const h = host();
  await h.grove.members.invite(h.operator, { email: 'editor@example.org', role: 'editor' });
  await h.grove.pushSchema(h.operator, { locales: ['en'], defaultLocale: 'en', types: [{ name: 'note', fields: [{ name: 'title', type: 'string' }] }] }, 0);
  const user = h.member('Editor@example.org');
  const r = await signIn(h, user);
  assert.match(r.login.headers.get('set-cookie')!, /grove_login=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/auth; Max-Age=600$/);
  assert.equal(provider.lastAuthorize.code_challenge_method, 'S256'); assert.equal(provider.lastAuthorize.client_id, clientId); assert.equal(provider.lastAuthorize.response_type, 'code');
  assert.equal(provider.lastAuthorize.scope, 'openid email profile org');
  assert.equal(r.callback.status, 303); assert.equal(r.callback.headers.get('location'), '/');
  assert.ok(r.sessionCookie, 'session cookie set'); assert.match(r.set.find(c => c.startsWith('grove_session='))!, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/);
  assert.ok(r.set.some(c => c.startsWith('grove_login=;') && c.includes('Max-Age=0')), 'login attempt cookie cleared');
  const session = await h.route(new Request(`${origin}/auth/session`, { headers: { cookie: r.sessionCookie! } }));
  assert.equal(session.status, 200);
  const view = await session.json();
  assert.equal(view.email, 'Editor@example.org'); assert.equal(view.role, 'editor'); assert.equal(view.actor, user.sub); assert.equal(view.name, 'Member'); assert.equal(view.mode, 'oidc'); assert.equal(view.login, '/auth/login');
  assert.match(view.csrf, /^[a-f0-9]{64}$/); assert.deepEqual(view.scope, h.scope);
  assert.deepEqual(await h.access.authenticate(new Request(origin, { headers: { cookie: r.sessionCookie! } })), { id: user.sub });
  assert.equal((await h.access.protect(new Request(`${origin}/v1/x`, { method: 'PUT', headers: { cookie: r.sessionCookie!, origin } })))?.status, 403);
  assert.equal((await h.access.protect(new Request(`${origin}/v1/x`, { method: 'PUT', headers: { cookie: r.sessionCookie!, origin: 'https://outside.example', 'x-grove-csrf': view.csrf } })))?.status, 403);
  assert.equal(await h.access.protect(new Request(`${origin}/v1/x`, { method: 'PUT', headers: { cookie: r.sessionCookie!, origin, 'x-grove-csrf': view.csrf } })), null);
  assert.deepEqual(await h.make().authenticate(new Request(origin, { headers: { cookie: r.sessionCookie! } })), { id: user.sub }); // survives a restart
  const headers = { cookie: r.sessionCookie!, origin, 'x-grove-csrf': view.csrf, 'content-type': 'application/json' };
  const saved = await h.route(new Request(`${h.api}/documents/n1`, { method: 'PUT', headers, body: JSON.stringify({ type: 'note', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: 'Hi' } }) }));
  assert.equal(saved.status, 200); assert.equal((await saved.json()).updatedBy, user.sub);
  assert.equal((await h.route(new Request(`${h.api}/documents/n1/publish`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) }))).status, 403);
  assert.equal((await h.route(new Request(r.back, { headers: { cookie: r.loginCookie } }))).status, 400); // a sign-in attempt is single use
  assert.equal(provider.revoked.length > 0, true);
  assert.equal((await h.grove.members.list(h.operator))[0]!.subject, user.sub);
});

test('the tenant claim binds a workspace to one organization; without it any account the provider vouches for may hold a membership', async () => {
  const bound = host();
  await bound.grove.members.invite(bound.operator, { email: 'invited@example.org', role: 'viewer' });
  const foreign = { ...bound.member('invited@example.org'), org: { id: randomUUID(), owner_type: 'org' } };
  const r = await signIn(bound, foreign);
  assert.equal(r.callback.status, 403); assert.equal(r.sessionCookie, undefined);
  assert.equal((await signIn(bound, { ...bound.member('invited@example.org'), org: undefined })).callback.status, 403);
  const open = host({ tenantClaim: null });
  await open.grove.members.invite(open.operator, { email: 'invited@example.org', role: 'viewer' });
  const ok = await signIn(open, { ...open.member('invited@example.org'), org: { id: randomUUID(), owner_type: 'org' } });
  assert.equal(ok.callback.status, 303); assert.ok(ok.sessionCookie);
});

test('non-members, unverified emails, tampered state and failed exchanges never get a session', async () => {
  const h = host();
  const noSession = async (user: User, status: number) => { const r = await signIn(h, user); assert.equal(r.callback.status, status); assert.equal(r.sessionCookie, undefined); assert.equal(r.callback.headers.get('cache-control'), 'no-store'); return r; };
  await noSession(h.member('stranger@example.org'), 403);
  await h.grove.members.invite(h.operator, { email: 'invited@example.org', role: 'viewer' });
  await noSession({ ...h.member('invited@example.org'), email_verified: false }, 403);
  await noSession(h.member('invited@example.org', OPERATOR_ACTOR), 403);
  assert.equal((await h.grove.members.list(h.operator))[0]!.subject, null, 'no binding happened');
  provider.user = h.member('invited@example.org');
  const login = await h.route(new Request(`${origin}/auth/login`)); const loginCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const back = new URL((await fetch(login.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!);
  back.searchParams.set('state', 'tampered');
  assert.equal((await h.route(new Request(back, { headers: { cookie: loginCookie } }))).status, 400);
  assert.equal((await h.route(new Request(`${origin}/auth/callback?code=x&state=y`))).status, 400);
  const denied = await h.route(new Request(`${origin}/auth/callback?error=access_denied`, { headers: { cookie: (await h.route(new Request(`${origin}/auth/login`))).headers.get('set-cookie')!.split(';')[0]! } }));
  assert.equal(denied.status, 403);
  const wrongSecret = host({ secret: 'wrong' });
  await wrongSecret.grove.members.invite(wrongSecret.operator, { email: 'invited@example.org', role: 'viewer' });
  const failed = await signIn(wrongSecret, wrongSecret.member('invited@example.org'));
  assert.equal(failed.callback.status, 502); assert.equal(failed.sessionCookie, undefined);
  assert.deepEqual(await (await h.route(new Request(`${origin}/auth/session`))).json(), { mode: 'oidc', login: '/auth/login' });
});

test('discovery must name the configured issuer; a userinfo outage falls back to the id_token only when issuer, audience and expiry check out', async t => {
  t.after(() => { provider.userinfo = 'up'; provider.audience = clientId; provider.expiresIn = 3600; provider.issuerClaim = ''; });
  provider.issuerClaim = 'https://someone-else.example';
  assert.equal((await host().route(new Request(`${origin}/auth/login`))).status, 502);
  provider.issuerClaim = '';
  const h = host();
  await h.grove.members.invite(h.operator, { email: 'fallback@example.org', role: 'publisher' });
  provider.userinfo = 'down';
  provider.audience = 'someone-else';
  assert.equal((await signIn(h, h.member('fallback@example.org'))).callback.status, 502);
  provider.audience = clientId; provider.expiresIn = -10;
  assert.equal((await signIn(h, h.member('fallback@example.org'))).callback.status, 502);
  provider.expiresIn = 3600;
  const ok = await signIn(h, h.member('fallback@example.org'));
  assert.equal(ok.callback.status, 303); assert.ok(ok.sessionCookie);
  assert.equal((await (await h.route(new Request(`${origin}/auth/session`, { headers: { cookie: ok.sessionCookie! } }))).json()).role, 'publisher');
});

test('the operator bearer token is a server identity that never becomes a member', async () => {
  const token = 'an-operator-token-with-at-least-thirty-two-characters';
  const h = host({ operatorToken: token });
  const request = (authorization: string, method = 'PUT') => new Request(`${origin}/v1/x`, { method, headers: { authorization } });
  assert.deepEqual(await h.access.authenticate(request(`Bearer ${token}`)), { id: OPERATOR_ACTOR });
  assert.equal(await h.access.protect(request(`Bearer ${token}`)), null);
  assert.equal(await h.access.authenticate(request('Bearer wrong')), null);
  assert.equal((await h.route(new Request(`${origin}/auth/session`, { headers: { authorization: `Bearer ${token}` } }))).status, 401);
  const members = await h.route(new Request(`${h.api}/members`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'first@example.org', role: 'owner' }) }));
  assert.equal(members.status, 201); assert.equal((await members.json()).createdBy, OPERATOR_ACTOR);
  assert.equal(await host().access.authenticate(request(`Bearer ${token}`)), null);
});

test('logout, expiry and removal all end access; a removed member is signed out on the next session read', async t => {
  const h = host({ sessionTtlMs: 60_000 });
  const invited = await h.grove.members.invite(h.operator, { email: 'owner@example.org', role: 'owner' });
  const first = await signIn(h, h.member('owner@example.org'));
  const view = await (await h.route(new Request(`${origin}/auth/session`, { headers: { cookie: first.sessionCookie! } }))).json();
  assert.equal((await h.route(new Request(`${origin}/auth/logout`, { method: 'POST', headers: { cookie: first.sessionCookie!, origin } }))).status, 403);
  const out = await h.route(new Request(`${origin}/auth/logout`, { method: 'POST', headers: { cookie: first.sessionCookie!, origin, 'x-grove-csrf': view.csrf } }));
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie')!, /grove_session=; .*Max-Age=0/);
  assert.equal(await h.access.authenticate(new Request(origin, { headers: { cookie: first.sessionCookie! } })), null);
  const second = await signIn(h, h.member('owner@example.org', view.actor));
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 61_000);
  assert.equal(await h.access.authenticate(new Request(origin, { headers: { cookie: second.sessionCookie! } })), null);
  t.mock.restoreAll();
  const third = await signIn(h, h.member('owner@example.org', view.actor));
  await h.grove.members.invite(h.operator, { email: 'other@example.org', role: 'owner' });
  await h.grove.members.resolve(h.scope, { subject: 'other-owner', email: 'other@example.org', emailVerified: true });
  await h.grove.members.remove(h.operator, invited.id);
  assert.equal((await h.route(new Request(`${h.api}/documents`, { headers: { cookie: third.sessionCookie! } }))).status, 403);
  const gone = await h.route(new Request(`${origin}/auth/session`, { headers: { cookie: third.sessionCookie! } }));
  assert.equal(gone.status, 401); assert.match(gone.headers.get('set-cookie')!, /grove_session=; .*Max-Age=0/);
  assert.equal((await h.route(new Request(`${h.api}/documents`, { headers: { cookie: third.sessionCookie! } }))).status, 401);
});
