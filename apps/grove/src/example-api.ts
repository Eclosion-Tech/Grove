import { GroveError, type Grove, type Actor } from '@eclosion-tech/grove/server';
import type { Scope } from '@eclosion-tech/grove';

/** Example client-site content port. Live reads are public; draft reads require its host session. */
export function exampleApi(grove: Grove, scope: Scope, authenticate: (request: Request) => Promise<Actor | null>) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/example-api/')) return null;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    try {
      const match = /^\/example-api\/(content|media)\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname);
      if (!match || request.method !== 'GET') throw new GroveError('not_found', 'Content not found');
      const mode = url.searchParams.get('mode') ?? 'live';
      if (!['live', 'preview'].includes(mode)) throw new GroveError('invalid_request', 'Unknown content mode');
      const locale = url.searchParams.get('locale') ?? 'en';
      // The host grants this fixed site a published read port; no client-supplied tenant scope.
      const ctx = { actor: { id: 'local-developer' }, scope };
      if (match[1] === 'media') {
        const actor = mode === 'preview' ? await authenticate(request) : ctx.actor;
        if (!actor) throw new GroveError('unauthenticated', 'Sign in to preview images');
        const result = await grove.media.read({ actor, scope }, match[2]!, mode === 'live');
        if (url.searchParams.get('metadata') === '1') return Response.json({ id: result.asset.id, width: result.asset.width, height: result.asset.height, alt: result.asset.alt, caption: result.asset.caption, focalPoint: result.asset.focalPoint }, { headers });
        return new Response(new Uint8Array(result.bytes), { headers: { ...headers, 'Content-Type': result.asset.mimeType } });
      }
      if (mode === 'live') return Response.json(await grove.deliver(ctx, match[2]!, locale), { headers });
      const actor = await authenticate(request);
      if (!actor) throw new GroveError('unauthenticated', 'Sign in to preview drafts');
      const document = await grove.getDocument({ actor, scope }, match[2]!);
      return Response.json({ id: document.id, type: document.type, revision: document.revision, schemaVersion: document.schemaVersion, data: document.draft }, { headers });
    } catch (error) {
      if (error instanceof GroveError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
      console.error(error);
      return Response.json({ error: { code: 'internal_error', message: 'Content could not be loaded' } }, { status: 500, headers });
    }
  };
}
