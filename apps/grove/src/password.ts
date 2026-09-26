import type { Accounts, Authorize } from '@eclosion-tech/grove/server';
import { GroveError } from '@eclosion-tech/grove/server';
import { FAILURES, hostIdentity, jsonBody, reply, type IdentityOptions } from './identity.js';

export type PasswordAccessOptions = Omit<IdentityOptions, 'mode'> & {
  accounts: Accounts;
  authorize: Authorize;
  invitationTtlMs?: number;
  /** Failed sign-ins per email address before a temporary lockout. */
  maxFailures?: number;
  lockoutMs?: number;
};
const error = (e: unknown, fallback: string) => e instanceof GroveError ? reply({ error: e.message }, e.status) : reply({ error: fallback }, 500);
const notMember = { unverified: FAILURES.unverified.body, reserved: FAILURES.reserved.body, 'not-member': 'This account is not a member of this workspace. Ask an owner to invite this email address.' };

/** Native sign-in for standalone hosts: invitation links set the first password; no email delivery is required. */
export function passwordAccess(options: PasswordAccessOptions) {
  const host = hostIdentity({ ...options, mode: 'password' });
  const maxFailures = options.maxFailures ?? 10;
  const lockout = options.lockoutMs ?? 15 * 60_000;
  const attempts = new Map<string, { failures: number; until: number }>();
  const key = (email: unknown) => typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
  const locked = (email: string) => { const state = attempts.get(email); return !!state && state.until > Date.now(); };
  const failed = (email: string) => {
    for (const [k, v] of attempts) if (v.until && v.until < Date.now() - lockout) attempts.delete(k);
    const state = attempts.get(email) ?? { failures: 0, until: 0 };
    state.failures += 1;
    if (state.failures >= maxFailures) { state.until = Date.now() + lockout; state.failures = 0; }
    attempts.set(email, state);
  };
  async function signIn(identity: { subject: string; email: string }): Promise<Response> {
    const result = await host.signIn({ ...identity, emailVerified: true });
    if (!result.ok) return reply({ error: notMember[result.reason] }, 403);
    return reply(host.view(result.active, result.member), 200, { 'Set-Cookie': result.setCookie });
  }
  return {
    authenticate: (request: Request) => host.authenticate(request),
    protect: (request: Request) => host.protect(request),
    async route(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/auth/')) return null;
      if (url.pathname === '/auth/session' && request.method === 'GET') return host.sessionResponse(request, { mode: 'password' });
      if (url.pathname === '/auth/logout' && request.method === 'POST') return host.logout(request);
      if (request.method !== 'POST') return null;
      if (url.pathname === '/auth/login') {
        if (!host.sameOrigin(request)) return reply({ error: 'Sign in from this workspace.' }, 403);
        const body = await jsonBody(request);
        const email = key(body.email);
        if (locked(email)) return reply({ error: 'Too many sign-in attempts. Try again in a few minutes.' }, 429);
        const account = await options.accounts.verify(body.email, body.password);
        if (!account) { failed(email); return reply({ error: 'Check your email address and password.' }, 401); }
        attempts.delete(email);
        return signIn({ subject: account.id, email: account.email });
      }
      if (url.pathname === '/auth/accept') {
        if (!host.sameOrigin(request)) return reply({ error: 'Open the invitation link in this workspace.' }, 403);
        const body = await jsonBody(request);
        try {
          const account = await options.accounts.accept(body.token, body.password);
          return signIn({ subject: account.id, email: account.email });
        } catch (e) { return error(e, 'The invitation could not be accepted.'); }
      }
      if (url.pathname === '/auth/invitations') {
        // Owners (or the operator) create a one-time link for an email that is already invited as a member.
        const actor = await host.authenticate(request);
        if (!actor) return reply({ error: 'Sign in first.' }, 401);
        const guard = await host.protect(request);
        if (guard) return guard;
        if (!await options.authorize(actor, options.scope, 'members:write')) return reply({ error: 'Only workspace owners can create invitation links.' }, 403);
        const body = await jsonBody(request);
        const member = await options.members.byEmail(options.scope, body.email);
        if (!member) return reply({ error: 'Invite this email address as a member first.' }, 404);
        try {
          const invitation = await options.accounts.invite(member.email, options.invitationTtlMs);
          return reply({ email: invitation.email, url: `${host.origin}/accept#token=${invitation.token}`, expiresAt: invitation.expiresAt }, 201);
        } catch (e) { return error(e, 'The invitation could not be created.'); }
      }
      if (url.pathname === '/auth/password') {
        const found = await host.current(request);
        if (!found) return reply({ error: 'Sign in first.' }, 401);
        const guard = await host.protect(request);
        if (guard) return guard;
        const body = await jsonBody(request);
        try { await options.accounts.changePassword(found.active.subject!, body.current, body.next); return reply({ ok: true }); }
        catch (e) { return error(e, 'The password could not be changed.'); }
      }
      return null;
    },
  };
}
