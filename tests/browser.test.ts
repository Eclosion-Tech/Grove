import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserAccess, staticResponse } from '../apps/grove/src/browser.js';

const scope = { tenantId: 'local', siteId: 'demo', environment: 'development' };
const token = 'a-development-token-with-at-least-thirty-two-characters';
const origin = 'http://127.0.0.1:4310';

test('browser sessions are HttpOnly, reject cross-origin login, and keep API credentials server-side', async () => {
  const access = browserAccess(token, scope);
  const anonymous = await access.route(new Request(`${origin}/auth/session`));
  assert.equal(anonymous?.status, 401);
  const wrongOrigin = await access.route(new Request(`${origin}/auth/login`, { method: 'POST', headers: { origin: 'https://outside.example', authorization: `Bearer ${token}` } }));
  assert.equal(wrongOrigin?.status, 403);
  const login = await access.route(new Request(`${origin}/auth/login`, { method: 'POST', headers: { origin, authorization: `Bearer ${token}` } }));
  assert.equal(login?.status, 200);
  const cookieHeader = login!.headers.get('set-cookie')!;
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Strict/);
  const cookie = cookieHeader.split(';')[0]!;
  const session = await login!.json(); assert.ok(session.csrf); assert.equal(JSON.stringify(session).includes(token), false);
  assert.deepEqual(await access.authenticate(new Request(`${origin}/v1/documents`, { headers: { cookie } })), { id: 'local-developer' });
  assert.equal(access.protect(new Request(`${origin}/v1/documents`, { method: 'PUT', headers: { cookie, origin } }))?.status, 403);
  assert.equal(access.protect(new Request(`${origin}/v1/documents`, { method: 'PUT', headers: { cookie, origin: 'https://outside.example', 'x-grove-csrf': session.csrf } }))?.status, 403);
  assert.equal(access.protect(new Request(`${origin}/v1/documents`, { method: 'PUT', headers: { cookie, origin, 'x-grove-csrf': session.csrf } })), null);
  const logout = await access.route(new Request(`${origin}/auth/logout`, { method: 'POST', headers: { cookie, origin, 'x-grove-csrf': session.csrf } }));
  assert.equal(logout?.status, 200);
  assert.equal(await access.authenticate(new Request(`${origin}/v1/documents`, { headers: { cookie } })), null);
});

test('one-click local login is opt-in and always requires the workspace origin', async () => {
  const request = () => new Request(`${origin}/auth/login`, { method: 'POST', headers: { origin } });
  assert.equal((await browserAccess(token, scope).route(request()))?.status, 401);
  const local = browserAccess(token, scope, true);
  assert.equal((await local.route(request()))?.status, 200);
  assert.equal((await local.route(new Request(`${origin}/auth/login`, { method: 'POST' })))?.status, 403);
});

test('bearer CLI access remains independent of browser session and CSRF', async () => {
  const access = browserAccess(token, scope);
  const request = new Request(`${origin}/v1/documents`, { method: 'PUT', headers: { authorization: `Bearer ${token}` } });
  assert.equal(access.protect(request), null);
  assert.deepEqual(await access.authenticate(request), { id: 'local-developer' });
});

test('expired browser sessions cannot read drafts or retrieve a CSRF token', async t => {
  const access = browserAccess(token, scope, true);
  const login = await access.route(new Request(`${origin}/auth/login`, { method: 'POST', headers: { origin } }));
  const cookie = login!.headers.get('set-cookie')!.split(';')[0]!;
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 29_000_000);
  assert.equal(await access.authenticate(new Request(`${origin}/v1/documents`, { headers: { cookie } })), null);
  assert.equal((await access.route(new Request(`${origin}/auth/session`, { headers: { cookie } })))?.status, 401);
});

test('static editor and client site serve their own builds without exposing source files', async () => {
  const editor = await staticResponse(new Request(`${origin}/`)); assert.equal(editor.status, 200); assert.match(await editor.text(), /Grove · Content/);
  const site = await staticResponse(new Request(`${origin}/example-site/`)); assert.equal(site.status, 200); assert.match(await site.text(), /Fieldnotes/);
  assert.equal((await staticResponse(new Request(`${origin}/.env`))).status, 404);
  assert.equal((await staticResponse(new Request(`${origin}/assets/%2e%2e%2f%2e%2e%2fpackage.json`))).status, 404);
  assert.equal((await staticResponse(new Request(`${origin}/src/main.tsx`))).status, 404);
});

test('practice roles require opt-in, same origin and CSRF; role changes alter the authenticated actor', async () => {
  const access = browserAccess(token, scope, true);
  const login = await access.route(new Request(`${origin}/auth/login`, { method: 'POST', headers: { origin } }));
  const cookie = login!.headers.get('set-cookie')!.split(';')[0]!; const session = await login!.json();
  const change = (csrf: string, role = 'observer') => new Request(`${origin}/auth/demo-role?role=${role}`, { method: 'POST', headers: { origin, cookie, 'x-grove-csrf': csrf } });
  assert.equal((await access.route(change('wrong')))?.status, 403);
  assert.equal((await browserAccess(token, scope).route(change(session.csrf)))?.status, 404);
  const response = await access.route(change(session.csrf)); assert.equal(response?.status, 200);
  const next = await response!.json(); assert.equal(next.actor, 'demo-observer'); assert.notEqual(next.csrf, session.csrf);
  assert.deepEqual(await access.authenticate(new Request(origin, { headers: { cookie } })), { id: 'demo-observer' });
  assert.equal((await access.route(change(session.csrf, 'owner')))?.status, 403);
  assert.equal((await access.route(change(next.csrf, 'invented-role')))?.status, 400);
  assert.equal((await access.route(new Request(`${origin}/auth/demo-role?role=owner`, { method: 'POST', headers: { cookie, 'x-grove-csrf': next.csrf } })))?.status, 403);
});
