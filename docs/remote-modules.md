# Remote admin modules — protocol v1

Recorded 2026-09-26. An application keeps its admin module in its own process and speaks this protocol; a Grove instance registers a connection to it. Grove transports data and decisions, never code: nothing an application returns is executed. This is the Sanity-shaped split for application-owned data: Grove hosts the generic UI, sign-in, membership, permissions and the action journal; the application keeps record authorization, business rules, atomic mutations and authoritative operation outcomes.

## Trust

Every request from Grove is signed with an Ed25519 key that belongs to the Grove instance. Grove publishes its public keys at `/.well-known/grove-keys` as a JWK set; retired keys stay published for one day. The application verifies the signature, then checks an allowlist of Grove instances (`hostId`) and workspaces it serves. Grove stores no per-application secret; a connection is an endpoint URL and nothing else.

Headers on every request:

```http
Grove-Admin-Version: 1.0
Grove-Signature: v1,kid=<key id>,ts=<unix seconds>,sig=<base64url Ed25519 signature>
Content-Type: application/json
```

The signed string is `grove-remote-v1`, the method, the URL path, the SHA-256 of the body, the timestamp and the key id, joined by newlines. The body carries the context, so the context is bound by the signature. Signatures older than five minutes are refused. Responses carry `Grove-Admin-Version`; Grove refuses any other major version.

Endpoint rules Grove enforces before signing anything: https, a bare path, no credentials, query or fragment, no private, link-local or `.local` hosts, and no redirects.

## Routes

All routes are `POST` beneath the connection's endpoint, with JSON bodies. Every body except the catalog request carries a `context`:

```json
{ "hostId": "https://grove.example.org", "connectionId": "my-app", "scope": { "tenantId": "…", "siteId": "…", "environment": "…" }, "actor": { "id": "<member subject>", "permissions": ["admin:worm:organizations:read"] } }
```

`actor.permissions` are the module's permission names this member holds, computed by Grove from membership. The application may narrow further; it must never widen.

| Route | Body | Response |
| --- | --- | --- |
| `/catalog` | `{context: {hostId, connectionId}}` | `{catalogRevision, module}` |
| `/resources/:resource/query` | `catalogRevision, filters, cursor, limit` | `{catalogRevision, records, nextCursor}` |
| `/resources/:resource/records/:id` | `catalogRevision` | `{catalogRevision, record}` or 404 |
| `/resources/:resource/actions/:action` | `catalogRevision, operationId, inputHash, recordId, expectedVersion, values` | outcome |
| `/operations/:operationId` | `operationId, inputHash` | outcome, or `status: "unknown"` |

The **catalog** is the module descriptor: id, label, description, resources with permission names, columns (with optional per-column permission), filters, and actions with inputs. Grove validates it as untrusted input: bounded sizes, known field types, unique identifiers, permissions confined to `admin:<module id>:…`. `catalogRevision` changes whenever the contract changes; Grove pins the revision it loaded and the application refuses requests for any other, so a redeploy cannot silently change what an action means.

A **record** carries its own decisions:

```json
{ "id": "org-1", "version": 42, "values": { "name": "Pages & Prose" }, "access": { "read": true, "actions": { "verify": { "authorized": true, "available": false } } } }
```

`read` is record authorization for this actor; per action, `authorized` is record authorization and `available` is business state. Grove intersects these with its own permission checks and projects only allowed columns. Filtering by workspace and actor happens in the application before pagination.

