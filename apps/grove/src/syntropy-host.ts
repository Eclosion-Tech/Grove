import { SyntropyAuthClient } from '@eclosion-tech/syntropy-auth';
import { Grove, GroveAdmin, SessionStore, createHandler, createPostgresDatabase, localStorage, migrate, s3Storage, type Authorize } from '@eclosion-tech/grove/server';
import type { Scope } from '@eclosion-tech/grove';
import { emailApi } from './email.js';
import { staticResponse } from './browser.js';
import { exampleApi } from './example-api.js';
import { compose, listen } from './serve.js';
import { loadAdminModules } from './modules.js';
import { OPERATOR_ACTOR, syntropyAccess } from './syntropy.js';

/** Deployed Grove host: Syntropy Auth identity, Grove-owned membership, one organization per deployment. See docs/identity.md. */
const env = (name: string, minimum = 1): string => {
  const value = process.env[name];
  if (!value || value.length < minimum) throw new Error(`Set ${name}${minimum > 1 ? ` (at least ${minimum} characters)` : ''}. See docs/identity.md.`);
  return value;
};
if (process.env.GROVE_LOCAL_LOGIN === '1' || process.env.GROVE_DEV_TOKEN) throw new Error('The Syntropy host has no development token or practice roles. Remove GROVE_LOCAL_LOGIN and GROVE_DEV_TOKEN.');
if (process.env.GROVE_PBA_CONFIG) throw new Error('The PBA connection binds to the local developer actor and is not available on the Syntropy host yet.');
const publicUrl = new URL(env('GROVE_PUBLIC_URL'));
if (publicUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(publicUrl.hostname)) throw new Error('GROVE_PUBLIC_URL must be an https origin; http is accepted only on loopback for local trials.');
if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username) throw new Error('GROVE_PUBLIC_URL must be a bare origin such as https://grove.example.org');
const scope: Scope = { tenantId: env('GROVE_TENANT'), siteId: env('GROVE_SITE'), environment: process.env.GROVE_ENVIRONMENT ?? 'production' };
const operatorToken = process.env.GROVE_OPERATOR_TOKEN;
if (operatorToken !== undefined && operatorToken.length < 32) throw new Error('GROVE_OPERATOR_TOKEN must be at least 32 characters. See docs/identity.md.');
if (process.env.GROVE_EMAIL_API_KEY) env('GROVE_EMAIL_SIGNING_SECRET', 32);
const clientId = env('SYNTROPY_AUTH_CLIENT_ID');
const auth = new SyntropyAuthClient({
  baseUrl: env('SYNTROPY_AUTH_URL'), clientId, clientSecret: env('SYNTROPY_AUTH_CLIENT_SECRET'),
  redirectUri: `${publicUrl.origin}/auth/callback`,
  // Grove never acts on the user's behalf against Syntropy, so no refresh token is requested.
  scopes: ['openid', 'email', 'profile', 'org'],
});

const db = createPostgresDatabase(env('DATABASE_URL'));
await migrate(db);
const storage = process.env.GROVE_S3_BUCKET ? s3Storage(process.env.GROVE_S3_BUCKET, { region: process.env.AWS_REGION ?? 'auto', endpoint: process.env.GROVE_S3_ENDPOINT, forcePathStyle: true }) : localStorage(process.env.GROVE_MEDIA_DIRECTORY ?? '.grove/media');
const inScope = (requested: Scope) => requested.tenantId === scope.tenantId && requested.siteId === scope.siteId && requested.environment === scope.environment;
const authorize: Authorize = async (actor, requested, permission) => inScope(requested) && (actor.id === OPERATOR_ACTOR ? true : grove.members.authorize(actor, requested, permission));
const grove = new Grove(db, authorize, { storage });
const admin = new GroveAdmin(db, authorize, await loadAdminModules(scope));
const access = syntropyAccess({ auth, clientId, sessions: new SessionStore(db), members: grove.members, scope, publicUrl: publicUrl.origin, operatorToken, onError: error => console.error(error) });
const email = emailApi({ grove, scope, authorize, authenticate: access.authenticate, storage, settings: {
  baseUrl: process.env.GROVE_EMAIL_API_URL, apiKey: process.env.GROVE_EMAIL_API_KEY,
  from: process.env.GROVE_EMAIL_FROM, fromName: process.env.GROVE_EMAIL_BRAND ?? 'Your organization',
  replyTo: process.env.GROVE_EMAIL_REPLY_TO, publicUrl: publicUrl.origin,
  signingSecret: process.env.GROVE_EMAIL_SIGNING_SECRET ?? operatorToken ?? env('SYNTROPY_AUTH_CLIENT_SECRET'),
} });
const handler = createHandler(grove, { authenticate: access.authenticate, admin, onError: error => console.error(error) });
listen({
  port: Number(process.env.PORT ?? 4310), bind: process.env.GROVE_BIND ?? '0.0.0.0', protocol: publicUrl.protocol === 'https:' ? 'https' : 'http',
  hosts: () => [publicUrl.host],
  route: compose({ access, email, clientSite: exampleApi(grove, scope, access.authenticate), handler, static: staticResponse }),
  close: () => db.close(), label: `Grove for ${scope.tenantId}/${scope.siteId} (${publicUrl.origin})`,
});
