import type { Content, ContentType, Field, Json, Schema, Scope } from './schema.js';
import { requireCondition } from './errors.js';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** JSONB canonicalizes object key order; compare structure rather than insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function allowedKeys(value: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(value)) requireCondition(keys.includes(key), `Unsupported schema option: ${key}`);
  if ('label' in value) requireCondition(typeof value.label === 'string', 'label must be a string');
}
export function identifier(value: unknown, label = 'Identifier'): asserts value is string {
  requireCondition(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value), `${label} must be 1–100 letters, numbers, underscores or hyphens`);
}
export function scopeValid(scope: Scope): void {
  requireCondition(object(scope), 'Scope is required');
  for (const key of ['tenantId', 'siteId', 'environment'] as const) identifier(scope[key], key);
}
export function revision(value: unknown, name = 'expectedRevision'): asserts value is number {
  requireCondition(Number.isSafeInteger(value) && (value as number) >= 0, `${name} must be a non-negative integer`);
}
function jsonValid(value: unknown, depth = 0): value is Json {
  if (depth > 30) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => jsonValid(v, depth + 1));
  return object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.entries(value).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && jsonValid(v, depth + 1));
}
export function contentValid(value: unknown): asserts value is Content {
  requireCondition(object(value) && jsonValid(value), 'Content must be a JSON object (maximum depth 30)');
  requireCondition(JSON.stringify(value).length <= 500_000, 'Content exceeds 500,000 characters');
}
export function schemaValid(value: unknown): asserts value is Schema {
  requireCondition(object(value), 'Schema must be an object');
  requireCondition(jsonValid(value), 'Schema must contain only JSON values (maximum depth 30)');
  allowedKeys(value, ['locales', 'defaultLocale', 'types']);
  requireCondition(Array.isArray(value.locales) && value.locales.length > 0 && value.locales.length <= 100, 'Provide 1–100 locales');
  const locales = value.locales;
  requireCondition(locales.every(l => typeof l === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(l)), 'Use locale identifiers such as en or en-US');
  requireCondition(new Set(locales).size === locales.length && typeof value.defaultLocale === 'string' && locales.includes(value.defaultLocale), 'Locales must be unique and include defaultLocale');
  requireCondition(Array.isArray(value.types) && value.types.length > 0 && value.types.length <= 200, 'Provide 1–200 content types');
  const names = new Set();
  for (const type of value.types) {
    requireCondition(object(type), 'Invalid content type');
    allowedKeys(type, ['name', 'label', 'fields']);
    identifier(type.name, 'Type name');
    requireCondition(!names.has(type.name), `Duplicate type ${type.name}`);
    names.add(type.name);
    requireCondition(Array.isArray(type.fields) && type.fields.length <= 200, 'A type may have up to 200 fields');
    const fields = new Set();
    for (const field of type.fields) {
      requireCondition(object(field), 'Invalid field');
      requireCondition(field.owner === undefined, 'Operational fields must remain in their owning service');
      allowedKeys(field, ['name', 'label', 'type', 'required', 'localized', 'default', 'to', 'multiple']);
      identifier(field.name, 'Field name');
      requireCondition(!['__proto__', 'constructor', 'prototype'].includes(field.name), 'Reserved field name');
      requireCondition(!fields.has(field.name), `Duplicate field ${field.name}`);
      fields.add(field.name);
      requireCondition(['string', 'text', 'number', 'boolean', 'json', 'reference', 'image'].includes(field.type as string), `Unsupported field type: ${field.type}`);
      if (field.type === 'reference') {
        requireCondition(Array.isArray(field.to) && field.to.length > 0 && new Set(field.to).size === field.to.length, 'Reference fields need unique allowed collections in to');
        for (const target of field.to) requireCondition(value.types.some(t => object(t) && t.name === target), `Unknown reference collection ${target}`);
      } else requireCondition(field.to === undefined, 'to is only supported for references');
      requireCondition(field.multiple === undefined || (['reference', 'image'].includes(field.type as string) && typeof field.multiple === 'boolean'), 'multiple is only supported for reference and image fields');
      requireCondition(field.required === undefined || typeof field.required === 'boolean', 'required must be boolean');
      requireCondition(field.localized === undefined || typeof field.localized === 'boolean', 'localized must be boolean');
      if (field.default !== undefined) {
        requireCondition(jsonValid(field.default), 'Defaults must be JSON');
        validateField(field as Field, field.default as Json, value as Schema, false);
      }
    }
  }
  requireCondition(JSON.stringify(value).length <= 500_000, 'Schema exceeds 500,000 characters');
}
function validateScalar(field: Field, value: Json): void {
  if (value === null) return;
  if (field.type === 'reference' || field.type === 'image') {
    const values = field.multiple ? value : [value];
    requireCondition(Array.isArray(values) && values.length <= 100, `${field.name} must contain at most 100 selections`);
    const ids = new Set();
    for (const item of values) {
      requireCondition(object(item) && item._type === (field.type === 'reference' ? 'reference' : 'asset'), `${field.name} must contain typed ${field.type} selections`);
      identifier(item._ref, 'Referenced id');
      requireCondition(!ids.has(item._ref), `${field.name} has a duplicate selection`); ids.add(item._ref);
      if (field.type === 'reference') requireCondition(typeof item._target === 'string' && field.to?.includes(item._target), `${field.name} must reference ${field.to?.join(' or ')}`);
    }
    return;
  }
  const expected = field.type === 'text' ? 'string' : field.type;
  requireCondition(expected === 'json' || typeof value === expected, `${field.name} must be ${expected}`);
}
function validateField(field: Field, value: Json | undefined, schema: Schema, publishing: boolean): void {
  const missing = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  if (publishing && field.required) {
    requireCondition(!missing(value), `${field.name} is required to publish`);
    if (field.localized) requireCondition(object(value) && !missing(value[schema.defaultLocale]), `${field.name}.${schema.defaultLocale} is required to publish`);
  }
  if (value === undefined || value === null) return;
  if (!field.localized) return validateScalar(field, value);
  requireCondition(object(value), `${field.name} must be a locale map`);
  for (const [locale, localized] of Object.entries(value)) {
    requireCondition(schema.locales.includes(locale), `Unknown locale ${locale}`);
    validateScalar(field, localized as Json);
  }
}
export function validateContent(type: ContentType, data: Content, schema: Schema, publishing: boolean): void {
  contentValid(data);
  for (const field of type.fields) validateField(field, data[field.name], schema, publishing);
}
export function projectContent(type: ContentType, data: Content): Content {
  return Object.fromEntries(type.fields.filter(f => data[f.name] !== undefined).map(f => [f.name, data[f.name]!])) as Content;
}
export function schemaDiff(previous: Schema | null, next: Schema): { path: string; change: 'added' | 'removed' | 'changed'; breaking: boolean }[] {
  const before = new Map((previous?.types ?? []).map(t => [t.name, t]));
  const after = new Map(next.types.map(t => [t.name, t]));
  const changes: ReturnType<typeof schemaDiff> = [];
  if (previous && canonical([previous.locales, previous.defaultLocale]) !== canonical([next.locales, next.defaultLocale])) {
    changes.push({ path: 'locales', change: 'changed', breaking: true });
  }
  for (const [name, type] of after) {
    const old = before.get(name);
    if (!old) { changes.push({ path: name, change: 'added', breaking: false }); continue; }
    if (old.label !== type.label || canonical(old.fields.map(f => f.name)) !== canonical(type.fields.map(f => f.name))) {
      changes.push({ path: name, change: 'changed', breaking: false });
    }
    for (const field of type.fields) {
      const prev = old.fields.find(f => f.name === field.name);
      if (!prev) changes.push({ path: `${name}.${field.name}`, change: 'added', breaking: !!field.required });
      else if (canonical(prev) !== canonical(field)) changes.push({ path: `${name}.${field.name}`, change: 'changed', breaking: prev.type !== field.type || !!prev.localized !== !!field.localized || !!prev.multiple !== !!field.multiple || canonical(prev.to) !== canonical(field.to) || (!prev.required && !!field.required) });
    }
    for (const field of old.fields) if (!type.fields.some(f => f.name === field.name)) changes.push({ path: `${name}.${field.name}`, change: 'removed', breaking: true });
  }
  for (const name of before.keys()) if (!after.has(name)) changes.push({ path: name, change: 'removed', breaking: true });
  return changes;
}
