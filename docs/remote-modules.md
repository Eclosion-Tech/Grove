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
{ "hostId": "https://grove.example.org", "connectionId": "worm", "scope": { "tenantId": "…", "siteId": "…", "environment": "…" }, "actor": { "id": "<member subject>", "permissions": ["admin:worm:organizations:read"] } }
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

Worm's module is the first consumer: the module built in `grove-admin` mounts unchanged behind this handler on Worm's worker.

## Implementing the Grove side

`remoteModule({ connection, key, authorize })` loads the catalog, validates it, and returns an `AdminModule` that `GroveAdmin` treats like any other. Decisions arrive with records and are consulted by `authorizeRecord` and `available` without further requests. `InstanceKeys` stores the instance's signing keys in Postgres, generating one on first use and supporting rotation with a publication grace period.

## Limits in this version

- Pending (`running`) outcomes are polled inside the request; there is no background reconciliation yet, so a long-running application operation ends as uncertain.
- The endpoint check refuses private hosts by name and address literal; DNS rebinding is not defended against.
- One catalog revision per connection; refreshing a changed catalog is a re-registration.
