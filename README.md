# Grove

Syntropy Grove is a developer-defined administration workspace with a code-first CMS. Developers choose which content, records, fields and actions users can access; application integrations retain ownership of their data. Syntropy identity integration will live behind host adapters.

**Current milestone: CMS plus a working admin-module foundation.** Grove now has a schema-driven content workspace with autosave, localization, search/status filters, duplication, publishing, version history, restore, and conflict recovery. A separate example client site uses Puck with its own React components, HTML rich text, a versioned component manifest, draft preview and live rendering. Both use the same Postgres content lifecycle, API, and CLI.

Expiring review links, scheduling and publication webhooks remain upcoming work. The deployable host with native sign-in, a generic OpenID Connect adapter and Grove-owned membership is implemented and tested; OpenID Connect has been exercised only against a conforming stand-in provider, not yet a live one. This is not ready for client migration.

## Email workspace

An optional broadcast-email workspace now includes a Puck builder, reusable templates, saved-revision previews, audience CSV imports, test/review/send controls, and Syntropy-backed results. Delivery is disconnected by default. See [email setup, ownership and rollout](docs/email-broadcasts.md). Production identity and real inbox verification are still required before client cutover.

## Run locally

Fastest path with PostgreSQL binaries (`initdb`, `pg_ctl`) installed:

```sh
npm ci
npm run dev:local
```

Open **http://127.0.0.1:4310** and choose **Open local workspace**. This starts a dedicated Postgres cluster under the ignored `.grove/` directory and seeds a fictional Fieldnotes workspace once. Subsequent runs preserve your content. Existing Fieldnotes v1 pages and author strings are upgraded to typed references, with a local pre-migration JSON backup; draft and live snapshots remain separate. Ctrl+C stops the app and database. The example site is at `/example-site/`; open **Pages → Home → Open page editor** to compose it with Puck, or preview an article from its document details.

This explicit local mode trusts users of this machine and enables one-click browser access only on loopback. The default host below still requires its development token. Neither mode is a production identity implementation.

### Docker or an existing development database

Requires Node 22+, npm, and Docker Compose (or a PostgreSQL 17+ database).

```sh
npm ci
npm run build
cp .env.example .env
# Replace GROVE_DEV_TOKEN in .env with a random token.
docker compose up -d --wait
npm run db:migrate
npm run dev
```

The editor and API listen on `127.0.0.1:4310`. Sign in to the browser with the configured development token; it is exchanged for an HttpOnly, SameSite=Strict cookie, not saved in browser storage. Browser writes require a session CSRF token and matching origin. CLI bearer access continues to work. The host grants access only to the configured tenant/site/environment and refuses to start with `NODE_ENV=production`. The standalone core requires the host to supply authentication and authorization. Schema deployment never executes client JavaScript on the CMS server.

In another terminal, load the local environment and walk through the lifecycle:

```sh
set -a
. ./.env
set +a
export GROVE_TOKEN="$GROVE_DEV_TOKEN"

npm run grove -- schema push examples/schema.ts --expected 0 --dry-run
npm run grove -- schema push examples/schema.ts --expected 0
npm run grove -- documents save hello examples/article.json --type article --expected 0 --schema 1
npm run grove -- documents get hello
npm run grove -- documents publish hello --expected 1
npm run grove -- delivery hello --locale es
npm run grove -- documents history hello
npm run grove -- documents restore hello --revision 1 --expected 2
```

Restore creates revision 3 as a draft. Published revision 2 remains live. Publish revision 3 explicitly when ready. On subsequent runs, fetch current revisions first; stale expected versions return `409 conflict`.

## Deployed host

`npm run host` starts the deployable host. Grove is a standalone application: by default members sign in with an email address and password, and a workspace owner hands each new member a one-time link to set theirs, so no email service is required. Set `GROVE_AUTH_MODE=oidc` to sign members in through any OpenID Connect provider instead; Syntropy Auth is a documented preset. In both modes Grove decides what each member may do from its own membership table, with owner, developer, publisher, editor and viewer roles plus explicit application-module grants. A server-only operator token bootstraps the first owner and pushes schemas from CI:

```sh
export GROVE_TOKEN="$GROVE_OPERATOR_TOKEN"
npm run grove -- members invite owner@client.example --role owner
npm run grove -- members link owner@client.example   # password mode: prints the one-time sign-in link
```

See [identity](docs/identity.md) for the decision, modes, roles, setup, API and limits.

## Application administration

Local mode now includes **Class roster** and **Lesson reviews** in the sidebar. Open a record to inspect it and run an available action. Use **Practice as** to switch between the workspace owner, an assigned class coordinator, curriculum reviewer, and read-only observer. Permissions filter both the UI and actual API responses, including private fields and individual records.

These modules use persistent local sample application data outside the CMS tables. They do not connect to live PBA or Studious services. Confirming a seat sends no email and processes no payment; approving a lesson updates only the sample review status.

