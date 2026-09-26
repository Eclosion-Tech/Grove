import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Database, Row } from './database.js';
import { GroveError, requireCondition } from './errors.js';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
export type Account = { id: string; email: string; hasPassword: boolean; createdAt: string; lastSignInAt: string | null };
const account = (r: Row): Account => ({ id: r.id, email: r.email, hasPassword: r.password_hash !== null, createdAt: new Date(r.created_at).toISOString(), lastSignInAt: r.last_sign_in_at ? new Date(r.last_sign_in_at).toISOString() : null });
const address = (value: unknown): string => {
  requireCondition(typeof value === 'string' && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()), 'Provide a valid email address');
  return value.trim().toLowerCase();
};
export function passwordAcceptable(value: unknown): asserts value is string {
  requireCondition(typeof value === 'string' && value.length >= 12 && value.length <= 256, 'Use a password of 12 to 256 characters');
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
// Checked against when no account or password exists, so a failed sign-in costs about the same either way.
const decoy = hashPassword(randomBytes(24).toString('hex'));

/** Native accounts for standalone hosts: invitation links set the first password; no email delivery is required. */
export class Accounts {
  constructor(private db: Database) {}
  async get(id: string): Promise<Account | null> {
    if (typeof id !== 'string' || !id) return null;
    const [row] = await this.db.query('SELECT * FROM grove_accounts WHERE id = $1', [id]);
    return row ? account(row) : null;
  }
  /** Creates the account if needed and issues a fresh one-time invitation token, returned raw exactly once. Replaces any earlier token. */
  async invite(email: unknown, ttlMs = 7 * 24 * 3600_000): Promise<{ id: string; email: string; token: string; expiresAt: string }> {
    const value = address(email);
    requireCondition(Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 30 * 24 * 3600_000, 'Invitation lifetime must be between one millisecond and thirty days');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const [row] = await this.db.query(`INSERT INTO grove_accounts (id, email, invitation_hash, invitation_expires_at) VALUES ($1, $2, $3, $4::timestamptz)
      ON CONFLICT (email) DO UPDATE SET invitation_hash = EXCLUDED.invitation_hash, invitation_expires_at = EXCLUDED.invitation_expires_at, updated_at = now() RETURNING *`,
      [randomUUID(), value, digest(token), expiresAt]);
    return { id: row!.id, email: row!.email, token, expiresAt };
  }
  /** Sets the password for the invited account and consumes the invitation in one statement. */
  async accept(token: unknown, password: unknown): Promise<Account> {
    requireCondition(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'This invitation link is not valid');
    passwordAcceptable(password);
    const stored = await hashPassword(password);
    const [row] = await this.db.query('UPDATE grove_accounts SET password_hash = $2, invitation_hash = NULL, invitation_expires_at = NULL, updated_at = now() WHERE invitation_hash = $1 AND invitation_expires_at > $3::timestamptz RETURNING *',
      [digest(token), stored, new Date(Date.now()).toISOString()]);
    if (!row) throw new GroveError('not_found', 'This invitation link has expired or was already used. Ask a workspace owner for a new one.');
    return account(row);
  }
  /** Null for an unknown email, an account without a password, or a wrong password; the work done is similar in every case. */
  async verify(email: unknown, password: unknown): Promise<Account | null> {
    if (typeof password !== 'string' || password.length > 256) return null;
    let value: string;
    try { value = address(email); } catch { return null; }
    const [row] = await this.db.query('SELECT * FROM grove_accounts WHERE email = $1', [value]);
    const matched = await verifyPassword(password, row?.password_hash ?? await decoy);
    if (!row || !row.password_hash || !matched) return null;
    await this.db.query('UPDATE grove_accounts SET last_sign_in_at = now() WHERE id = $1', [row.id]);
    return account(row);
  }
  async changePassword(id: string, current: unknown, next: unknown): Promise<void> {
    passwordAcceptable(next);
    const [row] = await this.db.query('SELECT * FROM grove_accounts WHERE id = $1', [id]);
    if (!row?.password_hash || typeof current !== 'string' || !await verifyPassword(current, row.password_hash)) throw new GroveError('forbidden', 'Your current password did not match');
    await this.db.query('UPDATE grove_accounts SET password_hash = $2, updated_at = now() WHERE id = $1', [id, await hashPassword(next)]);
  }
}
