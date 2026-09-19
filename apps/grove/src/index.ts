import { emailApi } from './email.js';
import { Grove, GroveAdmin, createHandler, createPostgresDatabase, localStorage, s3Storage } from '@eclosion-tech/grove/server';
import { demoAdminModules } from './admin-demo.js';
import { browserAccess, staticResponse } from './browser.js';
import { exampleApi } from './example-api.js';
import { loadPbaModule } from './pba.js';
import { loadAdminModules } from './modules.js';
import { compose, listen } from './serve.js';

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.GROVE_DEV_TOKEN;
if (!databaseUrl || !token || token.length < 32) throw new Error('Set DATABASE_URL and a GROVE_DEV_TOKEN of at least 32 characters. See .env.example.');
if (process.env.NODE_ENV === 'production') throw new Error('This is the local development host. Production runs the Syntropy host: npm run host:syntropy (see docs/identity.md).');
const scope = {
  tenantId: process.env.GROVE_TENANT ?? 'local',
  siteId: process.env.GROVE_SITE ?? 'demo',
  environment: process.env.GROVE_ENVIRONMENT ?? 'development',
};
const pbaModules = await loadPbaModule(scope);
const db = createPostgresDatabase(databaseUrl);
const storage = process.env.GROVE_S3_BUCKET ? s3Storage(process.env.GROVE_S3_BUCKET, { region: process.env.AWS_REGION ?? 'auto', endpoint: process.env.GROVE_S3_ENDPOINT, forcePathStyle: true }) : localStorage(process.env.GROVE_MEDIA_DIRECTORY ?? '.grove/media');
const authorize: import('@eclosion-tech/grove/server').Authorize = (actor, requested, permission) => {
  if (requested.tenantId !== scope.tenantId || requested.siteId !== scope.siteId || requested.environment !== scope.environment) return false;
  if (actor.id === 'local-developer') return true;
  if (process.env.GROVE_LOCAL_LOGIN !== '1') return false;
  const grants: Record<string, string[]> = {
    'demo-coordinator': ['admin:registrations:read', 'admin:registrations:personal', 'admin:registrations:confirm'],
    'demo-reviewer': ['admin:curriculum:read', 'admin:curriculum:review'],
    'demo-observer': ['admin:registrations:read', 'admin:curriculum:read'],
  };
  return grants[actor.id]?.includes(permission) ?? false;
};
const grove = new Grove(db, authorize, { storage });
const admin = new GroveAdmin(db, authorize, [...(process.env.GROVE_LOCAL_LOGIN === '1' ? demoAdminModules(db, scope) : []), ...pbaModules, ...await loadAdminModules(scope)]);
const access = browserAccess(token, scope, process.env.GROVE_LOCAL_LOGIN === '1');
if (process.env.GROVE_LOCAL_LOGIN === '1' && process.env.GROVE_EMAIL_API_KEY) throw new Error('Use token login for connected email; demo roles cannot send real broadcasts.');
const email = emailApi({ grove, scope, authorize, authenticate: access.authenticate, storage, settings: {
  baseUrl: process.env.GROVE_EMAIL_API_URL, apiKey: process.env.GROVE_EMAIL_API_KEY,
  from: process.env.GROVE_EMAIL_FROM, fromName: process.env.GROVE_EMAIL_BRAND ?? 'Your organization',
  replyTo: process.env.GROVE_EMAIL_REPLY_TO, publicUrl: process.env.GROVE_PUBLIC_URL,
  signingSecret: process.env.GROVE_EMAIL_SIGNING_SECRET ?? token,
} });
const clientSite = exampleApi(grove, scope, access.authenticate);
const handler = createHandler(grove, { authenticate: access.authenticate, admin, onError: error => console.error(error) });
listen({
  port: Number(process.env.PORT ?? 4310), bind: '127.0.0.1', protocol: 'http',
  hosts: port => [`127.0.0.1:${port}`, `localhost:${port}`],
  route: compose({ access, email, clientSite, handler, static: staticResponse }),
  close: () => db.close(), label: 'Grove API',
});
