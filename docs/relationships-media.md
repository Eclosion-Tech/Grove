# Relationships and image library — 2026-09-06

Grove stores stable typed references, not copied record titles. Both the structured editor and the client-owned Puck example use shared searchable record/image pickers. A selected title is resolved for display and is never persisted in the reference value.

```ts
{ name: 'author', type: 'reference', to: ['author'] }
{ name: 'relatedArticles', type: 'reference', to: ['article'], multiple: true }
{ name: 'coverImage', type: 'image' }

reference('writer-id', 'author') // {_type:'reference', _ref:'writer-id', _target:'author'}
assetReference('image-id')      // {_type:'asset', _ref:'image-id'}
```

These fields can be localized and required. Multiple selections are ordered, unique arrays (maximum 100). Required empty selections block publishing. Reserved `_type: reference|asset` objects anywhere in JSON, including Puck props, have the same existence/type/scope validation and usage tracking. `_target` names the collection; explicit fields additionally constrain it with `to`. Page component contracts remain owned and validated by the site. Grove does not execute site components or migration code.

Every successful save, restore, publish, unpublish, or data migration updates the relevant usage index in the same transaction. Draft references may point to draft records. Publishing requires referenced records to be published (self-reference is allowed). Published inbound references prevent unpublishing their target. Cyclic unpublished documents need staged links/publication; grouped releases are not implemented. No recursive automatic population is performed: sites resolve references through their content adapter in the appropriate live/preview mode.

Images are decoded with Sharp, limited to still JPEG/PNG/WebP under 10 MB and 25 megapixels, oriented, stripped of metadata and encoded as WebP. The stored binary is immutable; the original is not retained. Metadata includes locale maps for alt text/captions and normalized focal point coordinates. Saving metadata immediately updates every use. This slice has no draft/live split for media metadata or crop rectangle editor. Archives retain binaries and metadata for recovery; permanent purge is not implemented. Current draft/live usage blocks archive. Historical references are revalidated when restoring content; restore an archived image before restoring a draft that uses it.

Local storage creates private directories/files. The S3-compatible adapter uses the AWS credential chain and a private bucket; no browser credentials, ACL changes or cloud provisioning occur. The local host chooses the adapter from `.env.example`. Actual S3/R2 connectivity remains unverified.

## API additions

Base: `/v1/tenants/:tenant/sites/:site/environments/:environment`. All routes authenticate through the host; methods also authorize at the service boundary.

| Method | Path | Permission / behavior |
| --- | --- | --- |
| GET | `/documents?type=&search=&after=&limit=` | `content:read`; title/ID substring search, max 100 per page |
| GET | `/documents/:id/where-used?offset=` | `content:read`; 50 draft/live usages with source and JSON pointer path |
| POST | `/documents/:id/migrate` | `content:edit`, `content:publish`, `schema:write`; explicit transformed draft and published snapshots plus expected revision/schema version |
| GET | `/media?search=&after=&limit=&archived=` | `media:read`; filename search, max 100 per page |
| POST | `/media` | `media:write`; binary body, percent-encoded `X-Grove-Filename` header |
| GET | `/media/:id` | `media:read`; metadata |
| PATCH | `/media/:id` | `media:write`; `expectedRevision`, optional `alt`, `caption`, `focalPoint` |
| GET | `/media/:id/content` | `media:read`; authenticated binary |
| GET | `/media/:id/where-used?offset=` | `media:read` and `content:read` |
| POST | `/media/:id/archive` or `/restore` | `media:delete`; `expectedRevision`; archive checks usage |

The browser client and CLI expose these operations. `mediaContentUrl` uses the host's same-origin cookie session; server clients with bearer credentials must send their headers when fetching that URL. The example site exposes `/example-api/media/:id` with optional `mode=preview` and `metadata=1`. Live media must have published usage; preview requires an editor session. Metadata and binary responses are uncacheable. Media history is recorded internally; an end-user metadata-history browser is not yet exposed.

## Existing demo upgrade

`npm run dev:local` applies database migrations, backs up legacy document envelopes/registry under `.grove/backups`, then runs the trusted `scripts/upgrade-demo.ts`. It upgrades author strings to author records and Puck v1 `documentId` to a v2 `article` reference. Every draft/live snapshot is transformed independently, preserving block IDs and publication timestamps. It never promotes an unpublished page/article draft. New author records used by live articles are published as migration dependencies. Re-running is idempotent, and writes use expected revisions.

The migration endpoint can deliberately transform live content and requires all three permissions; normal saves/restores cannot. History records a `migrate` action. The demo upgrade is per-document transactional, not one atomic multi-document release; an interrupted upgrade can be retried. Schema-invalid data or missing legacy targets require repair before retrying. Old incompatible history stays intact and is not silently coerced during restore. This is a specific demo migration, not a general export/import or paid-client cutover tool.

Verification: real PostgreSQL integration tests cover scope/type enforcement, duplicate selections, draft/live edges, publication protection, image decoding, metadata revisions/locales/focal points, archive/restore, binary permissions and migration idempotency. Browser interactions and live cloud storage still need verification.
