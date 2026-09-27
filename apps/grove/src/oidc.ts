import { FAILURES, cookies, equal, hostIdentity, page, text, type IdentityOptions, type VerifiedIdentity } from './identity.js';
import { parseRequiredClaims, matchesRequiredClaims } from './oidc-claims.js';
import type { OidcClient, Tokens } from './oidc-client.js';

export type OidcAccessOptions = Omit<IdentityOptions, 'mode'> & {
  client: OidcClient;
  /** Dotted path to a claim that must equal the workspace tenant id, for example `org.id`. Unset means any account the provider vouches for may hold a membership. */
  tenantClaim?: string;
  /** Exact claim values required independently of the content tenant. */
  requiredClaims?: Record<string, string>;
  loginTtlMs?: number;
};
const claim = (claims: Record<string, unknown>, path: string): unknown => path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, claims);
function normalize(claims: Record<string, unknown>): VerifiedIdentity & { claims: Record<string, unknown> } {
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') throw new Error('The identity provider returned no subject or email');
  return { subject: claims.sub, email: claims.email, emailVerified: claims.email_verified === true, name: typeof claims.name === 'string' ? claims.name : undefined, claims };
}

/** Generic OpenID Connect sign-in: authorization-code flow with PKCE, Grove-owned membership, persistent server sessions. */
export function oidcAccess(options: OidcAccessOptions) {
  const requiredClaims = parseRequiredClaims(options.requiredClaims === undefined ? undefined : JSON.stringify(options.requiredClaims));
  const host = hostIdentity({ ...options, mode: 'oidc' });
  const loginTtl = options.loginTtlMs ?? 10 * 60_000;
  // The sign-in attempt cookie must survive the top-level redirect back from the provider, so it is Lax and scoped to /auth only.
  const clearLogin = host.cookie('grove_login', '', 0, '/auth', 'Lax');
  async function identity(tokens: Tokens) {
    try { return normalize(await options.client.userinfo(tokens.access_token)); }
    catch (error) {
      // Some providers answer userinfo unreliably. The id_token arrived directly from the token endpoint over TLS with client
      // authentication, which OIDC Core 3.1.3.7 accepts in place of signature validation; issuer, audience and expiry are checked.
      const payload = tokens.id_token?.split('.')[1];
      if (!payload) throw error;
      let claims: Record<string, unknown>;
      try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw error; }
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== options.client.issuer || !audience.includes(options.client.clientId) || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw error;
      return normalize(claims);
    }
  }
  async function callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fail = (status: number, title: string, body: string) => page(status, title, body, { 'Set-Cookie': clearLogin });
    const attempt = await options.sessions.consume('login', cookies(request).grove_login);
    if (!attempt) return fail(400, 'Sign-in expired', 'Start again from the workspace.');
    if (url.searchParams.get('error')) return fail(403, 'Sign-in cancelled', 'The identity provider did not authorize this sign-in.');
    const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
    if (!code || !state || !equal(state, text(attempt.data.state))) return fail(400, 'Sign-in could not be verified', 'Start again from the workspace.');
    let who: ReturnType<typeof normalize>;
    try {
      const tokens = await options.client.exchange(code, text(attempt.data.codeVerifier));
      who = await identity(tokens);
      void options.client.revoke(tokens.access_token);
    } catch (error) {
      options.onError?.(error);
      return fail(502, 'Sign-in could not be completed', 'The identity provider did not accept this sign-in. Try again in a moment.');
    }
    if (options.tenantClaim && String(claim(who.claims, options.tenantClaim) ?? '') !== options.scope.tenantId) return fail(403, 'Wrong organization', 'This account does not belong to the organization that owns this workspace.');
    if (!matchesRequiredClaims(who.claims, requiredClaims)) return fail(403, 'Wrong sign-in scope', 'This account does not belong to the identity directory configured for this workspace.');
    const result = await host.signIn(who);
    if (!result.ok) return fail(403, FAILURES[result.reason].title, FAILURES[result.reason].body);
    const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', result.setCookie);
    headers.append('Set-Cookie', clearLogin);
    return new Response(null, { status: 303, headers });
  }
  return {
    authenticate: (request: Request) => host.authenticate(request),
    protect: (request: Request) => host.protect(request),
    async route(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/auth/')) return null;
      if (url.pathname === '/auth/session' && request.method === 'GET') return host.sessionResponse(request, { mode: 'oidc', login: '/auth/login' });
      if (url.pathname === '/auth/login' && request.method === 'GET') {
        await options.sessions.purge();
        let target: string, state: string, codeVerifier: string;
        try { ({ url: target, state, codeVerifier } = await options.client.authorizationUrl()); }
        catch (error) { options.onError?.(error); return page(502, 'Sign-in unavailable', 'The identity provider could not be reached. Try again in a moment.'); }
        const id = await options.sessions.create('login', loginTtl, { data: { state, codeVerifier } });
        return new Response(null, { status: 302, headers: { Location: target, 'Set-Cookie': host.cookie('grove_login', id, Math.floor(loginTtl / 1000), '/auth', 'Lax'), 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') return callback(request);
      if (url.pathname === '/auth/logout' && request.method === 'POST') return host.logout(request);
      return null;
    },
  };
}
