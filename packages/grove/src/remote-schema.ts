import type { AdminActionInfo, AdminColumn, AdminInput, AdminRecord } from './admin-schema.js';
import type { Content, Scope } from './schema.js';

/** Remote admin module protocol, version 1: Grove transports data and decisions to and from an application, never functions. */
export const REMOTE_PROTOCOL_VERSION = '1.0';
export const REMOTE_VERSION_HEADER = 'grove-admin-version';
export const REMOTE_SIGNATURE_HEADER = 'grove-signature';

/** Who is asking, on whose behalf, and for which workspace. Grove derives this from its own session and membership. */
export type RemoteContext = { hostId: string; connectionId: string; scope: Scope; actor: { id: string; permissions: string[] } };
export type RemoteCatalogRequest = { context: Pick<RemoteContext, 'hostId' | 'connectionId'> };
export type RemoteResource = { id: string; label: string; description: string; permission: string; columns: (AdminColumn & { permission?: string })[]; filters: AdminInput[]; actions: (AdminActionInfo & { permission: string })[] };
export type RemoteDescriptor = { id: string; label: string; description: string; resources: RemoteResource[] };
export type RemoteCatalog = { catalogRevision: string; module: RemoteDescriptor };
/** Authorization and business-state decisions travel with each record, so Grove never makes one request per predicate. */
export type RemoteAccess = { read: boolean; actions: Record<string, { authorized: boolean; available: boolean }> };
export type RemoteRecord = AdminRecord & { access: RemoteAccess };
export type RemoteQuery = { context: RemoteContext; catalogRevision: string; filters: Content; cursor: string | null; limit: number };
export type RemotePage = { catalogRevision: string; records: RemoteRecord[]; nextCursor: string | null };
export type RemoteGet = { context: RemoteContext; catalogRevision: string };
export type RemoteAction = { context: RemoteContext; catalogRevision: string; operationId: string; inputHash: string; recordId: string; expectedVersion: number; values: Content };
export type RemoteStatus = { context: RemoteContext; operationId: string; inputHash: string };
export type RemoteOutcomeStatus = 'succeeded' | 'rejected' | 'running' | 'unknown';
/** Only `rejected` with `noEffectsCommitted: true` may release a target; anything else Grove cannot verify stays uncertain. */
export type RemoteOutcome = { operationId: string; inputHash: string; status: RemoteOutcomeStatus; noEffectsCommitted?: boolean; error?: { code: string; message: string } };
export type RemoteError = { error: { code: string; message: string } };
