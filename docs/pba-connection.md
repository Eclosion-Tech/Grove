# PBA registrations connection

Grove's first real application adapter reads PBA's existing staff registration endpoint. Each configured class appears as a named resource in the admin sidebar, with a roster, status filter and record detail view. PBA remains the source of truth: Grove fetches on each query/open, and stores neither a copy nor a CMS revision of the registration.

## Local setup

1. Copy `examples/pba-connection.json` to `.grove/pba-connection.json`. Set the PBA origin, Sanity project ID, the human staff user's Sanity ID, and an allowlist of class document IDs and display labels. The origin is an exact HTTPS origin, or HTTP loopback for local PBA. Credentials, paths, query strings and fragments are rejected. `drafts.` is removed from class IDs. The three scope values must match the Grove host; the example matches `dev:pba`.
2. Create a private, ignored `.env.pba` file with these values. Use distinct credentials for Grove login and upstream staff access:

   ```dotenv
   GROVE_PBA_CONFIG=.grove/pba-connection.json
   GROVE_DEV_TOKEN=<a-new-random-value-at-least-32-characters>
   GROVE_PBA_STAFF_TOKEN=<the-configured-human-staff-users-sanity-token>
   ```

   Restrict the file to your account (`chmod 600 .env.pba`). Keep the actual token out of chat, source code and browser configuration. PBA verifies human Sanity membership and intentionally rejects robot/API tokens and the legacy `INTERNAL_API_SECRET`. A personal token must belong to the exact configured user. Sanity documents its [user-token authentication](https://www.sanity.io/docs/content-lake/http-auth) and [CLI user context](https://www.sanity.io/docs/cli-reference/cli-api).
3. Start the selected PBA environment, then run `npm run dev:pba`. This uses Grove's persistent local PostgreSQL cluster and the existing editor at `http://127.0.0.1:4310`. Log in with `GROVE_DEV_TOKEN`. The upstream token stays in the host process. PBA mode requires token login and disables the demo role switcher. Ordinary `npm run dev:local` remains the practice workspace.

For the existing `.env`/Docker path, add the same three variables to `.env`, ensure `GROVE_LOCAL_LOGIN` is not `1`, and match the connection scope to `GROVE_TENANT`, `GROVE_SITE` and `GROVE_ENVIRONMENT`. Run the usual migration/seed and `npm run dev` commands. This is still a localhost development host; it is not a multiuser production identity system.

## Identity and data boundary

The connection binds one Grove actor to one expected human Sanity user and one Grove workspace. Each roster read verifies `/users/me` on the **project's API host**, binds its canonical `sanityUserId` to the configured staff identity, and matches its project-scoped `id` to project membership. A global-host user ID cannot be compared to these membership IDs. Robot users or memberships are rejected. The exact project must grant PBA's accepted `administrator`, `editor` or `developer` role. PBA independently repeats its own staff check when Grove calls `GET /api/internal/affinity-registrations?sanityClassId=...`. Revocations are not cached. No service-role database key or shared browser secret substitutes for that identity.

The existing PBA deployment is `https://positivebehavior.academy`, backed by Sanity project `9y8vqrn2` / dataset `production`. Local private configuration now targets that environment with six upcoming published classes and the verified existing staff identity. This Grove workspace's `development` scope describes the local admin host, not a separate PBA environment. Live verification uncovered a global-versus-project user-ID mismatch in PBA's staff guard; the correction is prepared and tested in the PBA checkout, but must be deployed before its existing endpoint will accept this valid administrator login. No deployed registration records were changed.

The adapter only issues GET requests. It uses a ten-second total read deadline, rejects redirects and bounds response sizes. Source error bodies and credentials are not forwarded or logged. Project access is further restricted by the configured class allowlist and Grove's `admin:pba-registrations:read` permission. Personal columns also require `admin:pba-registrations:personal`.

The initial projection includes name, status, creation date, email, phone, paid date/amount in cents and funding approval date. PBA's current endpoint returns intake data too; the adapter receives that response server-side, discards intake answers, and never projects them into Grove records. An upstream summary endpoint would avoid transporting that data altogether. The local host grants the configured owner both read and personal permissions. Demo actors cannot use the connection, even if the host authorizer accidentally permits a resource.

PBA currently returns a full class roster. Grove filters and paginates this bounded response locally (maximum 4 MB / 10,000 records), without caching it. A cursor whose record disappeared or changed out of the selected status requires a first-page reload. Pagination is a changing live view, not a snapshot. Capacity totals and detailed intake are not yet exposed.

## Why confirmations are not enabled yet

The current POST endpoint enforces availability, capacity, payment method and check/FI rules inside PBA, but accepts neither an expected revision nor a durable operation ID. It commits the registration before sending email, so an error can occur after the state change. Grove must not interpret all upstream 409 responses as a rolled-back action or retry them as if nothing happened.

The adapter declares **zero actions**. Forged action requests fail before reaching PBA. `version: 0` satisfies the read-record shape only; it is not an upstream concurrency token and must never be used to enable a write. Enabling staff confirmation requires a PBA-owned contract with an atomic expected-version check, durable operation identity/outcome, and a recoverable notification outcome, followed by explicit role mapping. CMS history and restore must never affect these records.

## Verification

`npm run check` covers identity/project/role checks, scoped class access, contact-field projection, pagination, malformed and oversized responses, error redaction, and the absence of write requests.

An additional opt-in contract test loads PBA's actual GET handler, staff guard, database helper, repository and relevant migrations from a local checkout:

```sh
GROVE_PBA_REPO=/absolute/path/to/PositiveBehaviorAcademy npm run check
```

It creates and drops a uniquely named database in the test cluster (the test account needs database-creation permission). It uses synthetic registrations, intercepts all network requests, supplies a standard Fetch response shim for Next.js, and forbids email/content-write paths. It checks fresh upstream changes, cancelled-record exclusion and revocation at PBA after Grove's preflight. It never reads PBA's environment files or connects to a deployed database. Without the checkout variable this one test is skipped. Passing it proves compatibility with that source checkout, not deployment access or real staff credentials.
