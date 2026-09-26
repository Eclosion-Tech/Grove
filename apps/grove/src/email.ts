import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { GroveError, type Grove, type Actor, type Authorize, type StorageAdapter } from '@eclosion-tech/grove/server';
import type { Scope } from '@eclosion-tech/grove';
import type { Context } from '@eclosion-tech/grove/server';
import { validateEmail, renderEmail, type EmailDocument, type Asset } from '@eclosion-tech/grove-email';

export type EmailSettings = { baseUrl?: string; apiKey?: string; from?: string; fromName: string; replyTo?: string; publicUrl?: string; signingSecret: string };
export function deliveryApi(settings: EmailSettings, request: typeof fetch = fetch) {
  return async (path: string, body?: unknown) => {
    if (!settings.baseUrl || !settings.apiKey) throw new GroveError('invalid_request', 'Email delivery is not connected yet. You can still save and preview drafts.');
    const base = new URL(settings.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password) throw new Error('The email delivery API requires an HTTPS server URL');
    const response = await request(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(55_000) });
    const value = await response.json() as any;
    if (!response.ok) throw new GroveError(response.status === 409 ? 'conflict' : 'invalid_request', typeof value.error === 'string' ? value.error : value.error?.message ?? 'The email service could not complete this request.');
    return value;
  };
}
export function emailApi(options: { grove: Grove; scope: Scope; authorize: Authorize; authenticate: (request: Request) => Promise<Actor | null>; storage: StorageAdapter; settings: EmailSettings; request?: typeof fetch }) {
  const { grove, scope, settings, storage } = options;
  if (settings.signingSecret.length < 32) throw new Error('Email signing secret must have at least 32 characters');
  const upstream = deliveryApi(settings, options.request);
  const sign = (value: string) => createHmac('sha256', settings.signingSecret).update(JSON.stringify(scope)).update(value).digest('base64url');
  const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const connected = !!(settings.baseUrl && settings.apiKey && settings.from);
  const encode = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${sign(body)}`; };
  function decode(token: unknown) {
    if (typeof token !== 'string' || token.length > 600_000) throw new GroveError('invalid_request', 'Review this email before sending');
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra || !equal(signature, sign(body))) throw new GroveError('forbidden', 'This review is invalid');
    const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as any;
    if (value.expires < Date.now()) throw new GroveError('conflict', 'This review expired. Review the email again.');
    return value;
  }
  async function saved(ctx: Context, body: any, send = false) {
    if (typeof body.documentId !== 'string' || !Number.isInteger(body.revision)) throw new GroveError('invalid_request', 'Choose a saved email revision');
    const doc = await grove.getDocument(ctx, body.documentId);
    if (doc.type !== 'email') throw new GroveError('invalid_request', 'This document is not an email');
    if (doc.revision !== body.revision) throw new GroveError('conflict', 'This email changed. Reload and review the latest draft.');
    validateEmail(doc.draft, send); return { doc, email: doc.draft as unknown as EmailDocument };
  }
  async function compile(ctx: Context, email: EmailDocument, origin: string, sending: boolean) {
    const images: Record<string, string> = {};
    for (const block of email.layout.content) {
      if (block.type !== 'Image' || !block.props.image) continue;
      const id = (block.props.image as Asset)._ref;
      if (images[id]) continue;
      if (sending && (!settings.publicUrl || new URL(settings.publicUrl).protocol !== 'https:')) throw new GroveError('invalid_request', 'Configure the public HTTPS image address before sending images');
      const media = await grove.media.read(ctx, id);
      if (media.asset.archived) throw new GroveError('invalid_request', 'Restore the archived image or choose another');
      const bytes = await sharp(media.bytes).flatten({ background: '#ffffff' }).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      const key = createHash('sha256').update(JSON.stringify(scope)).update(bytes).digest('hex');
      try { await storage.put(`email/${key}.jpg`, bytes, 'image/jpeg'); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
      images[id] = `${settings.publicUrl ?? origin}/email-assets/${key}.jpg?token=${sign(key)}`;
    }
    return renderEmail(email, images);
  }
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/email/') && !url.pathname.startsWith('/email-assets/')) return null;
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
      const asset = /^\/email-assets\/([a-f0-9]{64})\.jpg$/.exec(url.pathname);
      if (asset && request.method === 'GET') {
        if (!equal(url.searchParams.get('token') ?? '', sign(asset[1]!))) throw new GroveError('not_found', 'Image not found');
        return new Response(new Uint8Array(await storage.get(`email/${asset[1]}.jpg`)), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public,max-age=31536000,immutable', 'X-Content-Type-Options': 'nosniff' } });
      }
      const actor = await options.authenticate(request);
      if (!actor) throw new GroveError('unauthenticated', 'Sign in to use email');
      const ctx = { actor, scope };
      const path = url.pathname.slice('/email/'.length);
      const permission = (['send', 'test'].includes(path) || /^campaigns\/[a-f0-9-]{36}\/cancel$/.test(path)) ? 'admin:email:send' : path.startsWith('audiences') && request.method === 'POST' ? 'admin:email:audiences' : 'admin:email:read';
      if (!await options.authorize(actor, scope, permission)) throw new GroveError('forbidden', 'This account cannot perform that email action');
      if (path === 'config' && request.method === 'GET') return json({ connected, from: settings.from ?? '', fromName: settings.fromName, canSend: await options.authorize(actor, scope, 'admin:email:send'), canManageAudiences: await options.authorize(actor, scope, 'admin:email:audiences') });
      if (request.method === 'GET' && /^(audiences(?:\/[a-f0-9-]{36})?|campaigns)$/.test(path)) return json(await upstream(`/api/v1/email-broadcasts/${path}${url.search}`));
      if (request.method !== 'POST') throw new GroveError('not_found', 'Email action not found');
      const raw = await request.text(); if (Buffer.byteLength(raw) > 1_000_000) throw new GroveError('invalid_request', 'Request too large');
      const body = JSON.parse(raw);
      if (/^audiences(?:\/[a-f0-9-]{36}\/import)?$/.test(path)) return json(await upstream(`/api/v1/email-broadcasts/${path}`, body));
      if (/^campaigns\/[a-f0-9-]{36}\/cancel$/.test(path)) return json(await upstream(`/api/v1/email-broadcasts/${path}`, {}));
      if (path === 'send') {
        const review = decode(body.review);
        if (review.actor !== actor.id) throw new GroveError('forbidden', 'Review this email with your own account');
        await saved(ctx, { documentId: review.payload.source.documentId, revision: review.payload.source.revision }, true);
        return json(await upstream('/api/v1/email-broadcasts/campaigns', review.payload));
      }
      if (!['preview', 'review', 'test'].includes(path)) throw new GroveError('not_found', 'Email action not found');
      const { doc, email } = await saved(ctx, body, path !== 'preview');
      const output = await compile(ctx, email, url.origin, path !== 'preview');
      if (path === 'preview') return json(output);
      if (!connected) throw new GroveError('invalid_request', 'Connect email delivery before sending');
      if (path === 'test') {
        if (typeof body.to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) throw new GroveError('invalid_request', 'Enter one test recipient');
        const replace = (s: string) => s.replaceAll('{{subscriber.name}}', 'Test reader').replaceAll('{{subscriber.email}}', body.to).replaceAll('{{unsubscribe_url}}', '#test-email');
        return json(await upstream('/api/v1/emails/send', { to: body.to, from: `${settings.fromName} <${settings.from}>`, replyTo: settings.replyTo, subject: `[TEST] ${replace(email.subject)}`, html: replace(output.html), text: replace(output.text), purpose: 'grove.broadcast_test' }));
      }
      const audiences = await upstream('/api/v1/email-broadcasts/audiences');
      const list = audiences.find((a: any) => a.id === body.listId);
      if (!list || list.active < 1) throw new GroveError('invalid_request', 'Choose an audience with active subscribers');
      let scheduledAt: string | undefined;
      if (body.scheduledAt) { const date = new Date(body.scheduledAt); if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new GroveError('invalid_request', 'Choose a future send time'); scheduledAt = date.toISOString(); }
      const fingerprint = createHash('sha256').update(JSON.stringify([scope, doc.id, doc.revision, list.id, scheduledAt ?? null, settings.from, settings.fromName])).digest('hex');
      const requestId = `${fingerprint.slice(0,8)}-${fingerprint.slice(8,12)}-4${fingerprint.slice(13,16)}-a${fingerprint.slice(17,20)}-${fingerprint.slice(20,32)}`;
      const payload = { requestId, listId: list.id, name: email.title, subject: email.subject, from: settings.from, fromName: settings.fromName, replyTo: settings.replyTo, ...output, source: { documentId: doc.id, revision: doc.revision }, ...(scheduledAt ? { scheduledAt } : {}), expectedRecipients: list.active };
      return json({ review: encode({ payload, actor: actor.id, expires: Date.now() + 30 * 60_000 }), summary: { subject: email.subject, from: `${settings.fromName} <${settings.from}>`, audience: list.name, recipients: list.active, scheduledAt, revision: doc.revision }, ...output });
    } catch (error) {
      if (error instanceof GroveError) return json({ error: { message: error.message, code: error.code } }, error.status);
      if (error instanceof SyntaxError) return json({ error: { message: 'Invalid JSON' } }, 400);
      return json({ error: { message: error instanceof Error ? error.message : 'Email request failed' } }, 400);
    }
  };
}
