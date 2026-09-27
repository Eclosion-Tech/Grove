import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostStorage } from '../apps/grove/src/storage.js';
const scope = { tenantId: 'tenant', siteId: 'site', environment: 'production' };
test('uses a trusted local storage factory and supplies workspace scope', async () => {
  const adapter = { put: async () => {}, get: async () => new Uint8Array(), remove: async () => {} };
  const result = await hostStorage(scope, { GROVE_STORAGE_MODULE: '/app/storage.mjs' }, async path => {
    assert.equal(path, 'file:///app/storage.mjs');
    return { default: async (options: unknown) => { assert.deepEqual(options, { scope }); return adapter; } };
  });
  assert.equal(result, adapter);
});
test('invalid storage modules fail closed instead of using ephemeral local storage', async () => {
  for (const path of ['', './relative.mjs', 'https://example.org/storage.mjs']) await assert.rejects(hostStorage(scope, { GROVE_STORAGE_MODULE: path }), /absolute local path/);
  await assert.rejects(hostStorage(scope, { GROVE_STORAGE_MODULE: '/app/storage.mjs' }, async () => ({})), /default adapter factory/);
  await assert.rejects(hostStorage(scope, { GROVE_STORAGE_MODULE: '/app/storage.mjs' }, async () => ({ default: () => ({}) })), /implement put, get and remove/);
  await assert.rejects(hostStorage(scope, { GROVE_STORAGE_MODULE: '/app/storage.mjs' }, async () => { throw new Error('unavailable'); }), /unavailable/);
});
