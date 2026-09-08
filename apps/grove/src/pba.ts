import { readFile } from 'node:fs/promises';
import { GroveError, type AdminModule, type Context } from '@eclosion-tech/grove/server';
import type { AdminRecord, Scope } from '@eclosion-tech/grove';

export type PbaConnection = {
  origin: string;
  projectId: string;
  scope: Scope;
  /** Explicit local actor -> upstream human identity binding. Never a demo role. */
  actorId: string;
  staffUserId: string;
  classes: { id: string; label: string; sanityClassId: string }[];
};

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('PBA returned an invalid registration response.'); };
const denied = () => { throw new GroveError('forbidden', 'PBA requires the configured staff identity and workspace.'); };

export function parsePbaConnection(value: unknown): PbaConnection {
  const invalid = () => { throw new Error('Invalid PBA connection configuration. See docs/pba-connection.md.'); };
  if (!object(value) || Object.keys(value).some(k => !['origin', 'projectId', 'scope', 'actorId', 'staffUserId', 'classes'].includes(k))) return invalid();
  if (typeof value.origin !== 'string' || typeof value.projectId !== 'string' || !/^[a-z0-9]+$/.test(value.projectId)) return invalid();
  let origin: URL;
  try { origin = new URL(value.origin); } catch { return invalid(); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) return invalid();
  if (!object(value.scope) || Object.keys(value.scope).length !== 3 || !['tenantId', 'siteId', 'environment'].every(k => typeof value.scope === 'object' && identifier.test((value.scope as Record<string, string>)[k] ?? ''))) return invalid();
  if (typeof value.actorId !== 'string' || !identifier.test(value.actorId) || value.actorId.startsWith('demo-') || typeof value.staffUserId !== 'string' || !value.staffUserId.trim() || value.staffUserId.length > 200) return invalid();
  if (!Array.isArray(value.classes) || !value.classes.length || value.classes.length > 100) return invalid();
  const ids = new Set<string>(); const sources = new Set<string>();
  const classes = value.classes.map(item => {
    if (!object(item) || Object.keys(item).some(k => !['id', 'label', 'sanityClassId'].includes(k)) || typeof item.id !== 'string' || !identifier.test(item.id) || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 200 || typeof item.sanityClassId !== 'string') return invalid();
    const sanityClassId = item.sanityClassId.trim().replace(/^drafts\./, '');
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(sanityClassId) || sources.has(sanityClassId)) return invalid();
    ids.add(item.id); sources.add(sanityClassId);
    return { id: item.id, label: item.label.trim(), sanityClassId };
  });
  return { origin: origin.origin, projectId: value.projectId, scope: { ...value.scope } as Scope, actorId: value.actorId, staffUserId: value.staffUserId, classes };
}

/** No response bodies, credentials, or remote exception messages escape this boundary. */
async function getJson(fetcher: typeof fetch, url: string, token: string, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  try {
    const response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) return denied();
      throw new Error();
    }
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof GroveError) throw error;
    throw new Error('PBA could not be read. Check the connection and staff access.');
  }
}

function text(value: unknown, nullable = true): string | null {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || value.length > 2000) return fail();
  return value;
}
function date(value: unknown, nullable = true): string | null {
  const result = text(value, nullable);
  if (result !== null && !Number.isFinite(Date.parse(result))) return fail();
  return result;
}
function records(body: unknown): AdminRecord[] {
  if (!object(body) || !Array.isArray(body.registrations) || body.registrations.length > 10_000) return fail();
  const ids = new Set<string>();
  return body.registrations.map(row => {
    if (!object(row) || typeof row.id !== 'string' || !uuid.test(row.id) || ids.has(row.id) || !['pending', 'waitlisted', 'registered'].includes(String(row.status))) return fail();
    ids.add(row.id);
    if (row.amountPaidCents != null && (!Number.isSafeInteger(row.amountPaidCents) || (row.amountPaidCents as number) < 0)) return fail();
    // Deliberate allowlist: never retain intake answers, addresses, medical notes, or raw provider data.
    return { id: row.id, version: 0, values: {
      name: [text(row.firstName), text(row.lastName)].filter(Boolean).join(' ') || 'Unnamed registrant',
      status: row.status as string, email: text(row.email, false), phone: text(row.phone),
      createdAt: date(row.createdAt, false), paidAt: date(row.paidAt),
      amountPaidCents: row.amountPaidCents as number | null ?? null,
      fundingApprovedAt: date(row.fundingApprovedAt),
    } };
  }).sort((a, b) => String(a.values.createdAt).localeCompare(String(b.values.createdAt)) || a.id.localeCompare(b.id));
}

