# Editor and client-site milestone — 2026-09-06

This implements the next local slice from the decisions captured in `spec.md`.

## What works

- `apps/editor`: schema-generated fields, collection navigation, title search, status filtering, localized field maps, JSON validity blocking, creation, duplication, autosave, save/publish/unpublish, cursor-based history and restore.
- The browser-safe `EditingSession` controller in `@eclosion-tech/grove/editing` serializes saves, retains input typed during a request, and waits for pending saves before publishing. Errors retain local data. Conflicts stop automatic writes.
- Structured conflict recovery fetches the latest document without overwriting the local draft. Users can export their work, load the latest version, or explicitly reapply only their changed fields. Schema conflicts require loading the new schema. Navigation flushes drafts and stops if saving fails; page close/reload warns while work is unsettled.
- History restore saves current pending work before restoring, then creates a new draft. Published content stays unchanged.
- Browser sessions use HttpOnly, SameSite=Strict cookies with an eight-hour expiry, same-origin login, per-session CSRF tokens on mutations, and explicit logout. Default token login and opt-in machine-trusting `dev:local` mode are separate. Production mode is still rejected.
- A persistent dedicated local PostgreSQL cluster and idempotent example seeding are available through `npm run dev:local`.

## Puck example

`apps/example-site` owns its component configuration and version 2 manifest. Grove's hosted package has no dependency on Puck or on client React components. The local host serves the compiled example as a convenience, keeping it a separate workspace/build that can later be embedded in a real client's authenticated `/edit` route.

The example's `mode=edit` route requires a Grove session and uses Puck 0.23.0. Its saved page envelope contains `title`, `locale`, `manifestVersion`, and `layout`. The layout preserves Puck's stable block IDs. The example validates known components, required prop types, IDs, and the manifest version before editing or rendering. Unknown versions fail with a migration message; the trusted site-owned demo migration handles the v1 reference upgrade.

Puck 0.23.0's built-in rich-text editor persists **HTML strings** (`editor.getHTML()` in the installed `Editor-44C53YAG.mjs`), not Tiptap JSON. The example stores those strings verbatim inside the layout. A field transform preserves the string in Puck's canvas; the site's Prose component sanitizes HTML with DOMPurify before rendering. Inline rich-text editing is disabled in this example; the Puck rich-text field remains available in its field panel.

The Article block persists a typed `article` reference and an editorial label. It resolves that document through the example site's content port on render. Live rendering fetches published data; authenticated draft preview fetches draft data for both the page and its article block. Typed references, where-used indexes, and unpublish/archive protection now apply to the block; see [Relationships and media](relationships-media.md).

The Puck editor shares autosave/publish sequencing with the structured editor. On conflict it preserves the local composition and offers export/reload; it does not try to merge Puck block trees. The structured editor provides history and restore for page documents as well as articles.

The root site and articles render from published snapshots. Preview is explicitly labeled, authenticated and uncacheable. Expiring review links for outside reviewers remain future work. Publication here updates Postgres delivery immediately; external website propagation/webhook acknowledgement is not implemented.

## Verification and limits

Automated checks cover compilation, schema/document SQL lifecycle, two concurrent writers, tenant/site/environment isolation, session cookies/CSRF/expiry/logout, CLI over a real HTTP host, static-output boundaries, controller save races/conflicts, manifest validation and draft delivery. A running local server was checked over HTTP.

No connected browser was available for interaction or visual QA. This means Puck drag/drop, rich-text field interactions, responsive layouts and keyboard/focus behavior still need hands-on browser verification. Optional `grove_list_content` and `grove_open_document` WebMCP tools use the same authenticated client and navigation guard; registration is unverified because no supported context was available. Ordinary editing is independent of them.

Still outstanding before a client-ready milestone: a live-verified hosted identity, real client embedding, field groups/conditional fields/advanced validation, per-locale page relationships, expiring review links, scheduling, outbox/webhooks, general client migration tooling, export/import and verified backup restore. The UI currently loads documents in bounded pages and filters titles locally; pickers use bounded server-side title/ID search. The main collection view will need server-side filtering at larger volumes.

References: [Puck field transforms](https://puckeditor.com/docs/extending-puck/field-transforms), [Puck rich-text field](https://puckeditor.com/docs/api-reference/fields/richtext), and the installed Puck 0.23.0 source cited above.
