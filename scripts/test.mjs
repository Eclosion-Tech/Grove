import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${command} failed: ${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  return result;
};
let directory;
let started = false;
try {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    directory = await mkdtemp(join(tmpdir(), 'grove-test-'));
    const data = join(directory, 'data');
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'grove', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-F -h '' -k ${directory}`, '-w', 'start']);
    started = true;
    url = `postgres://grove@localhost/postgres?host=${encodeURIComponent(directory)}`;
  }
  const tests = (await readdir('tests')).filter(file => file.endsWith('.test.ts')).map(file => join('tests', file));
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url } });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  console.error('Tests need PostgreSQL binaries on PATH, or TEST_DATABASE_URL pointing to a dedicated test database.');
  process.exitCode = 1;
} finally {
  if (started) run('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  if (directory) await rm(directory, { recursive: true, force: true });
}
