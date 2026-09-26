# Developer-defined administration — accepted direction and first implementation

Recorded 2026-09-06 following the Grove, PBA and Studious discussion. This extends the CMS baseline; no external Pear records or client applications have been changed.

The [PBA registration adapter](pba-connection.md) now implements the first read-only application connection: configured class resources, an explicit staff identity binding, fresh upstream reads and limited field projection. Confirmation actions remain unavailable pending an upstream concurrency and operation-outcome contract. The local practice modules below still use synthetic data.

**Grove gives developers the power to build a workspace their clients can confidently operate.** Developers deliberately expose content, queries, and actions. Clients use a tailored interface and real component previews. Code, CLI, API, and future AI integrations use the same authorization and domain boundaries.

## Architecture

| Layer | Responsibility |
| --- | --- |
| Admin foundation | Module/resource definitions, declared queries/actions, server authorization, field projection, action journal and transport |
| CMS | Editorial storage, schema registry, drafts/publication, media, relationships and content history |
| Application adapters | Authoritative application data, scoped queries, domain validation, atomic mutations and service integrations |
| Host interface | Navigation, generic tables/forms/details, trusted custom React views and identity integration |

`GroveAdmin` and `createAdminHandler` run without a CMS instance, content schema or stored documents. The action journal still requires Postgres and Grove's migrations. They currently ship in the same package as the CMS; this is a working boundary, not a completed package split or general plugin marketplace.

Adapters are trusted server code registered by the host at startup. Their closures may use a database client, an application service, or a fixed HTTP endpoint with server-only credentials. Browsers receive a deliberately projected module catalog and authorized record values. Grove never accepts arbitrary SQL, endpoint URLs, credentials or executable module code from request bodies. Client-site modules in a shared service must be deployed through a trusted host integration or an isolated application API; loading untrusted tenant code into the shared process is not supported.

Each resource has `source.query`, `source.get`, and a required `source.authorizeRecord`. Queries must enforce tenant/site/environment and record ownership before pagination. Grove performs an additional record check and projects only columns permitted for the actor. The application adapter is part of the trusted authorization boundary; Grove cannot infer tenancy from arbitrary external data. Returned IDs, versions and cursor tokens must themselves be safe to disclose. Use opaque cursors when external IDs contain sensitive information.

Actions have a named permission, typed inputs, a description/confirmation, a business-state availability predicate and an execution handler. Resource read access, action permission and record authorization are all checked on direct API calls. Unknown fields and invalid values are rejected. Applications must recheck the expected version, record authorization and domain constraints atomically where their data lives; an earlier UI or Grove read is not a transaction lock.

## Application-owned modules

An application can own its Grove module and have a host load it: set `GROVE_ADMIN_MODULES` to a comma-separated list of absolute paths or package names, each exporting a default function `({ scope, env }) => AdminModule[]`. The host imports them once at startup; this is operator configuration, never request data, and relative paths are refused. A module needs Grove only for types: the runtime contract is plain objects, and an error whose `name` is `AdminActionRejected` counts as a known rollback even when the module was built against another copy of Grove. Worm's module (`grove-admin` in the Worm repository) is the first one; it reads through Worm's worker API and writes through version-checked Postgres functions that Worm's repository owns. Loading a module in-process is the local development path; deployed applications keep their module in their own process and serve it over the signed [remote module protocol](remote-modules.md), which a Grove instance connects to by endpoint alone.

## Local practice modules

`apps/grove/src/admin-demo.ts` implements two modules using application-owned tables in `grove_demo`, separate from all Grove content tables. The demo shares the development Postgres instance; it does not connect to live PBA/Studious services or move their data.

- **Class roster:** participant/class/status details, restricted email/staff notes, and a confirm-seat action.
- **Lesson reviews:** sample curriculum text, a custom reading preview, approve and request-revision actions.

The first three visible columns form the generic table; all allowed columns are available in record details. `apps/editor/src/admin-views.tsx` registers an optional custom record view by `module/resource`. It receives only projected records. The current lesson view previews sample text; it is not a Studious renderer or LMS integration. Custom code is compiled with the editor, never downloaded from arbitrary module URLs.

`npm run dev:local` seeds these records idempotently and adds both applications to the sidebar. The **Practice as** selector demonstrates:

| Local role | Access |
| --- | --- |
| Workspace owner | CMS, both modules, all demo records and actions |
| Class coordinator | Assigned registrations, contact fields, confirm seat |
| Curriculum reviewer | Assigned lessons, approve/request revision |
| Read-only observer | Both modules, public fields, no actions |

Role changes require an existing session, matching origin and CSRF token, rotate CSRF, and change the server-authenticated actor. This role selector exists only in explicitly machine-trusting local mode. On a deployed host, members receive application-module permissions as explicit `admin:*` grants; see [identity](identity.md). Fine-grained module permissions do not yet extend the CMS's existing coarse content permissions.

