import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequiredClaims, matchesRequiredClaims } from '../apps/grove/src/oidc-claims.js';

test('invalid claim constraints fail at configuration time', () => {
  assert.deepEqual(parseRequiredClaims(undefined), {});
  for (const raw of ['', 'null', '[]', '"scope"', '{', '{"org.id":42}', '{"org.id":""}', '{"org.id":" "}', '{"org..id":"x"}', '{"__proto__.id":"x"}']) {
    assert.throws(() => parseRequiredClaims(raw), /GROVE_OIDC_REQUIRED_CLAIMS/);
  }
});
test('constraints require own properties and exact string values', () => {
  const required = parseRequiredClaims('{"org.id":"42"}');
  assert.equal(matchesRequiredClaims({ org: { id: '42' } }, required), true);
  for (const claims of [{ org: { id: 42 } }, {}, { org: null }, { org: Object.create({ id: '42' }) }]) {
    assert.equal(matchesRequiredClaims(claims, required), false);
  }
});