The independent `GroveAdmin` service accepts trusted adapters over databases or application APIs. It provides declared queries/actions, server-side authorization, version checks and a persistent action journal. `createAdminHandler` works without a CMS instance or schema. A loopback integration test verifies an external HTTP resource without copying records into Grove. Custom record views are bundled by the editor host; the lesson module demonstrates a reading preview.

See [admin platform contracts and plan](docs/admin-platform.md) for ownership boundaries, adapter responsibilities, action outcome/reconciliation limits, API/CLI usage and next integrations. Deployed applications keep their module in their own process and connect it to a Grove workspace over the signed [remote module protocol](docs/remote-modules.md); a workspace config pushed from the client repository registers connections, role grants and the schema together. Job orchestration, PBA staff confirmation, binding the PBA connection to a Syntropy member, and the Studious adapter remain outstanding.

## Records and images

Article blocks now select a story by title. Structured fields support one record or an ordered list, constrained to allowed collections. Authors are records; articles also support related stories and a cover image. The same picker components power the structured editor and the example Puck fields.

Use **Media** to upload, search, edit localized alt text/captions and focal points, inspect usage, and archive/restore unused images. Puck includes an Image block. Images are normalized to WebP, with a 10 MB input/output limit and a 25-megapixel decoding limit. Metadata edits affect all uses immediately; image binaries are immutable. Draft and published references are indexed separately: published links prevent unpublishing their target; any current image use prevents archiving. Historical references remain in history and are revalidated on restore.

Storage defaults to `.grove/media`. Set `GROVE_MEDIA_DIRECTORY` for another private directory, or `GROVE_S3_BUCKET`, `GROVE_S3_ENDPOINT` (optional), `AWS_REGION`, and server-side AWS credentials for S3-compatible storage. The local adapter is integration-tested; a real S3/R2 bucket has not been tested. Never expose the bucket publicly: the example host authorizes image reads and only serves anonymous images referenced by published content.

See [relationship/media contracts](docs/relationships-media.md) for schema/API examples and migration limits, and [product positioning](docs/positioning.md) for the approved developer/client direction.

## Workspace

PBA's first application adapter supports live, read-only class rosters with a configured human staff identity and class allowlist. See [PBA connection setup and boundaries](docs/pba-connection.md). `npm run dev:pba` uses token login; real PBA data is unavailable in demo role-switching mode. A deployed environment and real staff credential must still be verified before claiming a live connection.

| Path | Purpose |
| --- | --- |
| `packages/grove` | Reusable schema definitions, CMS/admin services, Postgres migrations, Fetch API handlers and client |
| `apps/grove` | Thin hosts: the localhost development host (`index.ts`) and the deployable host (`host.ts`, native password or OpenID Connect sign-in) sharing one request pipeline |
| `apps/editor` | React structured-content workspace, using Grove's browser-safe client/controller |
| `apps/example-site` | Separate client-owned Puck configuration, manifest and live/preview site |
| `apps/shared` | Shared record/image pickers used by both editors |
| `scripts/cli.ts` | Schema, content, relationship and media operations without a GUI |
| `examples` | Client-owned schema and example article |
| `docs/spec.md` | Accepted product decisions, initial contracts and remaining milestones |

Package exports keep server dependencies out of client code:

```ts
import { defineSchema } from '@eclosion-tech/grove';
import { createClient } from '@eclosion-tech/grove/client';
import { EditingSession } from '@eclosion-tech/grove/editing';
// Server only:
import { Grove, GroveAdmin, createHandler, createAdminHandler, createPostgresDatabase } from '@eclosion-tech/grove/server';
```

All service operations carry `{ actor, scope: { tenantId, siteId, environment } }`. All tables and lookup paths include the full scope. The host decides whether the authenticated actor may perform each operation in that scope. Never put the development token or a privileged API key in browser code.

## Verify

```sh
npm run check
```

Tests start a temporary PostgreSQL cluster over a private Unix socket and delete it on completion. Install PostgreSQL binaries (`initdb`, `pg_ctl`) on `PATH`, or set `TEST_DATABASE_URL` to a **dedicated test database**. Tests against that URL create Grove tables and uniquely scoped fixtures and leave them there; they do not drop the database. CI runs against a dedicated PostgreSQL service.

The suite also checks relationship types, scope isolation, publication dependencies, draft/live usage, image validation/metadata/archive, authenticated media delivery, and idempotent demo migration with unpublished edits preserved.

The suite exercises real transactions and parallel writers, not an in-memory storage substitute. A build is needed after changing package sources before using the CLI or development host, because they consume package exports from `dist`.

The editing controller is also tested for in-flight typing, debounced saves, invalid JSON, publish/save ordering and conflict recovery. Session tests cover CSRF, expiry and logout; example-site tests verify anonymous live reads and authenticated draft reads, including linked content. Browser interaction and visual QA have not been performed: no browser connection was available in the implementation session. Optional WebMCP list/open tools are feature-detected; no supported WebMCP context was available to verify registration.

The example site reads published content through `/example-api/content/:id`. Its authenticated preview uses the same port with `mode=preview` for both page and linked article data. This is a local example adapter, not a public deployment or an expiring external review-link service.
