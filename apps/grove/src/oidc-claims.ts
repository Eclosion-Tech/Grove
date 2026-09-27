/** Provider-neutral constraints for an identity directory independent of Grove content scope. */
export function parseRequiredClaims(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('GROVE_OIDC_REQUIRED_CLAIMS must be a JSON object of nonempty string values'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.entries(value).some(([path, expected]) => !path.split('.').every(part => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)) || typeof expected !== 'string' || !expected.trim())) {
    throw new Error('GROVE_OIDC_REQUIRED_CLAIMS must be a JSON object of nonempty string values');
  }
  return value as Record<string, string>;
}

export function matchesRequiredClaims(claims: Record<string, unknown>, required: Record<string, string>): boolean {
  return Object.entries(required).every(([path, expected]) => {
    let value: unknown = claims;
    for (const key of path.split('.')) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return false;
      value = (value as Record<string, unknown>)[key];
    }
    return value === expected;
  });
}
