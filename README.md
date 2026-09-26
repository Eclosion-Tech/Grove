# Grove

Grove is a developer-defined administration workspace with a code-first CMS. Developers decide which content, records, fields and actions their clients can reach; applications keep ownership of their own data. Visual editing, the CLI, the API and future AI operations all respect the same boundaries.

The reusable core is published as [`@eclosion-tech/grove`](https://www.npmjs.com/package/@eclosion-tech/grove) under the GNU AGPL v3.

## What it does

- **Content workspace.** Schema-driven collections with autosave, localization, search and status filters, duplication, publishing, version history, restore and conflict recovery. Schemas are versioned data pushed from the client repository with a dry-run diff; adding a field never needs a deployment.
- **Records and media.** Typed references between records, a media library with localized alt text and captions, focal points, usage tracking, and archive protection. Images are normalized to WebP; binaries are immutable.
- **Page composition.** A client site owns its React components and its Puck configuration behind an authenticated edit route; Grove stores the composition, resolves references, and serves draft previews and published content.
- **Application administration.** An application exposes modules of resources and actions with server-side authorization, version checks and a durable action journal. Modules run in-process for local development or in the application's own process, connected to a Grove workspace over a signed HTTP protocol.
- **Sign-in and membership.** Native email and password by default, any OpenID Connect provider by configuration. Grove owns membership: owner, developer, publisher, editor and viewer roles, per-member and per-role module grants, and a server-only operator token for CI and bootstrap.
- **Email broadcasts.** An optional workspace for composing, previewing and sending broadcast email, disconnected from delivery by default.

## Run locally

Requires Node 22+ and PostgreSQL binaries (`initdb`, `pg_ctl`) on `PATH`.

```sh
npm ci
npm run dev:local
```

Open **http://127.0.0.1:4310** and choose **Open local workspace**. A dedicated PostgreSQL cluster starts under the ignored `.grove/` directory and a fictional workspace is seeded once; later runs keep your content. The example site is at `/example-site/`. Local mode trusts users of this machine and grants one-click access on loopback only.

With Docker Compose or an existing PostgreSQL 17 database instead:

```sh
npm ci && npm run build
cp .env.example .env        # set GROVE_DEV_TOKEN to a random value
docker compose up -d --wait
npm run db:migrate
npm run dev
```

Then walk through the content lifecycle from another terminal:

```sh
export GROVE_TOKEN="$GROVE_DEV_TOKEN"
npm run grove -- schema push examples/schema.ts --expected 0 --dry-run
npm run grove -- schema push examples/schema.ts --expected 0
npm run grove -- documents save hello examples/article.json --type article --expected 0 --schema 1
npm run grove -- documents publish hello --expected 1
npm run grove -- delivery hello --locale es
npm run grove -- documents history hello
```

Every write carries an expected version; a stale version returns `409 conflict`. Restore always creates a new draft and never publishes implicitly.

## Deploy

`npm run host` starts the deployable host. It applies migrations at boot, answers only its configured public origin, and refuses the development token and practice roles.

- `GROVE_AUTH_MODE=password` (default): members sign in with email and password. An owner invites a member, then mints a one-time link that sets their password; no email service is required.
- `GROVE_AUTH_MODE=oidc`: members sign in through any OpenID Connect provider (`GROVE_OIDC_*`), optionally bound to one organization by a claim.

```sh
export GROVE_TOKEN="$GROVE_OPERATOR_TOKEN"
npm run grove -- members invite owner@client.example --role owner
npm run grove -- members link owner@client.example      # password mode: prints the one-time link
```

See [identity](docs/identity.md) for modes, roles, setup, API and limits, and [`.env.example`](.env.example) for every variable.

## Connect an application

An application serves its admin module from its own process and a workspace owner registers the endpoint. Grove signs every request with a per-instance key published at `/.well-known/grove-keys`; the application verifies the signature and checks which Grove instances and workspaces it serves. Nothing the application returns is executed, and Grove stores no application secret.

```ts
import { createRemoteModuleHandler, remoteKeyResolver } from '@eclosion-tech/grove/remote';

const handler = createRemoteModuleHandler({
  module,                                  // an ordinary AdminModule
  catalogRevision: 'my-app-3',             // bump whenever the contract changes
  resolveKey: remoteKeyResolver('https://grove.example.org/.well-known/grove-keys'),
  allow: ({ hostId, scope }) => hostId === 'https://grove.example.org' && (!scope || scope.siteId === 'my-site'),
  ledger,                                  // records outcomes in the same transaction as your mutations
});
```

A workspace config pushed from the client repository registers the schema, module connections and role grants together, with a dry run first:

```sh
npm run grove -- config push grove.config.ts --expected 3 --dry-run
npm run grove -- config push grove.config.ts --expected 3
```

See [remote modules](docs/remote-modules.md) for the protocol and [admin platform](docs/admin-platform.md) for ownership boundaries, adapter responsibilities and outcome semantics.

## Package exports

```ts
import { defineSchema } from '@eclosion-tech/grove';                 // browser-safe types and schema helpers
import { createClient } from '@eclosion-tech/grove/client';          // typed HTTP client
import { EditingSession } from '@eclosion-tech/grove/editing';       // editing controller used by the editor
import { Grove, GroveAdmin, createHandler } from '@eclosion-tech/grove/server';   // services, handlers, migrations (server only)
import { createRemoteModuleHandler } from '@eclosion-tech/grove/remote';         // serve a module to a Grove instance; no CMS runtime
```

All service operations carry `{ actor, scope: { tenantId, siteId, environment } }`, every table and lookup includes the full scope, and the host decides whether the authenticated actor may perform each operation. Never put a privileged token in browser code.

## Repository

| Path | Purpose |
| --- | --- |
| `packages/grove` | The published core: schema registry, documents, media, membership, admin platform, remote protocol, migrations |
| `packages/email-builder` | Email document contract, renderer and Puck configuration |
| `apps/grove` | Thin hosts: the localhost development host and the deployable host, sharing one request pipeline |
| `apps/editor` | React structured-content workspace |
| `apps/example-site` | A separate client-owned Puck site with live and preview rendering |
| `apps/shared` | Record and image pickers used by both editors |
| `scripts/cli.ts` | Schema, content, media, membership, connection and config operations without a GUI |
| `examples` | Client-owned schema and example content |
| `docs` | Accepted decisions, contracts and remaining milestones; start with [spec.md](docs/spec.md) |

## Verify

```sh
npm run check
```

Tests run against a temporary PostgreSQL cluster (or `TEST_DATABASE_URL` pointing at a dedicated test database) and exercise real transactions and parallel writers. They cover the content lifecycle, scope isolation, references and media, the editing controller, sessions and sign-in in both modes, membership, the admin journal, the remote module protocol, connections and workspace config. Browser and visual QA have not been performed. A build is needed after changing package sources before using the CLI or hosts, which consume `dist`.

## Status

Not yet ready for client migration. Remaining before that: a sign-in verified against a live OpenID Connect provider, expiring review links, scheduling, publication webhooks, export/import and verified restore.

## License

GNU Affero General Public License v3. See [LICENSE](LICENSE).
