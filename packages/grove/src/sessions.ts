import { createHash, randomBytes } from 'node:crypto';
import type { Database, Row } from './database.js';
import type { Json } from './schema.js';
import { requireCondition } from './errors.js';

export type SessionKind = 'login' | 'session';
export type SessionRecord = { kind: SessionKind; subject: string | null; email: string | null; csrf: string | null; data: Record<string, Json>; expiresAt: string };
const MAX_TTL = 30 * 24 * 3600_000;
const hash = (id: string) => createHash('sha256').update(id).digest('hex');
const record = (r: Row): SessionRecord => ({ kind: r.kind, subject: r.subject, email: r.email, csrf: r.csrf, data: r.data, expiresAt: new Date(r.expires_at).toISOString() });
const valid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

/** Persistent host sessions. Only a hash of each opaque id is stored, so the table cannot be replayed if read. */
export class SessionStore {
  constructor(private db: Database) {}
  async create(kind: SessionKind, ttlMs: number, value: { subject?: string; email?: string; csrf?: string; data?: Record<string, Json> } = {}): Promise<string> {
    requireCondition(Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= MAX_TTL, 'Session lifetime must be between one millisecond and thirty days');
    const id = randomBytes(32).toString('hex');
    await this.db.query('INSERT INTO grove_sessions (id_hash,kind,subject,email,csrf,data,expires_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)',
      [hash(id), kind, value.subject ?? null, value.email ?? null, value.csrf ?? null, value.data ?? {}, new Date(Date.now() + ttlMs).toISOString()]);
    return id;
  }
  async read(kind: SessionKind, id: unknown): Promise<SessionRecord | null> {
    if (!valid(id)) return null;
    const [row] = await this.db.query('SELECT * FROM grove_sessions WHERE id_hash = $1 AND kind = $2 AND expires_at > $3::timestamptz', [hash(id), kind, new Date(Date.now()).toISOString()]);
    return row ? record(row) : null;
  }
  /** Reads and deletes in one statement so a login attempt or session can be used at most once. */
  async consume(kind: SessionKind, id: unknown): Promise<SessionRecord | null> {
    if (!valid(id)) return null;
    const [row] = await this.db.query('DELETE FROM grove_sessions WHERE id_hash = $1 AND kind = $2 AND expires_at > $3::timestamptz RETURNING *', [hash(id), kind, new Date(Date.now()).toISOString()]);
    return row ? record(row) : null;
  }
  async delete(id: unknown): Promise<void> {
    if (valid(id)) await this.db.query('DELETE FROM grove_sessions WHERE id_hash = $1', [hash(id)]);
  }
  async purge(): Promise<void> {
    await this.db.query('DELETE FROM grove_sessions WHERE expires_at <= $1::timestamptz', [new Date(Date.now()).toISOString()]);
  }
}
