import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SyntropyAuthClient, TokenResponse } from '@eclosion-tech/syntropy-auth';
import type { Scope } from '@eclosion-tech/grove';
import type { Actor, Members, SessionStore, SessionRecord } from '@eclosion-tech/grove/server';

/** The server-side machine identity (CI, bootstrap). It is never a member and can never sign in through the browser. */
export const OPERATOR_ACTOR = 'operator';
export type SyntropyIdentity = { subject: string; email: string; emailVerified: boolean; name?: string; org?: { id: string; ownerType: string } };
export type SyntropyAccessOptions = {
  auth: SyntropyAuthClient;
  clientId: string;
  sessions: SessionStore;
  members: Members;
  scope: Scope;
  /** Public origin of this host. Cookies, origin checks and the sign-in callback are bound to it. */
  publicUrl: string;
  /** Optional bearer credential for servers. At least 32 characters; never exposed to browsers. */
  operatorToken?: string;
  sessionTtlMs?: number;
  loginTtlMs?: number;
  onError?: (error: unknown) => void;
};

const reply = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const page = (status: number, title: string, body: string, headers: HeadersInit = {}) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · Grove</title><main style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.5rem">${title}</h1><p>${body}</p><p><a href="/">Back to Grove</a></p></main>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers } },
);
const equal = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
const cookies = (request: Request): Record<string, string> => Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; }));
const text = (value: unknown) => typeof value === 'string' ? value : '';

function normalize(claims: Record<string, unknown>): SyntropyIdentity {
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') throw new Error('The identity provider returned no subject or email');
  const org = claims.org && typeof claims.org === 'object' ? claims.org as Record<string, unknown> : null;
  return {
    subject: claims.sub, email: claims.email, emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    org: org ? { id: text(org.id), ownerType: text(org.owner_type) } : undefined,
  };
}

