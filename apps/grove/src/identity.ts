import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Member, Scope } from '@eclosion-tech/grove';
import type { Actor, Members, SessionStore, SessionRecord } from '@eclosion-tech/grove/server';

/** The server-side machine identity (CI, bootstrap). It is never a member and can never sign in through the browser. */
export const OPERATOR_ACTOR = 'operator';
export type AuthMode = 'password' | 'oidc';
/** What any sign-in method must establish before Grove consults membership. */
export type VerifiedIdentity = { subject: string; email: string; emailVerified: boolean; name?: string };
export type IdentityOptions = {
  mode: AuthMode;
  sessions: SessionStore;
  members: Members;
  scope: Scope;
  /** Public origin of this host. Cookies, origin checks and callback URLs are bound to it. */
  publicUrl: string;
  /** Optional bearer credential for servers. At least 32 characters; never exposed to browsers. */
  operatorToken?: string;
  sessionTtlMs?: number;
  onError?: (error: unknown) => void;
};
export type SignInFailure = 'unverified' | 'reserved' | 'not-member';
export const FAILURES: Record<SignInFailure, { title: string; body: string }> = {
  unverified: { title: 'Verify your email address', body: 'Confirm your email address with your identity provider, then sign in again.' },
  reserved: { title: 'Reserved identity', body: 'This account cannot use the workspace.' },
  'not-member': { title: 'Not a member', body: 'Ask a workspace owner to invite this email address, then sign in again.' },
};

export const reply = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export const page = (status: number, title: string, body: string, headers: HeadersInit = {}) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · Grove</title><main style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.5rem">${title}</h1><p>${body}</p><p><a href="/">Back to Grove</a></p></main>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers } },
);
export const equal = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
export const cookies = (request: Request): Record<string, string> => Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; }));
export const text = (value: unknown) => typeof value === 'string' ? value : '';
/** Bounded JSON body for sign-in routes; anything else is an empty object. */
export async function jsonBody(request: Request, maxBytes = 16_000): Promise<Record<string, unknown>> {
  try {
    const raw = await request.text();
    if (raw.length > maxBytes) return {};
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Sessions, CSRF and membership binding shared by every sign-in method. */
export function hostIdentity(options: IdentityOptions) {
  const origin = new URL(options.publicUrl).origin;
  const secure = origin.startsWith('https:');
  const sessionTtl = options.sessionTtlMs ?? 8 * 3600_000;
  const cookie = (name: string, value: string, age: number, path = '/', sameSite: 'Strict' | 'Lax' = 'Strict') => `${name}=${value}; HttpOnly; SameSite=${sameSite}; Path=${path}; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const clearSession = cookie('grove_session', '', 0);
  const bearer = (request: Request) => !!options.operatorToken && equal(request.headers.get('authorization') ?? '', `Bearer ${options.operatorToken}`);
  const sameOrigin = (request: Request) => request.headers.get('origin') === origin;
  const session = (request: Request) => options.sessions.read('session', cookies(request).grove_session);
  const csrfValid = (request: Request, active: SessionRecord) => equal(request.headers.get('x-grove-csrf') ?? '', active.csrf ?? '');
  const view = (active: SessionRecord, member: Member) => ({ scope: options.scope, csrf: active.csrf, actor: active.subject, email: active.email, name: active.data.name ?? null, role: member.role, mode: options.mode, ...(options.mode === 'oidc' ? { login: '/auth/login' } : {}) });
  return {
    origin, secure, cookie, clearSession, bearer, sameOrigin, session, csrfValid, view,
    /** Binds a verified identity to its membership and opens a session. */
    async signIn(identity: VerifiedIdentity): Promise<{ ok: true; member: Member; active: SessionRecord; setCookie: string } | { ok: false; reason: SignInFailure }> {
      if (!identity.emailVerified) return { ok: false, reason: 'unverified' };
      if (identity.subject === OPERATOR_ACTOR) return { ok: false, reason: 'reserved' };
      const member = await options.members.resolve(options.scope, identity);
      if (!member) return { ok: false, reason: 'not-member' };
      const csrf = randomBytes(32).toString('hex');
      const data = { name: identity.name ?? null };
      const id = await options.sessions.create('session', sessionTtl, { subject: identity.subject, email: identity.email, csrf, data });
      const active: SessionRecord = { kind: 'session', subject: identity.subject, email: identity.email, csrf, data, expiresAt: new Date(Date.now() + sessionTtl).toISOString() };
      return { ok: true, member, active, setCookie: cookie('grove_session', id, Math.floor(sessionTtl / 1000)) };
    },
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
    /** The signed-in session and its current membership, or null. A session whose membership is gone is revoked. */
    async current(request: Request): Promise<{ active: SessionRecord; member: Member } | null> {
      const active = await session(request);
      if (!active?.subject) return null;
      const member = await options.members.membership(options.scope, active.subject);
      if (member) return { active, member };
      await options.sessions.delete(cookies(request).grove_session);
      return null;
    },
    async sessionResponse(request: Request, unauthenticated: Record<string, unknown>): Promise<Response> {
      const had = !!cookies(request).grove_session;
      const found = await this.current(request);
      if (!found) return reply(unauthenticated, 401, had ? { 'Set-Cookie': clearSession } : {});
      return reply(view(found.active, found.member));
    },
    async logout(request: Request): Promise<Response> {
      if (!sameOrigin(request)) return reply({ error: 'Invalid origin.' }, 403);
      const id = cookies(request).grove_session;
      const active = await options.sessions.read('session', id);
      if (active && !csrfValid(request, active)) return reply({ error: 'Invalid session.' }, 403);
      if (active) await options.sessions.delete(id);
      return reply({ ok: true }, 200, { 'Set-Cookie': clearSession });
    },
  };
}
