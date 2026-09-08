import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import postgres from 'postgres';
import { GroveAdmin, type Database } from '@eclosion-tech/grove/server';
import { pbaRegistrationsModule } from '../apps/grove/src/pba.js';

// Opt-in cross-repository contract test. Never reads PBA's .env or connects to its database.
test('PBA adapter reads the actual upstream GET, staff guard and PostgreSQL repository', { skip: !process.env.GROVE_PBA_REPO }, async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Run through scripts/test.mjs with a dedicated test cluster');
  const root = resolve(process.env.GROVE_PBA_REPO!);
  const lib = join(root, 'packages/web/src/lib');
  const clusterUrl = new URL(process.env.TEST_DATABASE_URL!);
  const host = clusterUrl.searchParams.get('host'); clusterUrl.searchParams.delete('host');
  const options = { max: 1, onnotice() {}, ...(host ? { host } : {}) };
  const cluster = postgres(clusterUrl.href, options);
  const databaseName = `grove_pba_test_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(clusterUrl); target.pathname = `/${databaseName}`;
  let sql: ReturnType<typeof postgres> | undefined; let directory: string | undefined; let created = false;
  const originalFetch = globalThis.fetch;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalProject = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
  const globals = globalThis as typeof globalThis & { __pbaDatabaseClient?: ReturnType<typeof postgres> };
  const originalClient = globals.__pbaDatabaseClient;
  try {
    await cluster.unsafe(`CREATE DATABASE ${databaseName}`); created = true;
    sql = postgres(target.href, options);
    for (const migration of ['20260326170000_affinity_classes_capacity.sql', '20260506120000_affinity_registrations_stripe.sql', '20260906130000_affinity_registration_details.sql']) {
      await sql.unsafe(await readFile(join(root, 'supabase/migrations', migration), 'utf8'));
    }
    const [classRow] = await sql`INSERT INTO public.affinity_classes (sanity_class_id, capacity) VALUES ('contract-class', 10) RETURNING id`;
    const [row] = await sql`INSERT INTO public.affinity_class_registrations (affinity_class_id, email, first_name, status, registration_details) VALUES (${classRow!.id}, 'fixture@example.test', 'Fixture', 'pending', ${sql.json({ answers: { medicalNotes: 'private upstream intake' } })}) RETURNING id`;
    await mkdir('.grove', { recursive: true, mode: 0o700 });
    directory = await mkdtemp(resolve('.grove/pba-contract-'));
    const bundle = join(directory, 'upstream.mjs');
    await build({
      stdin: { contents: `export { GET } from ${JSON.stringify(join(root, 'packages/web/src/app/api/internal/affinity-registrations/route.ts'))}`, resolveDir: root, loader: 'ts' },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'contract-boundaries', setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'next-response', namespace: 'contract' }));
        builder.onResolve({ filter: /^@\/lib\// }, args => {
          const name = args.path.slice('@/lib/'.length);
          if (['sanity.client', 'affinity-emails'].includes(name)) return { path: name, namespace: 'contract' };
          return { path: join(lib, name === 'repositories' ? 'repositories/affinity.repository.ts' : `${name}.ts`) };
        });
        builder.onLoad({ filter: /.*/, namespace: 'contract' }, args => ({ contents: args.path === 'next-response'
          ? 'export class NextResponse extends Response {}'
          : args.path === 'sanity.client'
            ? 'export function sanityFetch() { throw new Error("Unexpected content query in read-only contract test"); }'
            : 'export function sendAffinityRegistrationConfirmation() { throw new Error("Email is forbidden in this test"); }', loader: 'js' }));
      } }],
    });
    process.env.DATABASE_URL = target.href; process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = 'contractproject'; globals.__pbaDatabaseClient = sql;
    const upstream = await import(pathToFileURL(bundle).href) as { GET(request: Request): Promise<Response> };
    let staff = true; let pbaAllows = true; let rosterRequests = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.equal(init?.method ?? 'GET', 'GET', 'No write request may reach a provider');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-human');
      if (url === 'https://api.sanity.io/v2021-06-07/users/me') return Response.json({ id: 'human-fixture', sanityUserId: 'human-fixture', isRobot: false });
      if (url === 'https://contractproject.api.sanity.io/v2021-06-07/users/me') return Response.json({ id: 'project-member-fixture', sanityUserId: 'human-fixture' });
      if (url === 'https://api.sanity.io/v2021-06-07/projects/contractproject') return Response.json({ id: 'contractproject', members: staff ? [{ id: 'project-member-fixture', isRobot: false, role: 'editor' }] : [] });
      if (new URL(url).origin === 'https://pba-contract.example') {
        rosterRequests++;
        if (!pbaAllows) staff = false; // Revocation between Grove's preflight and PBA's own check.
        return upstream.GET(new Request(url, init));
      }
      throw new Error('Unexpected network destination');
    };
    const ctx = { actor: { id: 'local-developer' }, scope: { tenantId: 'test', siteId: 'pba', environment: 'contract' } };
    const module = pbaRegistrationsModule({ origin: 'https://pba-contract.example', projectId: 'contractproject', actorId: ctx.actor.id, staffUserId: 'human-fixture', scope: ctx.scope, classes: [{ id: 'class', label: 'Contract class', sanityClassId: 'drafts.contract-class' }] }, () => 'test-human', globalThis.fetch);
    const admin = new GroveAdmin({ query() { throw new Error('PBA data must not be copied to Grove'); } } as unknown as Database, () => true, [module]);
    const first = await admin.query(ctx, module.id, 'class');
    assert.equal(first.records[0]?.id, row!.id); assert.equal(first.records[0]?.values.status, 'pending');
    assert.ok(!JSON.stringify(first).includes('private upstream intake'));
    await sql`UPDATE public.affinity_class_registrations SET status='registered', funding_approved_at=now() WHERE id=${row!.id}`;
    assert.equal((await admin.get(ctx, module.id, 'class', row!.id)).values.status, 'registered');
    await sql`UPDATE public.affinity_class_registrations SET status='cancelled' WHERE id=${row!.id}`;
    assert.deepEqual((await admin.query(ctx, module.id, 'class')).records, []);
    pbaAllows = false;
    await assert.rejects(admin.query(ctx, module.id, 'class'), { code: 'forbidden' });
    assert.equal(rosterRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalProject === undefined) delete process.env.NEXT_PUBLIC_SANITY_PROJECT_ID; else process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = originalProject;
    if (originalClient === undefined) delete globals.__pbaDatabaseClient; else globals.__pbaDatabaseClient = originalClient;
    await sql?.end();
    if (created) await cluster.unsafe(`DROP DATABASE ${databaseName}`);
    await cluster.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
