import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Grove, createPostgresDatabase, migrate, type Context } from '@eclosion-tech/grove/server';
import { starter, emailDocumentType, validateEmail, renderEmail } from '@eclosion-tech/grove-email';
import { emailApi } from '../apps/grove/src/email.js';
import { parseCsv } from '../apps/editor/src/email-csv.js';
const db = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
before(() => migrate(db)); after(() => db.close());
const scope = () => ({ tenantId: randomUUID(), siteId: 'pba', environment: 'test' });
async function fixture() {
  const s = scope(); const authorize = (actor: { id: string }, requested: any, permission: string) => requested.tenantId === s.tenantId && (actor.id === 'owner' || actor.id === 'editor' && !permission.includes('send'));
  const blobs = new Map<string, Uint8Array>(); const storage = { async put(key: string, bytes: Uint8Array) { blobs.set(key, bytes); }, async get(key: string) { if (!blobs.has(key)) throw new Error('Missing image'); return blobs.get(key)!; }, async remove(key: string) { blobs.delete(key); } };
  const grove = new Grove(db, authorize, { storage }); const ctx: Context = { scope: s, actor: { id: 'owner' } };
  await grove.pushSchema(ctx, { locales: ['en'], defaultLocale: 'en', types: [emailDocumentType] }, 0);
  const data = starter('newsletter', 'PBA'); data.subject = 'Summer classes'; data.layout.root.props.address = '123 Example Street'; data.layout.content[2]!.props.href = 'https://example.com/classes';
  const doc = await grove.saveDocument(ctx, 'newsletter', { type: 'email', expectedRevision: 0, expectedSchemaVersion: 1, data: JSON.parse(JSON.stringify(data)) });
  const calls: { path: string; body: any }[] = [];
  const route = emailApi({ grove, scope: s, authorize, authenticate: async request => { const id = request.headers.get('x-actor'); return id ? { id } : null; }, storage, settings: { baseUrl: 'https://syntropy.example', apiKey: 'secret', from: 'news@example.com', fromName: 'PBA', signingSecret: 's'.repeat(32), publicUrl: 'https://grove.example' }, request: async (url, options) => {
    const path = new URL(String(url)).pathname; const body = options?.body ? JSON.parse(String(options.body)) : undefined; calls.push({ path, body });
    return Response.json(path.endsWith('/audiences') ? [{ id: 'a', name: 'PBA community', active: 12 }] : { id: body?.requestId ?? 'test', recipients: 12 });
  } });
  const call = async (path: string, body?: unknown, actor = 'owner') => (await route(new Request(`https://grove.example/email/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: actor ? { 'x-actor': actor } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })))!;
  return { grove, ctx, data, doc, route, calls, call, blobs };
}
test('email rendering constrains markup and keeps footer outside the block list', () => {
  const email = starter(); email.layout.content = [{ type: 'Text', props: { id: 'x', body: '<script>alert(1)</script><p onclick="x()">Hello <strong>reader</strong><a href="javascript:alert(1)">unsafe</a></p>' } }];
  const { html, text } = renderEmail(email); assert.ok(!html.includes('<script')); assert.ok(!html.includes('onclick')); assert.ok(!html.includes('javascript:')); assert.ok(html.includes('<strong>reader</strong>')); assert.ok(html.includes('href="{{unsubscribe_url}}"')); assert.ok(text.includes('Unsubscribe: {{unsubscribe_url}}'));
  email.layout.content[0]!.props.body = '<p>News &amp; updates &#8212; today</p>'; assert.ok(renderEmail(email).text.includes('News & updates — today'));
  email.layout.content.push({ type: 'Divider', props: { id: 'x' } }); assert.throws(() => validateEmail(email), /unique/);
});
test('send validation rejects unsafe links, missing address, and unsupported tokens', () => {
  const email = starter(); assert.throws(() => validateEmail(email, true)); email.layout.root.props.address = 'Address'; email.subject = 'News'; email.layout.content[2]!.props.href = 'javascript:alert(1)'; assert.throws(() => validateEmail(email), /HTTPS/);
  email.layout.content[2]!.props.href = 'https://example.com'; email.subject = '{{secret.token}}'; assert.throws(() => validateEmail(email), /personalization/);
});
test('CSV parses escaped quotes and newlines; refuses malformed imports', () => {
  assert.deepEqual(parseCsv('\uFEFFemail,name,status\r\na@example.com,"A, \"\"B\"\"",unsubscribed\r\nb@example.com,"Two\nLines",active'), [['email','name','status'], ['a@example.com','A, "B"','unsubscribed'], ['b@example.com','Two\nLines','active']]);
  assert.throws(() => parseCsv('email,name\na@example.com')); assert.throws(() => parseCsv('email\n"unterminated'));
});
test('saved revision review pins output; modified drafts and forged review tokens cannot send', async () => {
  const f = await fixture(); const review = await (await f.call('review', { documentId: f.doc.id, revision: 1, listId: 'a' })).json();
  assert.equal(review.summary.recipients, 12); assert.equal(f.calls.filter(c => c.path.endsWith('/campaigns')).length, 0);
  assert.equal((await f.call('send', { review: review.review + 'bad' })).status, 403);
  const sent = await f.call('send', { review: review.review }); assert.equal(sent.status, 200);
  const payload = f.calls.at(-1)!.body; assert.equal(payload.source.revision, 1); assert.equal(payload.expectedRecipients, 12); assert.ok(payload.html.includes('PBA'));
  await f.grove.saveDocument(f.ctx, f.doc.id, { type: 'email', expectedRevision: 1, expectedSchemaVersion: 1, data: { subject: 'Changed subject' } });
  assert.equal((await f.call('send', { review: review.review })).status, 409);
});
test('host email permissions apply to direct calls and review identity', async () => {
  const f = await fixture(); assert.equal((await f.call('config', undefined, '')).status, 401); assert.equal((await f.call('config', undefined, 'outsider')).status, 403);
  const review = await (await f.call('review', { documentId: f.doc.id, revision: 1, listId: 'a' })).json();
  assert.equal((await f.call('send', { review: review.review }, 'editor')).status, 403);
  assert.equal((await f.call('test', { documentId: f.doc.id, revision: 1, to: 'test@example.com' }, 'editor')).status, 403);
  assert.equal(f.calls.filter(c => c.path.endsWith('/campaigns') || c.path.endsWith('/send')).length, 0);
});
test('repeated reviews of the same saved campaign keep one submission identity', async () => {
  const f = await fixture(); const input = { documentId: f.doc.id, revision: 1, listId: 'a' };
  for (let n=0;n<2;n++) { const r = await (await f.call('review', input)).json(); await f.call('send', { review: r.review }); }
  const submissions = f.calls.filter(c => c.path.endsWith('/campaigns')); assert.equal(submissions.length, 2); assert.equal(submissions[0]!.body.requestId, submissions[1]!.body.requestId);
});
test('email image snapshot remains readable after source archive and requires its signed capability', async () => {
  const f = await fixture(); const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const asset = await f.grove.media.upload(f.ctx, 'image.png', bytes);
  f.data.layout.content.push({ type: 'Image', props: { id: 'image', image: { _type: 'asset', _ref: asset.id }, alt: 'Sample image' } });
  await f.grove.saveDocument(f.ctx, f.doc.id, { type: 'email', expectedRevision: 1, expectedSchemaVersion: 1, data: JSON.parse(JSON.stringify(f.data)) });
  const review = await (await f.call('review', { documentId: f.doc.id, revision: 2, listId: 'a' })).json();
  const url = /src="(https:\/\/grove.example\/email-assets\/[^\"]+)"/.exec(review.html)![1]!;
  const image = await f.route(new Request(url)); assert.equal(image!.status, 200); assert.equal(image!.headers.get('content-type'), 'image/jpeg');
  assert.equal((await f.route(new Request(url.split('?')[0]!)))!.status, 404);
  await f.grove.saveDocument(f.ctx, f.doc.id, { type: 'email', expectedRevision: 2, expectedSchemaVersion: 1, data: { layout: JSON.parse(JSON.stringify(starter().layout)) } });
  await f.grove.media.setArchived(f.ctx, asset.id, asset.revision, true);
  assert.equal((await f.route(new Request(url)))!.status, 200);
});
