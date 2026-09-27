import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { listen } from '../apps/grove/src/serve.js';

test('HTTP adapter preserves the session cookie alongside login-cookie deletion on an OIDC redirect', async t => {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const previousListeners = signals.map(signal => new Set(process.listeners(signal)));
  const sessionCookie = 'grove_session=opaque-session; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800';
  const clearLoginCookie = 'grove_login=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0';
  const server = listen({
    port: 0, bind: '127.0.0.1', protocol: 'http', hosts: port => [`127.0.0.1:${port}`], label: 'Cookie regression test', close: async () => {},
    route: async request => {
      if (new URL(request.url).pathname === '/auth/callback') {
        const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
        headers.append('Set-Cookie', sessionCookie);
        headers.append('Set-Cookie', clearLoginCookie);
        return new Response(null, { status: 303, headers });
      }
      return Response.json({ authenticated: request.headers.get('cookie') === 'grove_session=opaque-session' });
    },
  });
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    signals.forEach((signal, i) => {
      for (const listener of process.listeners(signal)) if (!previousListeners[i]!.has(listener)) process.removeListener(signal, listener);
    });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const callback = await fetch(`${origin}/auth/callback`, { redirect: 'manual' });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/');
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  assert.deepEqual(callback.headers.getSetCookie(), [sessionCookie, clearLoginCookie]);
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('grove_session='))!.split(';')[0]!;
  assert.deepEqual(await (await fetch(`${origin}/auth/session`, { headers: { cookie } })).json(), { authenticated: true });
});
