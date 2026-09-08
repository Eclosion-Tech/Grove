import type { Content } from './schema.js';

/** Serializable UI contracts. Adapters and authorization functions stay on the server. */
export type AdminInput = { name: string; label: string; type: 'string' | 'number' | 'boolean'; required?: boolean; options?: { label: string; value: string }[] };
export type AdminColumn = { name: string; label: string; type: 'text' | 'number' | 'boolean' | 'status' };
export type AdminActionInfo = { id: string; label: string; description: string; confirmation: string; inputs: AdminInput[] };
export type AdminResourceInfo = { id: string; label: string; description: string; columns: AdminColumn[]; filters: AdminInput[]; actions: AdminActionInfo[] };
export type AdminModuleInfo = { id: string; label: string; description: string; resources: AdminResourceInfo[] };
export type AdminRecord = { id: string; version: number; values: Content };
export type AdminRecordView = AdminRecord & { actions: string[] };
export type AdminPage = { records: AdminRecordView[]; nextCursor: string | null };
export type AdminActionRequest = { requestId: string; recordId: string; expectedVersion: number; values: Content };
export type AdminExecution = {
  id: string; module: string; resource: string; action: string; recordId: string;
  status: 'running' | 'succeeded' | 'uncertain' | 'rejected'; message: string;
  createdAt: string; completedAt: string | null;
};
