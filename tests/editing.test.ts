import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditingSession } from '../packages/grove/src/editing.js';
import { GroveClientError } from '../packages/grove/src/client.js';
import type { Document, SchemaRecord, SaveInput } from '../packages/grove/src/schema.js';
import { validateLayout, readPage } from '../apps/example-site/src/manifest.js';

const registry: SchemaRecord = { version: 1, definition: { defaultLocale: 'en', locales: ['en', 'es'], types: [{ name: 'article', fields: [{ name: 'title', type: 'string' }, { name: 'body', type: 'text' }] }] } };
const base = (): Document => ({ id: 'one', type: 'article', revision: 1, schemaVersion: 1, draft: { title: 'Original', body: 'Unchanged' }, published: null, publishedRevision: null, publishedSchemaVersion: null, publishedAt: null, updatedAt: new Date().toISOString(), updatedBy: 'editor' });
function fixture() {
  let doc = base(); const saved: SaveInput[] = []; const operations: string[] = [];
  const client = {
    async saveDocument(_id: string, input: SaveInput) {
      if (input.expectedRevision !== doc.revision) throw new GroveClientError(409, 'conflict', 'Document changed');
      saved.push(input); operations.push('save');
      doc = { ...doc, draft: { ...doc.draft, ...input.data }, revision: doc.revision + 1 };
      return structuredClone(doc);
    },
    async getDocument() { return structuredClone(doc); },
    async getSchema() { return registry; },
    async publish(_id: string, revision: number) {
      assert.equal(revision, doc.revision); operations.push('publish');
      doc = { ...doc, revision: doc.revision + 1, published: structuredClone(doc.draft), publishedRevision: doc.revision + 1 };
      return structuredClone(doc);
    },
    async unpublish() { operations.push('unpublish'); return doc; },
    async restore(_id: string, _target: number, revision: number) { assert.equal(revision, doc.revision); operations.push('restore'); doc = { ...doc, revision: doc.revision + 1, draft: base().draft }; return doc; },
  };
  return { client, saved, operations, remote: (data: Document['draft']) => { doc = { ...doc, revision: doc.revision + 1, draft: { ...doc.draft, ...data } }; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test('a quiet burst of edits autosaves once without a publish action', async t => {
  const f = fixture(); const saved = deferred<void>(); const original = f.client.saveDocument;
  f.client.saveDocument = async (id, input) => { const result = await original(id, input); saved.resolve(); return result; };
  const session = new EditingSession(f.client, base(), registry, 10); t.after(() => session.stop());
  session.setField('title', 'One'); session.setField('title', 'Two'); session.setField('title', 'Final');
  await saved.promise; await session.flush();
  assert.deepEqual(f.operations, ['save']); assert.equal(f.saved[0]?.data.title, 'Final');
});

test('typing during a save is preserved and the next write uses the returned revision', async t => {
  const f = fixture(); const gate = deferred<void>(); const original = f.client.saveDocument;
  let calls = 0;
  f.client.saveDocument = async (id, input) => { if (calls++ === 0) await gate.promise; return original(id, input); };
  const session = new EditingSession(f.client, base(), registry, 60_000); t.after(() => session.stop());
  session.setField('title', 'First edit'); const pending = session.save();
  session.setField('title', 'Still typing'); gate.resolve(); await pending;
  assert.equal(session.getSnapshot().data.title, 'Still typing');
  assert.equal(session.getSnapshot().document.draft.title, 'First edit');
  await session.flush();
  assert.deepEqual(f.saved.map(s => s.expectedRevision), [1, 2]);
  assert.equal(session.getSnapshot().document.draft.title, 'Still typing');
  assert.equal(session.dirty, false);
});

test('publish waits for an in-flight save and all newer edits', async t => {
  const f = fixture(); const gate = deferred<void>(); const original = f.client.saveDocument; let calls = 0;
  f.client.saveDocument = async (id, input) => { if (calls++ === 0) await gate.promise; return original(id, input); };
  const session = new EditingSession(f.client, base(), registry, 60_000); t.after(() => session.stop());
  session.setField('title', 'First'); const pending = session.save(); session.setField('body', 'Second');
  const publication = session.action('publish'); gate.resolve(); await pending; await publication;
  assert.deepEqual(f.operations, ['save', 'save', 'publish']);
  assert.equal(session.getSnapshot().document.published?.body, 'Second');
});

test('invalid JSON state blocks save, navigation flush, and publication', async t => {
  const f = fixture(); const session = new EditingSession(f.client, base(), registry, 60_000); t.after(() => session.stop());
  session.setField('title', 'Draft'); session.setInvalid('body', true);
  assert.equal(await session.flush(), null); assert.equal(await session.action('publish'), null);
  assert.deepEqual(f.operations, []); assert.equal(session.unsettled, true);
  session.setInvalid('body', false); await session.action('publish');
  assert.deepEqual(f.operations, ['save', 'publish']);
});

test('conflict keeps local edits; explicit recovery retains remote changes in untouched fields', async t => {
  const f = fixture(); const session = new EditingSession(f.client, base(), registry, 60_000); t.after(() => session.stop());
  session.setField('title', 'Mine'); f.remote({ body: 'Theirs' });
  assert.equal(await session.flush(), null); assert.equal(session.getSnapshot().status, 'conflict');
  assert.equal(session.getSnapshot().data.title, 'Mine'); assert.equal(await session.action('publish'), null);
  const latest = await session.latest(); assert.equal(session.getSnapshot().data.body, 'Unchanged');
  session.recover(latest, true); assert.equal(session.getSnapshot().data.body, 'Theirs');
  assert.equal(f.saved.length, 0); await session.flush();
  assert.equal(f.saved[0]?.expectedRevision, 2); assert.equal(f.saved[0]?.data.title, 'Mine');
});

test('restore first saves the current draft so both versions remain recoverable', async t => {
  const f = fixture(); const session = new EditingSession(f.client, base(), registry, 60_000); t.after(() => session.stop());
  session.setField('title', 'Keep a copy of this'); await session.action('restore', 1);
  assert.deepEqual(f.operations, ['save', 'restore']); assert.equal(f.saved[0]?.data.title, 'Keep a copy of this');
});

test('failed saves retain local data and allow an explicit retry', async t => {
  const f = fixture(); const original = f.client.saveDocument; let failed = false;
  f.client.saveDocument = async (id, input) => { if (!failed) { failed = true; throw new Error('Network unavailable'); } return original(id, input); };
  const session = new EditingSession(f.client, base(), registry, 60_000); t.after(() => session.stop());
  session.setField('title', 'Do not lose me'); assert.equal(await session.save(), null);
  assert.equal(session.getSnapshot().status, 'error'); assert.equal(session.getSnapshot().data.title, 'Do not lose me');
  await session.flush(); assert.equal(session.getSnapshot().document.draft.title, 'Do not lose me');
});

test('Puck manifest accepts HTML rich text and rejects duplicate IDs, unknown blocks, and unknown versions', () => {
  const layout = { root: { props: {} }, content: [{ type: 'Prose', props: { id: 'stable-id', body: '<p>Hello <strong>Grove</strong></p>' } }] };
  validateLayout(layout); assert.deepEqual(readPage({ manifestVersion: 2, layout }), layout);
  assert.throws(() => validateLayout({ ...layout, content: [...layout.content, ...layout.content] }), /unique/);
  assert.throws(() => validateLayout({ ...layout, content: [{ type: 'Unknown', props: { id: 'id' } }] }), /Unsupported/);
  assert.throws(() => readPage({ manifestVersion: 1, layout }), /migration/);
  assert.throws(() => validateLayout({ ...layout, content: [{ type: 'Prose', props: { id: 'id', body: { type: 'doc' } } }] }), /Unsupported/);
});
