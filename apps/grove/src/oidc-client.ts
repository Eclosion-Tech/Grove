import { createHash, randomBytes } from 'node:crypto';

/** Minimal OpenID Connect relying-party client: discovery, authorization-code flow with PKCE, userinfo, revocation. */
export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scopes?: string[]; fetcher?: typeof fetch; timeoutMs?: number };
export type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string; revocation_endpoint?: string; end_session_endpoint?: string };
export type Tokens = { access_token: string; token_type?: string; expires_in?: number; id_token?: string; scope?: string };
export class OidcError extends Error { override readonly name = 'OidcError'; }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const endpoint = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new OidcError(`The provider's ${name} is missing`);
  let url: URL;
  try { url = new URL(value); } catch { throw new OidcError(`The provider's ${name} is not a valid URL`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) throw new OidcError(`The provider's ${name} must use https`);
  return value;
};

export class OidcClient {
  readonly issuer: string;
  readonly clientId: string;
  private discovery: Promise<Discovery> | null = null;
  constructor(private readonly config: OidcConfig) {
    let url: URL;
    try { url = new URL(config.issuer); } catch { throw new Error('GROVE_OIDC_ISSUER must be a URL'); }
    if (url.search || url.hash || url.username || url.password) throw new Error('GROVE_OIDC_ISSUER must be a bare issuer URL');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) throw new Error('GROVE_OIDC_ISSUER must use https outside loopback');
    if (!config.clientId || !config.clientSecret) throw new Error('GROVE_OIDC_CLIENT_ID and GROVE_OIDC_CLIENT_SECRET are required');
    this.issuer = config.issuer.replace(/\/+$/, '');
    this.clientId = config.clientId;
  }
  private async fetchJson(url: string, init: RequestInit, maxBytes = 256_000): Promise<unknown> {
    let response: Response;
    try {
      response = await (this.config.fetcher ?? fetch)(url, { ...init, headers: { Accept: 'application/json', ...init.headers }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000) });
    } catch { throw new OidcError('The identity provider could not be reached'); }
    const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (!response.ok) throw new OidcError(`The identity provider refused the request (${response.status})`);
    if (bytes.byteLength > maxBytes) throw new OidcError('The identity provider response was too large');
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new OidcError('The identity provider returned malformed JSON'); }
  }
  async discover(): Promise<Discovery> {
    if (!this.discovery) this.discovery = this.load().catch(error => { this.discovery = null; throw error; });
    return this.discovery;
  }
  private async load(): Promise<Discovery> {
    const doc = await this.fetchJson(`${this.issuer}/.well-known/openid-configuration`, { method: 'GET' });
    if (!object(doc)) throw new OidcError('The provider discovery document is invalid');
    if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== this.issuer) throw new OidcError('The provider discovery document names a different issuer');
    return {
      issuer: this.issuer,
      authorization_endpoint: endpoint(doc.authorization_endpoint, 'authorization endpoint'),
      token_endpoint: endpoint(doc.token_endpoint, 'token endpoint'),
      userinfo_endpoint: typeof doc.userinfo_endpoint === 'string' ? endpoint(doc.userinfo_endpoint, 'userinfo endpoint') : undefined,
      revocation_endpoint: typeof doc.revocation_endpoint === 'string' ? endpoint(doc.revocation_endpoint, 'revocation endpoint') : undefined,
      end_session_endpoint: typeof doc.end_session_endpoint === 'string' ? endpoint(doc.end_session_endpoint, 'end session endpoint') : undefined,
    };
  }
  async authorizationUrl(): Promise<{ url: string; state: string; codeVerifier: string }> {
    const discovery = await this.discover();
    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', (this.config.scopes ?? ['openid', 'email', 'profile']).join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state, codeVerifier };
  }
  /** Authorization-code exchange with client_secret_post and the PKCE verifier. */
  async exchange(code: string, codeVerifier: string): Promise<Tokens> {
    const discovery = await this.discover();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, client_id: this.clientId, client_secret: this.config.clientSecret, code_verifier: codeVerifier });
    const value = await this.fetchJson(discovery.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!object(value) || typeof value.access_token !== 'string' || !value.access_token) throw new OidcError('The identity provider returned no access token');
    return value as Tokens;
  }
  async userinfo(accessToken: string): Promise<Record<string, unknown>> {
    const discovery = await this.discover();
    if (!discovery.userinfo_endpoint) throw new OidcError('The identity provider has no userinfo endpoint');
    const value = await this.fetchJson(discovery.userinfo_endpoint, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } });
    if (!object(value)) throw new OidcError('The identity provider returned invalid userinfo');
    return value;
  }
  /** Best effort; providers without a revocation endpoint are skipped and failures are ignored. */
  async revoke(token: string): Promise<void> {
    const discovery = await this.discover().catch(() => null);
    if (!discovery?.revocation_endpoint) return;
    const body = new URLSearchParams({ token, token_type_hint: 'access_token', client_id: this.clientId, client_secret: this.config.clientSecret });
    await (this.config.fetcher ?? fetch)(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000) }).catch(() => {});
  }
}
