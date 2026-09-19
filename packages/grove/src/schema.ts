/** Browser-safe schema definitions. Client repositories own and version these. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Content = Record<string, Json>;
export type Field = {
  name: string;
  label?: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'json' | 'reference' | 'image';
  /** Allowed collections for a reference field. */
  to?: string[];
  /** Ordered, unique selections instead of a single selection. */
  multiple?: boolean;
  required?: boolean;
  localized?: boolean;
  default?: Json;
};
export type ContentType = { name: string; label?: string; fields: Field[] };
export type Schema = {
  locales: string[];
  defaultLocale: string;
  types: ContentType[];
};
export type Scope = { tenantId: string; siteId: string; environment: string };
export type SchemaRecord = { version: number; definition: Schema };
export type Document = {
  id: string;
  type: string;
  revision: number;
  schemaVersion: number;
  draft: Content;
  published: Content | null;
  publishedRevision: number | null;
  publishedSchemaVersion: number | null;
  publishedAt: string | null;
  updatedAt: string;
  updatedBy: string;
};
export type HistoryEntry = {
  revision: number;
  schemaVersion: number;
  data: Content;
  action: 'create' | 'save' | 'publish' | 'unpublish' | 'restore' | 'migrate';
  actorId: string;
  createdAt: string;
};
export type DeliveredDocument = {
  id: string;
  type: string;
  revision: number;
  schemaVersion: number;
  data: Content;
};
export type SaveInput = {
  type: string;
  expectedRevision: number;
  expectedSchemaVersion: number;
  /** Top-level field patch. Omitted fields are preserved, null clears a field. */
  data: Content;
};
export const defineSchema = <const T extends Schema>(schema: T): T => schema;

export type RecordReference = { _type: 'reference'; _ref: string; _target: string };
export type AssetReference = { _type: 'asset'; _ref: string };
export const reference = (id: string, type: string): RecordReference => ({ _type: 'reference', _ref: id, _target: type });
export const assetReference = (id: string): AssetReference => ({ _type: 'asset', _ref: id });
export type Usage = { sourceId: string; sourceType: string; title: Json; path: string; channel: 'draft' | 'published' };
export type MediaAsset = {
  id: string; filename: string; mimeType: string; bytes: number; width: number; height: number;
  revision: number; alt: Record<string, string>; caption: Record<string, string>;
  focalPoint: { x: number; y: number }; archived: boolean; createdAt: string; updatedAt: string; updatedBy: string;
};
export type MediaPatch = { expectedRevision: number; alt?: Record<string, string>; caption?: Record<string, string>; focalPoint?: { x: number; y: number } };

export type MemberRole = 'owner' | 'developer' | 'publisher' | 'editor' | 'viewer';
/** A workspace member. `subject` is the identity provider's stable id, bound on first verified sign-in; until then the invitation is keyed by email. */
export type Member = {
  id: string; email: string; subject: string | null; role: MemberRole;
  /** Explicit application-module grants (admin:<module>:<capability>) beyond the role's CMS permissions. */
  permissions: string[];
  createdBy: string; createdAt: string; updatedAt: string; acceptedAt: string | null;
};
export type MemberInput = { email: string; role: MemberRole; permissions?: string[] };

export type * from './admin-schema.js';
