import { mkdir, access, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// A dedicated, persistent local database. Never connects to or reconfigures another cluster.
const directory = resolve('.grove');
const data = join(directory, 'postgres');
const run = (cmd, args, env) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', env: env ?? process.env });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr + result.stdout);
  if (cmd === process.execPath) process.stdout.write(result.stdout);
};
let ownsDatabase = false;
try {
  const pba = process.argv.includes('--pba');
  if (pba && (!process.env.GROVE_PBA_CONFIG || !process.env.GROVE_PBA_STAFF_TOKEN || (process.env.GROVE_DEV_TOKEN?.length ?? 0) < 32)) throw new Error('PBA mode requires GROVE_PBA_CONFIG, GROVE_PBA_STAFF_TOKEN, and GROVE_DEV_TOKEN (at least 32 characters). See docs/pba-connection.md.');
  if (!pba && process.env.GROVE_PBA_CONFIG) throw new Error('Use npm run dev:pba for a real PBA connection; demo login cannot access PBA.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try { await access(join(data, 'PG_VERSION')); } catch {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'grove', '--no-locale', '--encoding=UTF8']);
  }
  const status = spawnSync('pg_ctl', ['-D', data, 'status']);
  if (status.status !== 0) {
    const quotedDirectory = "'" + directory.replaceAll("'", "'\\''") + "'";
    run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-h '' -k ${quotedDirectory}`, '-w', 'start']);
    ownsDatabase = true;
  }
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: `postgres://grove@localhost/postgres?host=${encodeURIComponent(directory)}`, GROVE_DEV_TOKEN: pba ? process.env.GROVE_DEV_TOKEN : randomBytes(32).toString('hex'), GROVE_LOCAL_LOGIN: pba ? '0' : '1', GROVE_TENANT: 'local', GROVE_SITE: 'fieldnotes', GROVE_ENVIRONMENT: 'development', PORT: process.env.PORT ?? '4310' };
  run(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], env);
  const child = spawn(process.execPath, ['apps/grove/dist/index.js'], { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  process.exitCode = await new Promise(resolve => { child.once('exit', code => resolve(code ?? 0)); child.once('error', error => { console.error(error.message); resolve(1); }); });
} catch (error) {
  console.error(error.message); console.error('Local mode needs initdb and pg_ctl on PATH. Alternatively, use the Docker/.env setup in README.md.');
  process.exitCode = 1;
} finally {
  if (ownsDatabase) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
}
