# Syntropy Grove — implementation baseline

Recorded 2026-09-06. This is a local baseline drawn from Pear decisions plus explicitly identified implementation choices, not a claim that a complete product specification existed already.

**Implementation update:** the local structured-editor/Puck slice, typed relationships and image library are implemented. See [Relationships and media](relationships-media.md) for the latest contracts. See [Editor milestone](editor-milestone.md) for current behavior, verification and remaining work; the accepted architecture below remains the baseline.

The subsequent discussion approved a developer-defined administration foundation with optional CMS and application modules. See [Admin platform](admin-platform.md) for the first implementation, scope, and remaining integration work. Application data keeps its authoritative owner.

## Source of truth

- Pear **14982**, “Syntropy CMS — Puck confirmed, Pulp deferred (2026-09-06)”: latest accepted requirements, package/host separation, code-first clarification, priorities, and Grove naming. This overrides conflicting older notes.
- Pear **14967**, “Syntropy CMS direction (decided 2026-09-02)”: schema-as-data registry, JSONB storage, multi-tenant service, client migrations and delivery direction.
- Pear **14966**, “Page-builder library decision: Puck (replaced craft.js)”: Puck choice and client-site `/edit` ownership.
- Pear **14871**, shared site-layer probe: working prior art at `../site-layer-probe`.
- Pear Tasks **394–399**: schema/storage, Puck, delivery, media, and structured editor work. Latest note says no implementation was completed and the detailed spec remained pending.

Only read operations were performed in Pear. No tasks have been marked complete there.

## Accepted product architecture

1. Client repositories own TypeScript schemas, real React components, versioned component manifests, data migrations and authenticated Puck `/edit` routes. Complete API/code paths accompany GUI operations. The shared CMS does not execute arbitrary client JavaScript.
2. The reusable Grove package has separate server/client exports. It runs independently with Postgres, host-supplied identity/authorization, S3-compatible storage and job adapters. A thin, separately deployed Synapp hosts the CMS API and structured editor. Syntropy's dashboard module supplies setup/access/usage/navigation.
3. One shared multi-tenant service/database initially. Every resource is scoped by tenant, site and environment. Production identity is decided in [Identity](identity.md): Grove signs members in natively or through any OpenID Connect provider (Syntropy Auth is a preset), and Grove-owned membership decides what they may do.
4. Schemas are versioned data, pushed by CI/CLI/MCP with expected versions and diffs. AI schema changes must reconcile to the client repo. Adding ordinary fields needs no database migration or Grove deployment.
5. Puck provides composition and its built-in rich-text fields. Pulp is deferred. The actual persisted Puck rich-text representation must be verified before defining its storage contract; the older blanket “Tiptap JSON” requirement is superseded.
6. Editorial drafts and operational service state have distinct owners. Publishing or restoring CMS content must never restore historical stock, enrollment, payment, or integration state. Sites resolve live operational data through the owning service.
7. AI is optional, authenticated through the same operations, draft-first, attributable, reviewable, cancellable and budgeted. Core editing works without AI.

## Implemented first slice

### Registry

Each `(tenantId, siteId, environment)` has monotonically versioned schema snapshots. Version 0 means absent. Schema writes require `expectedVersion`. Dry runs return changes without writing. Potentially breaking changes require explicit `allowBreaking`; the flag acknowledges the diff and does not perform content migration.

Supported fields: `string`, `text`, `number`, `boolean`, opaque `json`, `reference`, and `image`; each may be localized, required, and have a default. Required fields are enforced at publish; type checking applies to drafts. `json` is generic data, not a validated Puck document contract. Reference and image fields support single or ordered multiple selections. Generic array/object field editors remain future work.

Field removals retain values in drafts and history. Publishing projects onto the current type's defined fields. Existing published snapshots remain pinned to the schema version used at publication. Renames are modeled as remove/add until explicit migration tooling exists. A document must be saved against the current registry before it can publish after a schema change.

### Documents and concurrency

Stable document IDs identify one envelope with separate draft and published JSONB snapshots. This envelope model is an implementation choice replacing the older draft-ID suggestion while preserving draft/published separation.

- Create requires `expectedRevision: 0`; every save, publish, unpublish or restore increments the document revision once.
- Save accepts a top-level field patch. Omitted fields survive; `null` clears values. Localized maps are replaced as one field, so clients merge locale maps before saving. Defaults are applied only on creation.
- Every mutation adds an actor-attributed history snapshot in the same transaction.
- Publish copies validated draft fields to the published snapshot. Later edits and restores cannot change it.
- Restore copies a chosen historical draft into a new revision, validates against the current registry, and never publishes implicitly. Schema-incompatible history needs a migration before restore.
- Required localized fields need the default locale before publication. Translation completeness is not required in this slice.
- Transactions acquire a scope advisory lock before reading/changing registry or documents. Conflicting writers return 409 after checking expected versions. Scope-level serialization favors correctness for initial workloads; narrower locks are future work if contention warrants them.

The history API is append-only; it has no editing/deletion operation. DB administrator permissions can still alter tables. This is not tamper-proof auditing.

### Localization

Schemas declare locale IDs and a default locale. Without a locale parameter, delivery returns complete maps. With a configured locale, it resolves that locale, then the default locale, then null. Null/missing values fall back; an explicitly empty string does not. Locale fallback uses the published schema revision, so a registry change cannot silently alter live content.

