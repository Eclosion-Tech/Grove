import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scope } from '@eclosion-tech/grove';

const reply = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const equal = (left: string, right: string) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function browserAccess(token: string, scope: Scope, localLogin = false) {
  const sessions = new Map<string, { csrf: string; expires: number; role: string }>();
  const actorId = (role: string) => role === 'owner' ? 'local-developer' : `demo-${role}`;
  const view = (active: { csrf: string; role: string }) => ({ scope, csrf: active.csrf, actor: actorId(active.role), role: active.role, demoRoles: localLogin });
  const cookie = (id: string, age = 28_800) => `grove_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
  function session(request: Request) {
    const now = Date.now();
    for (const [id, value] of sessions) if (value.expires < now) sessions.delete(id);
    const id = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('grove_session='))?.slice(14);
    return id ? sessions.get(id) : undefined;
  }
  const bearer = (request: Request) => equal(request.headers.get('authorization') ?? '', `Bearer ${token}`);
  const sameOrigin = (request: Request) => request.headers.get('origin') === new URL(request.url).origin;
  return {
    authenticate: async (request: Request) => { if (bearer(request)) return { id: 'local-developer' }; const active = session(request); return active ? { id: actorId(active.role) } : null; },
    protect(request: Request): Response | null {
      if (['GET', 'HEAD'].includes(request.method) || bearer(request) || !session(request)) return null;
      if (!sameOrigin(request) || !equal(request.headers.get('x-grove-csrf') ?? '', session(request)!.csrf)) {
        return reply({ error: { code: 'forbidden', message: 'Refresh your session before continuing.' } }, 403);
      }
      return null;
    },
    async route(request: Request): Promise<Response | null> {
      session(request); // Expire abandoned sessions before applying the login capacity limit.
      const url = new URL(request.url);
      if (url.pathname === '/auth/session' && request.method === 'GET') {
        const active = session(request);
        return active ? reply(view(active)) : reply({ localLogin }, 401);
      }
      if (url.pathname === '/auth/login' && request.method === 'POST') {
        if (!sameOrigin(request)) return reply({ error: 'Sign in from this workspace.' }, 403);
        if (!localLogin && !bearer(request)) return reply({ error: 'That access token is not valid.' }, 401);
        if (sessions.size >= 500) return reply({ error: 'Too many active local sessions.' }, 429);
        const id = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
        sessions.set(id, { csrf, expires: Date.now() + 28_800_000, role: 'owner' });
        return reply(view({ csrf, role: 'owner' }), 200, { 'Set-Cookie': cookie(id) });
      }
      if (url.pathname === '/auth/demo-role' && request.method === 'POST') {
        if (!localLogin) return reply({ error: 'Practice roles are only available in local mode.' }, 404);
        const active = session(request);
        if (!active || !sameOrigin(request) || !equal(request.headers.get('x-grove-csrf') ?? '', active.csrf)) return reply({ error: 'Refresh your local session.' }, 403);
        const role = url.searchParams.get('role');
        if (!role || !['owner', 'coordinator', 'reviewer', 'observer'].includes(role)) return reply({ error: 'Unknown practice role.' }, 400);
        active.role = role; active.csrf = randomBytes(32).toString('hex');
        return reply(view(active));
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        if (!sameOrigin(request)) return reply({ error: 'Invalid origin.' }, 403);
        const active = session(request);
        if (active && !equal(request.headers.get('x-grove-csrf') ?? '', active.csrf)) return reply({ error: 'Invalid session.' }, 403);
        for (const [id, value] of sessions) if (value === active) sessions.delete(id);
        return reply({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
      }
      return null;
    },
  };
}

const editorRoot = fileURLToPath(new URL('../../editor/dist/', import.meta.url));
const siteRoot = fileURLToPath(new URL('../../example-site/dist/', import.meta.url));
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
export async function staticResponse(request: Request): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
  let path: string;
  try { path = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Invalid path', { status: 400 }); }
  const site = path === '/example-site' || path.startsWith('/example-site/');
  const root = site ? siteRoot : editorRoot;
  const relative = site ? path.slice('/example-site'.length) : path;
  if (relative.split('/').some(part => part.startsWith('.'))) return new Response('Not found', { status: 404 });
  const name = relative.includes('/assets/') ? relative.slice(1) : !extname(relative) ? 'index.html' : relative.slice(1);
  const file = resolve(root, name);
  if (!file.startsWith(resolve(root) + sep) || name.split('/').some(p => p.startsWith('.'))) return new Response('Not found', { status: 404 });
  try {
    const content = await readFile(file);
    return new Response(request.method === 'HEAD' ? null : content, { headers: {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    } });
  } catch { return new Response('Grove editor is not built. Run npm run build.', { status: 404 }); }
}