An **action** request carries a stable `operationId` (derived by Grove from the member's request id) and `inputHash`, the SHA-256 of the canonical record id, expected version and values. The application must:

1. look up `operationId` in its operation ledger first and return the recorded outcome for matching inputs, or `idempotency_conflict` for different inputs;
2. reload the record, and check authorization, availability and `expectedVersion` atomically with the mutation;
3. record the outcome in the same transaction as the mutation.

Outcomes:

```json
{ "operationId": "…", "inputHash": "…", "status": "succeeded" }
{ "operationId": "…", "inputHash": "…", "status": "rejected", "noEffectsCommitted": true, "error": { "code": "stale_version", "message": "Reload the record." } }
{ "operationId": "…", "inputHash": "…", "status": "running" }
```

Grove treats only a `rejected` outcome with `noEffectsCommitted: true` as a rollback and releases the record. `running` is polled through `/operations/:id` a few times; anything else, including timeouts, malformed replies, unknown status and error envelopes without an outcome, is journaled as **uncertain** and blocks further actions on that record until an operator reconciles. Rejection codes: `stale_version`, `not_found`, `forbidden`, `not_available`, `catalog_changed`, `invalid_input`, and the application's own `rejected`.

## Implementing the application side

`@eclosion-tech/grove/server` exports `createRemoteModuleHandler`, a Fetch handler that serves an ordinary in-process `AdminModule` over this protocol: it verifies signatures against the keys you resolve, applies your allowlist, turns the module's `authorizeRecord` and `available` predicates into per-record decisions, and drives the operation ledger. Mount it on any Fetch-compatible server. Supply an `OperationLedger` whose `record` runs in the same transaction as your mutation; the bundled `MemoryLedger` is for tests and local development only.

An application's module, written as an ordinary `AdminModule`, mounts unchanged behind this handler in the application's own process.

## Implementing the Grove side

`remoteModule({ connection, key, authorize })` loads the catalog, validates it, and returns an `AdminModule` that `GroveAdmin` treats like any other. Decisions arrive with records and are consulted by `authorizeRecord` and `available` without further requests. `InstanceKeys` stores the instance's signing keys in Postgres, generating one on first use and supporting rotation with a publication grace period.

## Registering a connection

An owner (or the operator) registers a connection by id and endpoint. Grove performs the catalog handshake, validates the descriptor, pins the catalog revision and stores the row in `grove_connections`; nothing else is stored. Developers can list connections; only owners change them.

```sh
npm run grove -- connections add my-app --endpoint https://api.my-app.example/grove-admin/v1
npm run grove -- connections list
npm run grove -- connections remove my-app
```

API, under the workspace base: `GET /connections`, `POST /connections {id, endpoint}` (201 when something changed), `DELETE /connections/:id`. A host loads every registered connection when the workspace's connection set changes, skips one whose catalog revision no longer matches, and reports the reason; re-registering reviews and pins the new revision.

## Role grants and workspace config

Module permissions are `admin:<module>:…` names. Owners hold them all; everyone else needs a grant. Two kinds exist: per-member grants on the membership record, and **role grants**, which give every member with a role a set of module permissions for the workspace (`GET/PUT /role-grants`, `grove role-grants get|set`). Role grants never include CMS permissions; those always come from the role itself.

A **workspace config** pushes schema, connections and role grants from the client repository in one reviewed step, with a dry run that reports the plan:

```ts
// grove.config.ts in the client repository
import schema from './schema.js';
export default { formatVersion: 1, schema, connections: [{ id: 'my-app', endpoint: 'https://api.my-app.example/grove-admin/v1' }], roleGrants: { editor: ['admin:my-app:orders:read'], publisher: ['admin:my-app:orders:read', 'admin:my-app:orders:manage'] } };
```

```sh
npm run grove -- config push grove.config.ts --expected 3 --dry-run
npm run grove -- config push grove.config.ts --expected 3
```

`PUT /config` applies it. Each part is authorized by its own service (schema: `schema:write`; connections: `connections:write`; role grants: `members:write`). Omitting a part leaves it untouched. Connections listed are registered or re-registered, never removed by omission. Role grants are replaced as a whole. Members are never part of the config: people change outside deploys.

## Limits in this version

- Pending (`running`) outcomes are polled inside the request; there is no background reconciliation yet, so a long-running application operation ends as uncertain.
- The endpoint check refuses private hosts by name and address literal; DNS rebinding is not defended against.
- One catalog revision per connection; refreshing a changed catalog is a re-registration.
- Connections are loaded per workspace on demand and cached until the connection set changes; there is no background health check.