This is field localization for structured records. Independent per-locale Puck pages, translation groups, staleness metadata and per-locale publishing remain to be implemented. No claim is made that one universal industry standard dictates this choice.

### API and host boundary

Base: `/v1/tenants/:tenantId/sites/:siteId/environments/:environment`.

| Method | Relative route | Permission | Operation |
| --- | --- | --- | --- |
| GET | `/schema` | `schema:read` | Latest registry or null |
| PUT | `/schema` | `schema:write` | Push/dry-run with `definition`, `expectedVersion`, optional `dryRun`, `allowBreaking` |
| GET | `/documents` | `content:read` | Bounded ID-ordered list (`type`, `after`, `limit`) |
| GET | `/documents/:id` | `content:read` | Draft and publication metadata |
| PUT | `/documents/:id` | `content:edit` | Field patch with `type`, `data`, `expectedRevision`, `expectedSchemaVersion` |
| POST | `/documents/:id/publish` | `content:publish` | Publish with `expectedRevision` |
| POST | `/documents/:id/unpublish` | `content:publish` | Withdraw with `expectedRevision` |
| GET | `/documents/:id/history` | `content:read` | Descending revisions (`before`, `limit`) |
| POST | `/documents/:id/restore` | `content:edit` | Restore with `targetRevision`, `expectedRevision` |
| GET | `/delivery/:id` | `delivery:read` | Published content only; optional `locale` |
| GET | `/members` | `members:read` | Workspace members and pending invitations |
| POST | `/members` | `members:write` | Invite by email with `role` and optional `admin:*` `permissions` |
| PATCH | `/members/:id` | `members:write` | Change role or permissions; the last signed-in owner is protected |
| DELETE | `/members/:id` | `members:write` | Remove a member or pending invitation |
| GET | `/connections` | `connections:read` | Registered remote admin modules |
| POST | `/connections` | `connections:write` | Register or re-register a remote module by endpoint after a signed catalog handshake |
| DELETE | `/connections/:id` | `connections:write` | Remove a connection |
| GET | `/role-grants` | `members:read` | Module permissions held by every member of a role |
| PUT | `/role-grants` | `members:write` | Replace the workspace's role grants |
| PUT | `/config` | per part | Push a workspace config: schema, connections and role grants, with `dryRun` |

Authentication is required on all routes. Host code verifies credentials and supplies the actor; the service separately authorizes every operation in its scope. Draft data never appears in delivery responses. Errors are JSON with 400/401/403/404/409 codes; unexpected errors are redacted. Bodies are bounded to 1 MB, schema/content to 500,000 characters, and lists/history to 100 records per page. Responses currently use `Cache-Control: no-store` until a propagation contract exists.

The local host uses a single scoped developer token, binds loopback, and refuses production mode. It is not a Syntropy session adapter or a public deployment. The current local host supports bearer credentials and HttpOnly cookie sessions with CSRF/origin checks. The deployable host adds native password or OpenID Connect sign-in, Grove-owned membership and persistent server sessions; see [Identity](identity.md).

## Next milestones and acceptance gates

1. **Editor vertical slice:** schema-generated forms, validation feedback, saved/published status, debounced autosave, conflict recovery, history/restore, search/filter/duplicate/defaults/groups/conditional fields, and client-site preview. A client editor must change, preview, publish and recover content without using the CLI.
2. **Puck integration:** real client components at authenticated `/edit`, verified rich-text format, stable block IDs, component manifest versions and site-shipped migrations. Add media/reference/localized field adapters. Operational blocks store IDs/queries, not copied service state.
3. **References and review:** typed references, where-used visibility, draft reference resolution, expiring review links, locale relationships/staleness, preview isolation and permissions.
4. **Media:** S3-compatible storage adapter, upload/search, localized metadata, crop/focal points, alt text, usage and deletion protection. Revisit old provider assumptions before implementation.
5. **Reliable publication:** transactional outbox, retrying signed webhooks, explicit website propagation state, scheduling early and grouped releases later. Publishing currently commits content only; no claim of downstream propagation is made.
6. **Deployable host:** membership roles, native sign-in and a generic OpenID Connect adapter are implemented; Syntropy Auth is a configuration preset ([Identity](identity.md)). Remaining: one verified sign-in against a live provider, multi-organization deployments, per-site API tokens, a members screen in the editor, storage/job binding, and the Syntropy setup/navigation module.
7. **Migration gate:** field-type inventory and operational field ownership from the client repos, complete export/import, verified restore, integration parity and preview checks. Start with starter/Jenna before paid-client cutover; preserve Stripe/Printful/LearnWorlds ownership. No paid-client migration until recovery is proven.
8. **Optional AI/MCP:** use the same authenticated lifecycle API, reviewable draft diffs, attribution, cancellation and spend controls; first actions translation, alt text, content checks and page composition.

Deferred until demand: simultaneous multiplayer editing, elaborate approval chains, personalization/A-B testing, semantic search, visual schema builder and plugin marketplace.

## Technical references

- [PostgreSQL concurrency control](https://www.postgresql.org/docs/17/mvcc.html) and [explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) inform transaction/lock behavior.
- [Postgres.js](https://github.com/porsager/postgres) is the runtime database driver; SQL values are parameterized.

Open design work is deliberately listed above rather than represented by placeholder adapters or mocked integrations.
