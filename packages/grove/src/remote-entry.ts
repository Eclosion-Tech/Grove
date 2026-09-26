/**
 * Application-side entry: everything needed to serve an admin module to a Grove instance over the signed remote protocol,
 * without the CMS runtime. Import from '@eclosion-tech/grove/remote' in the application's own process.
 */
export { createRemoteModuleHandler, describe, MemoryLedger, type OperationLedger, type RemoteServerOptions } from './remote-server.js';
export { verifyRequest, signRequest, canonicalRequest, remoteKeyResolver, generateSigningKey, loadSigningKey, SignatureError, type PublicJwk, type SigningKey, type VerifyOptions } from './signing.js';
export { AdminActionRejected, isRejection, validateModules } from './admin.js';
export type { AdminModule, AdminResource, AdminAction, AdminPermission } from './admin.js';
export type { Actor, Context, Permission } from './service.js';
export { GroveError } from './errors.js';
export { inputHash } from './remote.js';
export * from './remote-schema.js';