## Action journal and outcomes

Clients supply a unique `requestId` for each intended action, plus `recordId`, `expectedVersion`, and `values`. Grove stores a canonical input hash, scope, actor, operation/target and outcome. It does not persist raw action inputs or provider credentials/responses. Concurrent/repeated use of the same request runs the adapter at most once while journal entries are retained. Reusing an ID with different inputs conflicts; replay rechecks current authorization.

A pending target is locked against other Grove actions in that resource across actors. The adapter receives a stable `operationId` for its own provider idempotency. No database transaction is held open across external I/O.

| Outcome | Meaning |
| --- | --- |
| `running` | Claim recorded; execution may still be in progress. A process crash can leave this state. |
| `succeeded` | Adapter resolved and the success was recorded. |
| `rejected` | Adapter threw `AdminActionRejected`, explicitly guaranteeing no effects committed; another reviewed attempt is allowed. |
| `uncertain` | Adapter threw without that guarantee; effects may have occurred. New attempts on the target are blocked. |

This is not distributed exactly-once execution. If a remote service commits but the host crashes before recording success, the journal remains unresolved. Do not automatically clear or retry those claims. A trusted operator must reconcile the operation ID against the owning system; a provider-specific reconciliation API/UI is a remaining milestone. Use `AdminActionRejected` only after a known rollback or before any side effect. Known preflight permission/validation/version failures execute nothing and create no action entry.

The UI asks for explicit confirmation, preserves request identity when retrying after a network error, and shows recent outcomes. Activity is actor-scoped (latest 50) and rechecks action/record access. The journal stores actor IDs for inspection by trusted administrators; an organization-wide audit browser and retention/export policy remain future work. CMS publishing/restoring cannot change application records or replay these actions.

## API and CLI

Base: `/v1/tenants/:tenant/sites/:site/environments/:environment/admin`.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/modules` | Allowed modules/resources/columns/action definitions |
| POST | `/:module/:resource/query` | `{filters, cursor, limit}`; read-only query, max 100 records |
| GET | `/:module/:resource/records/:id` | Authorized, projected record and currently available action IDs |
| POST | `/:module/:resource/actions/:action` | `{requestId, recordId, expectedVersion, values}` |
| GET | `/:module/:resource/activity` | Current actor's visible recent action outcomes |

All routes authenticate and return uncacheable responses. Browser POSTs, including queries, use the host's CSRF/origin checks. Async/uncertain/rejected action outcomes use HTTP 202; inspect `status` rather than treating every successful HTTP response as an applied mutation. Malformed/unauthorized/stale requests use the normal 400/401/403/404/409 error envelope.

```sh
npm run grove -- admin modules
npm run grove -- admin query registrations roster
npm run grove -- admin get registrations roster --record reg-01
npm run grove -- admin action registrations roster --action confirm --record reg-01 --expected 1 --request my-unique-confirmation
npm run grove -- admin activity registrations roster
```

CLI uses existing `GROVE_URL`, scope and token environment variables. `--input query.json` supplies filters/cursors/limits for a query, or declared input values for an action. An action can run immediately; its CLI invocation is the explicit instruction. A CLI or AI actor must receive appropriate scoped permissions from the host.

## Verification and next steps

Integration coverage uses real PostgreSQL for journals and example application data. It verifies operation/field/record/scope enforcement, pagination, direct API attacks, stale state, duplicate/concurrent requests, durable replay after service recreation, revoked access, uncertain results, known rollback and session role changes. An independent loopback HTTP service test demonstrates external ownership, request versioning and provider idempotency-key propagation without copying data into CMS documents.

Verification after the PBA adapter: all 48 tests, including the opt-in test against PBA's actual source and migrations, passed with all workspace builds and TypeScript checks. The earlier local-host HTTP check verified role switching, forbidden direct actions, private-field projection and preservation of all six CMS documents. No deployed PBA connection or browser interaction/visual QA has been performed.

The PBA read adapter is implemented; connecting a selected environment still requires its exact endpoint, class configuration and verified staff credentials. Staff confirmation needs an upstream revision and durable operation-outcome contract first. Studious should then connect its curriculum/review workflow and real learning-component renderer. Neither client project is changed by this milestone. A domain integration must decide publishing/promotion semantics; approving a review in the local demo merely changes its sample status.

Still to build: production identity, provider-specific reconciliation, asynchronous job handles/progress/cancellation, external-reference fields and pickers, richer input schemas, custom edit-view contracts, audit administration, and durable curriculum version/attempt relationships. Existing Studious curriculum storage should remain authoritative unless a separate migration is explicitly designed and verified. Student attempts, scoring and progression remain LMS-owned; previews must not write learner progress.
