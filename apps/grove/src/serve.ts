import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import type { Actor, InstanceKeys } from '@eclosion-tech/grove/server';

/** What every host identity adapter supplies: who is calling, browser write protection, and its own sign-in routes. */
export type Access = {
  authenticate: (request: Request) => Promise<Actor | null>;
  protect: (request: Request) => Response | null | Promise<Response | null>;
  route: (request: Request) => Promise<Response | null>;
};
type Part = (request: Request) => Promise<Response | null>;

/** One request pipeline for every host: sign-in routes, email, client site, the Grove API, then static files. */
export function compose(parts: { access: Access; email: Part; clientSite: Part; handler: (request: Request) => Promise<Response>; static: (request: Request) => Promise<Response>; keys?: InstanceKeys }) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    // Public keys applications use to verify this instance's signed module requests. Public by design, never cached for long.
    if (path === '/.well-known/grove-keys' && parts.keys) return ['GET', 'HEAD'].includes(request.method) ? Response.json(await parts.keys.published(), { headers: { 'Cache-Control': 'public, max-age=300' } }) : new Response('Method not allowed', { status: 405 });
    const routed = await parts.access.route(request);
    if (routed) return routed;
    const emailed = path.startsWith('/email/') ? (await parts.access.protect(request)) ?? await parts.email(request) : await parts.email(request);
    if (emailed) return emailed;
    const site = await parts.clientSite(request);
    if (site) return site;
    if (path.startsWith('/v1/')) return (await parts.access.protect(request)) ?? parts.handler(request);
    return parts.static(request);
  };
}

export function listen(options: {
  port: number; bind: string; protocol: 'http' | 'https';
  /** Accepted Host header values for the bound port. Requests for any other host are refused before routing. */
  hosts: (port: number) => string[];
  route: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
  label: string;
}) {
  const server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : options.port;
      if (!options.hosts(port).includes(req.headers.host ?? '')) { res.writeHead(400); res.end('Invalid host'); return; }
      const request = new Request(new URL(req.url ?? '/', `${options.protocol}://${req.headers.host}`), {
        method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
      });
      const response = await options.route(request);
      const outgoingHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers);
      // Set-Cookie is repeatable: the OIDC callback sets the session and clears
      // its login attempt. Object.fromEntries alone retains only the last one.
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length) outgoingHeaders['set-cookie'] = setCookies;
      res.writeHead(response.status, outgoingHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_request', message: 'Invalid HTTP request' } }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(options.port, options.bind, () => {
    const address = server.address();
    if (address && typeof address === 'object') console.log(`${options.label} listening on ${options.protocol}://${options.bind}:${address.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    server.close(() => { void options.close().then(() => process.exit(0)); });
    server.closeIdleConnections();
  });
  return server;
}