/** PBA owns every record. Its current API has no revision/idempotency contract: this adapter is read-only. */
export function pbaRegistrationsModule(input: PbaConnection, credential: () => string | Promise<string>, fetcher: typeof fetch = fetch): AdminModule {
  const config = parsePbaConnection(input);
  const allowed = (ctx: Context) => ctx.actor.id === config.actorId && ctx.scope.tenantId === config.scope.tenantId && ctx.scope.siteId === config.scope.siteId && ctx.scope.environment === config.scope.environment;
  async function roster(ctx: Context, sanityClassId: string) {
    if (!allowed(ctx)) return denied();
    let token: string;
    try { token = await credential(); } catch { return denied(); }
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) return denied();
    const signal = AbortSignal.timeout(10_000);
    // Verify the precise human, not just possession of a project-wide credential.
    // Project membership IDs differ from account-global IDs. Bind the canonical
    // human identity, then use the project-hosted ID for membership lookup.
    const user = await getJson(fetcher, `https://${config.projectId}.api.sanity.io/v2021-06-07/users/me`, token, 128_000, signal);
    if (!object(user) || typeof user.id !== 'string' || !user.id || user.sanityUserId !== config.staffUserId || user.isRobot) return denied();
    const project = await getJson(fetcher, `https://api.sanity.io/v2021-06-07/projects/${config.projectId}`, token, 1_000_000, signal);
    if (!object(project) || project.id !== config.projectId || !Array.isArray(project.members)) return denied();
    const member = project.members.find(m => object(m) && m.id === user.id);
    if (!object(member) || member.isRobot) return denied();
    const roles = object(member) ? [member.role, ...(Array.isArray(member.roles) ? member.roles.map(r => object(r) ? r.name : null) : [])] : [];
    if (!roles.some(role => ['administrator', 'editor', 'developer'].includes(String(role)))) return denied();
    const url = new URL('/api/internal/affinity-registrations', config.origin);
    url.searchParams.set('sanityClassId', sanityClassId);
    // The PBA endpoint independently rechecks staff access. No direct database access or service-token fallback.
    return records(await getJson(fetcher, url.href, token, 4_000_000, signal));
  }
  return {
    id: 'pba-registrations', label: 'PBA registrations', description: 'Live class rosters from PBA. Read-only.',
    resources: config.classes.map(classConfig => ({
      id: classConfig.id, label: classConfig.label, description: 'Current registrations from PBA. Changes and confirmations are managed in PBA.',
      permission: 'admin:pba-registrations:read',
      columns: [
        { name: 'name', label: 'Registrant', type: 'text', permission: 'admin:pba-registrations:personal' },
        { name: 'status', label: 'Status', type: 'status' },
        { name: 'createdAt', label: 'Registered on', type: 'text' },
        { name: 'email', label: 'Email', type: 'text', permission: 'admin:pba-registrations:personal' },
        { name: 'phone', label: 'Phone', type: 'text', permission: 'admin:pba-registrations:personal' },
        { name: 'paidAt', label: 'Payment received', type: 'text', permission: 'admin:pba-registrations:personal' },
        { name: 'amountPaidCents', label: 'Amount paid (cents)', type: 'number', permission: 'admin:pba-registrations:personal' },
        { name: 'fundingApprovedAt', label: 'Funding approved', type: 'text', permission: 'admin:pba-registrations:personal' },
      ],
      filters: [{ name: 'status', label: 'Status', type: 'string', options: ['pending', 'waitlisted', 'registered'].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) }],
      actions: [],
      source: {
        async query(ctx, { filters, cursor, limit }) {
          const rows = (await roster(ctx, classConfig.sanityClassId)).filter(row => !filters.status || row.values.status === filters.status);
          const index = cursor === null ? -1 : rows.findIndex(row => row.id === cursor);
          if (cursor !== null && index === -1) throw new GroveError('conflict', 'The roster changed. Reload its first page.');
          const page = rows.slice(index + 1, index + 1 + limit);
          return { records: page, nextCursor: index + 1 + page.length < rows.length ? page.at(-1)!.id : null };
        },
        async get(ctx, id) { return (await roster(ctx, classConfig.sanityClassId)).find(row => row.id === id) ?? null; },
        authorizeRecord: (ctx, _record, operation) => allowed(ctx) && operation === 'read',
      },
    })),
  };
}

/** Local host integration; deployments should resolve credentials from their own verified session/secret store. */
export async function loadPbaModule(scope: Scope, env: NodeJS.ProcessEnv = process.env): Promise<AdminModule[]> {
  if (!env.GROVE_PBA_CONFIG) return [];
  if (env.GROVE_LOCAL_LOGIN === '1') throw new Error('PBA connections require token login. Run npm run dev:pba with GROVE_DEV_TOKEN set.');
  const config = parsePbaConnection(JSON.parse(await readFile(env.GROVE_PBA_CONFIG, 'utf8')));
  if (config.actorId !== 'local-developer' || config.scope.tenantId !== scope.tenantId || config.scope.siteId !== scope.siteId || config.scope.environment !== scope.environment) throw new Error('PBA configuration must match this host scope and local-developer actor.');
  if (!env.GROVE_PBA_STAFF_TOKEN) throw new Error('Set GROVE_PBA_STAFF_TOKEN to the configured human staff identity credential.');
  return [pbaRegistrationsModule(config, () => env.GROVE_PBA_STAFF_TOKEN!)];
}
