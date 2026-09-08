# Email workspace

Grove's optional Email workspace provides reusable newsletter/class/event starters,
a Puck composer, HTML and plain-text output, shared image selection/upload,
autosave, history/restore, JSON export, desktop/phone preview, test sends, audience
CSV imports, immediate/scheduled broadcast review, and results.

The initial defaults are neutral. Set the actual client brand and sender in the
host, then save a branded draft and use **Use as template** to start future emails.
Staff must fill the organization's mailing address before sending. The footer and
unsubscribe link are rendered outside the draggable blocks.

## Ownership

`packages/email-builder` (`@eclosion-tech/grove-email`) exports the versioned
email document contract, validator, starter documents, and HTML/plain-text renderer.
Its `/editor` export supplies `createEmailConfig`, with injected media fields/URLs,
so another host can use the same Puck blocks without importing the Grove app.
Only the explicit editor export depends on the Puck UI.

Grove's `email` document type owns drafts and revision history. Add
`emailDocumentType` to the client's code-owned schema. Existing schema/content
API and CLI paths also work for email; the GUI is not required. Local Fieldnotes
seed/upgrade adds this collection without changing existing content ownership.

Syntropy comms owns audiences, subscription status, immutable campaign/recipient
snapshots, queue dispatch, delivery, and results. No Syntropy credential reaches
the browser. The host proxy accepts fixed email operations, not arbitrary target
URLs. Website transactional email remains on its existing integration.

## Local preview

```sh
npm install
npm run dev:local
```

Choose **Email** in the sidebar. Delivery remains disconnected unless explicitly
configured. You can compose, save, preview, duplicate, export and restore drafts.
The existing local host refuses production mode. Its demo role-switching mode
refuses a real email API key; connected email must use token login or a future
verified production host identity adapter.

## Connection

The Syntropy companion branch provides `/api/v1/email-broadcasts/*` and the durable
broadcast dispatcher. Deploy its web/worker changes and configure the worker sweep
before connecting Grove. No Syntropy database migration is required.

Server configuration:

- `GROVE_EMAIL_API_URL`: HTTPS Syntropy origin.
- `GROVE_EMAIL_API_KEY`: project secret with `email:broadcasts:read`,
  `email:broadcasts:write`, `email:broadcasts:send`, and `email:send` for test emails.
- `GROVE_EMAIL_FROM`: a verified sender email address.
- `GROVE_EMAIL_BRAND`: organization/sender display name.
- `GROVE_EMAIL_REPLY_TO`: optional reply address.
- `GROVE_PUBLIC_URL`: stable HTTPS Grove origin for recipient-visible images.
- `GROVE_EMAIL_SIGNING_SECRET`: durable random secret of at least 32 characters.
  Local previews fall back to the dev token. Changing this secret invalidates old
  image links, so back it up and keep it stable when real broadcasts begin.

The host adapter authorizes `admin:email:read`, `admin:email:audiences`, and
`admin:email:send` in addition to Grove's content/media permissions. Signed review
capabilities are bound to actor, tenant/site/environment, exact saved revision,
audience count and compiled content, and expire after 30 minutes. A newer draft
requires a fresh review. Review does not send mail. Repeated confirmation uses the
same submission ID, including after a response is lost. To deliberately repeat an
identical broadcast later, duplicate the draft or create a new revision.

Images become immutable, signed JPEG derivatives in the configured storage adapter.
The snapshot survives source-media archive and changes to CMS publication status.
These derivatives have no automatic deletion; retain them as long as sent emails
must display images. Never expose the private source media bucket. Image alt text
is captured in the rendered email. Email columns use table layout with a narrow
viewport stacking rule. Real Outlook/Gmail/Apple Mail inbox checks remain a release
gate; browser preview is not an email-client compatibility guarantee.

## Audiences and sending

CSV imports map email/name/status columns. They handle quoted commas, escaped
quotes, multiline fields, and BOMs. Supported status aliases include subscribed,
unsubscribed/cancelled, bounced/cleaned, and complained. Unknown statuses block the
import. Missing status explicitly means active, subject to the operator's consent
attestation. Existing suppressions are preserved by the authoritative service.
Imports use resumable batches of up to 1,000 rows, maximum 10,000 rows in the UI.

Broadcasts support up to 10,000 recipients and scheduling within 90 days. The
review shows sender, subject, audience, active count, local send time, and revision.
Syntropy rechecks the audience count at submission and subscription state at actual
delivery. The transaction freezes membership/content before provider work begins.
Later document edits/restores never resend or rewrite a submitted campaign.

Scheduled broadcasts can be cancelled from Results until dispatch starts. This
release has no sequences, automatic provider synchronization, or rescheduling UI. Results reflect the first 100 campaigns; drafts show
the first 100 documents. Open/click values can include privacy proxies and scanners.

## Verification and rollout

`npm run check` runs builds, types, and real PostgreSQL integration tests. Email tests
cover sanitizer/renderer behavior, CSV parsing, saved-revision review, forged and
unauthorized submissions, retry identity, and durable signed images. Network sends
are mocked. Syntropy has separate real-DB/RLS outbox and queue-failure tests.

Before PBA migration, finish the production identity/authorization adapter, configure
the real project and sender, verify public image hosting and secret backup, and run
actual inbox checks with authorized test recipients. Reconcile imported counts and
suppression states before retiring Kit/Mailchimp. No client account, audience, or
live campaign is changed by the implementation tests.
