import { Accounts, Grove, GroveAdmin, InstanceKeys, SessionStore, createHandler, createPostgresDatabase, migrate, type Authorize } from '@eclosion-tech/grove/server';
import type { Scope } from '@eclosion-tech/grove';
import { emailApi } from './email.js';
import { staticResponse } from './browser.js';
import { exampleApi } from './example-api.js';
import { compose, listen, type Access } from './serve.js';
import { connectionsFor, loadAdminModules, moduleProvider } from './modules.js';
import { OPERATOR_ACTOR } from './identity.js';
import { OidcClient } from './oidc-client.js';
import { parseRequiredClaims } from './oidc-claims.js';
import { oidcAccess } from './oidc.js';
import { hostStorage } from './storage.js';
import { passwordAccess } from './password.js';

/** Deployable Grove host. Native password sign-in by default; any OpenID Connect provider with GROVE_AUTH_MODE=oidc. See docs/identity.md. */
const env = (name: string, minimum = 1): string => {
  const value = process.env[name];
  if (!value || value.length < minimum) throw new Error(`Set ${name}${minimum > 1 ? ` (at least ${minimum} characters)` : ''}. See docs/identity.md.`);
  return value;
};
if (process.env.GROVE_LOCAL_LOGIN === '1' || process.env.GROVE_DEV_TOKEN) throw new Error('The deployable host has no development token or practice roles. Remove GROVE_LOCAL_LOGIN and GROVE_DEV_TOKEN.');
const mode = process.env.GROVE_AUTH_MODE ?? 'password';
if (mode !== 'password' && mode !== 'oidc') throw new Error('GROVE_AUTH_MODE must be password or oidc.');
const requiredClaims = mode === 'oidc' ? parseRequiredClaims(process.env.GROVE_OIDC_REQUIRED_CLAIMS) : undefined;
const publicUrl = new URL(env('GROVE_PUBLIC_URL'));
if (publicUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(publicUrl.hostname)) throw new Error('GROVE_PUBLIC_URL must be an https origin; http is accepted only on loopback for local trials.');
if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username) throw new Error('GROVE_PUBLIC_URL must be a bare origin such as https://grove.example.org');
const scope: Scope = { tenantId: env('GROVE_TENANT'), siteId: env('GROVE_SITE'), environment: process.env.GROVE_ENVIRONMENT ?? 'production' };
const operatorToken = process.env.GROVE_OPERATOR_TOKEN;
if (operatorToken !== undefined && operatorToken.length < 32) throw new Error('GROVE_OPERATOR_TOKEN must be at least 32 characters. See docs/identity.md.');
if (process.env.GROVE_EMAIL_API_KEY) env('GROVE_EMAIL_SIGNING_SECRET', 32);

const db = createPostgresDatabase(env('DATABASE_URL'));
await migrate(db);
const storage = await hostStorage(scope);
const inScope = (requested: Scope) => requested.tenantId === scope.tenantId && requested.siteId === scope.siteId && requested.environment === scope.environment;
const authorize: Authorize = async (actor, requested, permission) => inScope(requested) && (actor.id === OPERATOR_ACTOR ? true : grove.members.authorize(actor, requested, permission));
const grove = new Grove(db, authorize, { storage });
const keys = new InstanceKeys(db);
const connections = connectionsFor(db, { keys, hostId: publicUrl.origin, authorize, onError: error => console.error(error) });
const admin = new GroveAdmin(db, authorize, moduleProvider({ modules: await loadAdminModules(scope), connections, onError: error => console.error(error) }));
const identity = { sessions: new SessionStore(db), members: grove.members, scope, publicUrl: publicUrl.origin, operatorToken, onError: (error: unknown) => console.error(error) };
const access: Access = mode === 'oidc'
  ? oidcAccess({ ...identity, requiredClaims, tenantClaim: process.env.GROVE_OIDC_TENANT_CLAIM || undefined, client: new OidcClient({
      issuer: env('GROVE_OIDC_ISSUER'), clientId: env('GROVE_OIDC_CLIENT_ID'), clientSecret: env('GROVE_OIDC_CLIENT_SECRET'),
      redirectUri: `${publicUrl.origin}/auth/callback`,
      scopes: (process.env.GROVE_OIDC_SCOPES ?? 'openid email profile').split(/\s+/).filter(Boolean),
    }) })
  : passwordAccess({ ...identity, accounts: new Accounts(db), authorize });
const email = emailApi({ grove, scope, authorize, authenticate: access.authenticate, storage, settings: {
  baseUrl: process.env.GROVE_EMAIL_API_URL, apiKey: process.env.GROVE_EMAIL_API_KEY,
  from: process.env.GROVE_EMAIL_FROM, fromName: process.env.GROVE_EMAIL_BRAND ?? 'Your organization',
  replyTo: process.env.GROVE_EMAIL_REPLY_TO, publicUrl: publicUrl.origin,
  signingSecret: process.env.GROVE_EMAIL_SIGNING_SECRET ?? operatorToken ?? env('DATABASE_URL'),
} });
const handler = createHandler(grove, { authenticate: access.authenticate, admin, connections, onError: error => console.error(error) });
listen({
  port: Number(process.env.PORT ?? 4310), bind: process.env.GROVE_BIND ?? '0.0.0.0', protocol: publicUrl.protocol === 'https:' ? 'https' : 'http',
  hosts: () => [publicUrl.host],
  route: compose({ access, email, clientSite: exampleApi(grove, scope, access.authenticate), handler, static: staticResponse, keys }),
  close: () => db.close(), label: `Grove (${mode} sign-in) for ${scope.tenantId}/${scope.siteId} at ${publicUrl.origin}`,
});
