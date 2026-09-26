import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Database, Row } from './database.js';
import { REMOTE_PROTOCOL_VERSION, REMOTE_SIGNATURE_HEADER, REMOTE_VERSION_HEADER } from './remote-schema.js';

/** Ed25519 request signing: one keypair per Grove instance, public keys published at a well-known URL, no shared secrets. */
export type PublicJwk = { kid: string; kty: 'OKP'; crv: 'Ed25519'; x: string; use: 'sig' };
export type SigningKey = { kid: string; privateKey: KeyObject; publicJwk: PublicJwk };
export class SignatureError extends Error { override readonly name = 'SignatureError'; }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export function generateSigningKey(): { kid: string; privateKeyPem: string; publicJwk: PublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = createHash('sha256').update(jwk.x).digest('base64url').slice(0, 16);
  return { kid, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicJwk: { kid, kty: 'OKP', crv: 'Ed25519', x: jwk.x, use: 'sig' } };
}
export function loadSigningKey(kid: string, privateKeyPem: string): SigningKey {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Grove signing keys must be Ed25519');
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string };
  return { kid, privateKey, publicJwk: { kid, kty: 'OKP', crv: 'Ed25519', x: jwk.x, use: 'sig' } };
}
/** What is signed: protocol, method, path, body digest, timestamp and key id. The body carries the context, so it is bound too. */
export const canonicalRequest = (input: { method: string; path: string; body: string; timestamp: number; kid: string }) =>
  `grove-remote-v1\n${input.method.toUpperCase()}\n${input.path}\n${sha256(input.body)}\n${input.timestamp}\n${input.kid}`;
export function signRequest(key: SigningKey, input: { method: string; path: string; body: string; timestamp?: number }): Record<string, string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = sign(null, Buffer.from(canonicalRequest({ ...input, timestamp, kid: key.kid })), key.privateKey).toString('base64url');
  return { [REMOTE_SIGNATURE_HEADER]: `v1,kid=${key.kid},ts=${timestamp},sig=${signature}`, [REMOTE_VERSION_HEADER]: REMOTE_PROTOCOL_VERSION };
}
export type VerifyOptions = {
  method: string; path: string; body: string;
  headers: Headers | Record<string, string | undefined>;
  resolveKey: (kid: string) => PublicJwk | undefined | Promise<PublicJwk | undefined>;
  now?: () => number;
  /** Accepted clock skew, seconds. */
  skewSeconds?: number;
};
/** Verifies a signed request. Returns the key id that vouched for it; the caller decides whether that Grove instance is allowed. */
export async function verifyRequest(options: VerifyOptions): Promise<{ kid: string; timestamp: number }> {
  const header = (name: string) => options.headers instanceof Headers ? options.headers.get(name) : (options.headers[name] ?? options.headers[name.toLowerCase()]);
  const version = header(REMOTE_VERSION_HEADER) ?? '';
  if (version.split('.')[0] !== REMOTE_PROTOCOL_VERSION.split('.')[0]) throw new SignatureError('Unsupported protocol version');
  const raw = header(REMOTE_SIGNATURE_HEADER) ?? '';
  const parts = Object.fromEntries(raw.split(',').slice(1).map(part => { const i = part.indexOf('='); return i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)]; }));
  const kid = parts.kid ?? ''; const timestamp = Number(parts.ts); const signature = parts.sig ?? '';
  if (!raw.startsWith('v1,') || !/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !Number.isInteger(timestamp) || !/^[A-Za-z0-9_-]{80,100}$/.test(signature)) throw new SignatureError('Malformed signature');
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (Math.abs(now - timestamp) > (options.skewSeconds ?? 300)) throw new SignatureError('Signature timestamp out of range');
  const jwk = await options.resolveKey(kid);
  if (!jwk || jwk.kid !== kid || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new SignatureError('Unknown signing key');
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  const valid = verify(null, Buffer.from(canonicalRequest({ method: options.method, path: options.path, body: options.body, timestamp, kid })), publicKey, Buffer.from(signature, 'base64url'));
  if (!valid) throw new SignatureError('Signature does not match');
  return { kid, timestamp };
}

/** Instance keys persisted in Grove's database: generated on first use, rotated by retiring the current key. */
export class InstanceKeys {
  constructor(private db: Database) {}
  private static readonly LOCK = 718304;
  async current(): Promise<SigningKey> {
    const row = await this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1, 0)', [InstanceKeys.LOCK]);
      const [existing] = await tx.query('SELECT * FROM grove_instance_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1');
      if (existing) return existing as Row;
      const generated = generateSigningKey();
      const [created] = await tx.query('INSERT INTO grove_instance_keys (kid, private_key_pem, public_jwk) VALUES ($1, $2, $3::jsonb) RETURNING *', [generated.kid, generated.privateKeyPem, generated.publicJwk]);
      return created as Row;
    });
    return loadSigningKey(row.kid, row.private_key_pem);
  }
  /** Retires the current key and creates a new one. Retired keys stay published for a grace period so in-flight requests verify. */
  async rotate(): Promise<SigningKey> {
    await this.db.query('UPDATE grove_instance_keys SET retired_at = now() WHERE retired_at IS NULL');
    return this.current();
  }
  /** The well-known document: active keys plus keys retired within the last day. A fresh instance mints its first key here. */
  async published(): Promise<{ keys: PublicJwk[] }> {
    await this.current();
    const rows = await this.db.query("SELECT public_jwk FROM grove_instance_keys WHERE retired_at IS NULL OR retired_at > now() - interval '1 day' ORDER BY created_at DESC");
    return { keys: rows.map(r => r.public_jwk as PublicJwk) };
  }
}
