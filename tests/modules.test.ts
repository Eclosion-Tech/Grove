import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdminModules } from '../apps/grove/src/modules.js';

const scope = { tenantId: 'org', siteId: 'site', environment: 'production' };

test('host-configured admin modules load by absolute path, receive scope and env, and are validated', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'grove-modules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const good = join(directory, 'good.mjs');
  await writeFile(good, `export default ({ scope, env }) => [{ id: 'app-' + env.APP_SUFFIX, label: scope.siteId, description: '', resources: [] }];`);
  const modules = await loadAdminModules(scope, { GROVE_ADMIN_MODULES: ` ${good} `, APP_SUFFIX: 'one' });
  assert.equal(modules.length, 1); assert.equal(modules[0]!.id, 'app-one'); assert.equal(modules[0]!.label, 'site');
  assert.deepEqual(await loadAdminModules(scope, {}), []);
  const noDefault = join(directory, 'nodefault.mjs'); await writeFile(noDefault, `export const modules = [];`);
  await assert.rejects(loadAdminModules(scope, { GROVE_ADMIN_MODULES: noDefault }), /default function/);
  const notList = join(directory, 'notlist.mjs'); await writeFile(notList, `export default () => ({ id: 'x' });`);
  await assert.rejects(loadAdminModules(scope, { GROVE_ADMIN_MODULES: notList }), /module list/);
  const invalid = join(directory, 'invalid.mjs'); await writeFile(invalid, `export default () => [{ label: 'no id' }];`);
  await assert.rejects(loadAdminModules(scope, { GROVE_ADMIN_MODULES: invalid }), /invalid admin module/);
  await assert.rejects(loadAdminModules(scope, { GROVE_ADMIN_MODULES: `${good},${good}` }), /registered twice/);
  await assert.rejects(loadAdminModules(scope, { GROVE_ADMIN_MODULES: './relative.mjs' }), /absolute paths or package names/);
  await assert.rejects(loadAdminModules(scope, { GROVE_ADMIN_MODULES: '../../etc/passwd' }), /absolute paths or package names/);
});