/** Syntropy Auth identity for a deployed Grove host: OIDC code flow with PKCE, Grove-owned membership, persistent server sessions. */
export function syntropyAccess(options: SyntropyAccessOptions) {
  const origin = new URL(options.publicUrl).origin;
  const secure = origin.startsWith('https:');
  const sessionTtl = options.sessionTtlMs ?? 8 * 3600_000;
  const loginTtl = options.loginTtlMs ?? 10 * 60_000;
  const cookie = (name: string, value: string, age: number, path = '/', sameSite: 'Strict' | 'Lax' = 'Strict') => `${name}=${value}; HttpOnly; SameSite=${sameSite}; Path=${path}; Max-Age=${age}${secure ? '; Secure' : ''}`;
  // The sign-in attempt cookie must survive the top-level redirect back from Syntropy, so it is Lax and scoped to /auth only.
  const clearLogin = cookie('grove_login', '', 0, '/auth', 'Lax');
  const clearSession = cookie('grove_session', '', 0);
  const bearer = (request: Request) => !!options.operatorToken && equal(request.headers.get('authorization') ?? '', `Bearer ${options.operatorToken}`);
  const sameOrigin = (request: Request) => request.headers.get('origin') === origin;
  const session = (request: Request) => options.sessions.read('session', cookies(request).grove_session);
  const csrfValid = (request: Request, active: SessionRecord) => equal(request.headers.get('x-grove-csrf') ?? '', active.csrf ?? '');

  async function identity(tokens: TokenResponse): Promise<SyntropyIdentity> {
    try { return normalize(await options.auth.getUserInfo(tokens.access_token) as unknown as Record<string, unknown>); }
    catch (error) {
      // Syntropy's userinfo endpoint has been observed failing for hosted apps. The id_token arrived directly from the token
      // endpoint over TLS with client authentication, which OIDC Core 3.1.3.7 accepts in place of signature validation;
      // issuer, audience and expiry are still checked before any claim is trusted.
      const payload = tokens.id_token?.split('.')[1];
      if (!payload) throw error;
      let claims: Record<string, unknown>;
      try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw error; }
      const { issuer } = await options.auth.discoverEndpoints();
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== issuer || !audience.includes(options.clientId) || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw error;
      return normalize(claims);
    }
  }

  async function callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fail = (status: number, title: string, body: string) => page(status, title, body, { 'Set-Cookie': clearLogin });
    const attempt = await options.sessions.consume('login', cookies(request).grove_login);
    if (!attempt) return fail(400, 'Sign-in expired', 'Start again from the workspace.');
    if (url.searchParams.get('error')) return fail(403, 'Sign-in cancelled', 'Syntropy did not authorize this sign-in.');
    const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
    if (!code || !state || !equal(state, text(attempt.data.state))) return fail(400, 'Sign-in could not be verified', 'Start again from the workspace.');
    let who: SyntropyIdentity;
    try {
      const tokens = await options.auth.exchangeCode({ code, codeVerifier: text(attempt.data.codeVerifier) });
      who = await identity(tokens);
      void options.auth.revokeToken(tokens.access_token, 'access_token').catch(() => {});
    } catch (error) {
      options.onError?.(error);
      return fail(502, 'Sign-in could not be completed', 'Syntropy Auth did not accept this sign-in. Try again in a moment.');
    }
    if (!who.emailVerified) return fail(403, 'Verify your email address', 'Confirm your email address with Syntropy, then sign in again.');
    if (who.org?.ownerType !== 'org' || who.org.id !== options.scope.tenantId) return fail(403, 'Wrong organization', 'This account does not belong to the organization that owns this workspace.');
    if (who.subject === OPERATOR_ACTOR) return fail(403, 'Reserved identity', 'This account cannot use the workspace.');
    const member = await options.members.resolve(options.scope, who);
    if (!member) return fail(403, 'Not a member', 'Ask a workspace owner to invite this email address, then sign in again.');
    const id = await options.sessions.create('session', sessionTtl, { subject: who.subject, email: who.email, csrf: randomBytes(32).toString('hex'), data: { name: who.name ?? null } });
    const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', cookie('grove_session', id, Math.floor(sessionTtl / 1000)));
    headers.append('Set-Cookie', clearLogin);
    return new Response(null, { status: 303, headers });
  }

  return {
    async authenticate(request: Request): Promise<Actor | null> {
      if (bearer(request)) return { id: OPERATOR_ACTOR };
      const active = await session(request);
      return active?.subject ? { id: active.subject } : null;
    },
    async protect(request: Request): Promise<Response | null> {
      if (['GET', 'HEAD'].includes(request.method) || bearer(request)) return null;
      const active = await session(request);
      if (!active) return null;
      if (!sameOrigin(request) || !csrfValid(request, active)) return reply({ error: { code: 'forbidden', message: 'Refresh your session before continuing.' } }, 403);
      return null;
    },
    async route(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/auth/')) return null;
      if (url.pathname === '/auth/session' && request.method === 'GET') {
        const active = await session(request);
        const member = active?.subject ? await options.members.membership(options.scope, active.subject) : null;
        if (!active || !member) {
          if (active) await options.sessions.delete(cookies(request).grove_session);
          return reply({ login: '/auth/login' }, 401, active ? { 'Set-Cookie': clearSession } : {});
        }
        return reply({ scope: options.scope, csrf: active.csrf, actor: active.subject, email: active.email, name: active.data.name ?? null, role: member.role, login: '/auth/login' });
      }
      if (url.pathname === '/auth/login' && request.method === 'GET') {
        await options.sessions.purge();
        let target: string, state: string, codeVerifier: string;
        try { ({ url: target, state, codeVerifier } = await options.auth.createAuthorizationUrl()); }
        catch (error) { options.onError?.(error); return page(502, 'Sign-in unavailable', 'Syntropy Auth could not be reached. Try again in a moment.'); }
        const id = await options.sessions.create('login', loginTtl, { data: { state, codeVerifier } });
        return new Response(null, { status: 302, headers: { Location: target, 'Set-Cookie': cookie('grove_login', id, Math.floor(loginTtl / 1000), '/auth', 'Lax'), 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') return callback(request);
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        if (!sameOrigin(request)) return reply({ error: 'Invalid origin.' }, 403);
        const id = cookies(request).grove_session;
        const active = await options.sessions.read('session', id);
        if (active && !csrfValid(request, active)) return reply({ error: 'Invalid session.' }, 403);
        if (active) await options.sessions.delete(id);
        return reply({ ok: true }, 200, { 'Set-Cookie': clearSession });
      }
      return null;
    },
  };
}
