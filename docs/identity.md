# Production identity — Syntropy Auth host

Recorded 2026-09-17. This decides the "Syntropy host" milestone from [spec.md](spec.md) as far as identity and authorization go. It was verified against a conforming stand-in OIDC provider and real PostgreSQL, not yet against a registered client on a live Syntropy Auth instance.

## What Syntropy provides, and what it does not

Syntropy has three identity systems. Auth0 signs in dashboard staff. Syntropy Auth is the OIDC provider for products built on the platform. Project API keys identify servers. A hosted Synapp receives no gateway headers, no shared cookie and no session-validation API; the supported path is an ordinary OIDC login against Syntropy Auth with a registered client. That login yields a stable subject, a verified email and the organization that owns the user pool. It yields no role: dashboard admin/member roles live in a separate user directory that no API exposes.

## Decision

- **Identity:** Syntropy Auth, authorization-code flow with PKCE, through the published `@eclosion-tech/syntropy-auth` client. Scopes `openid email profile org`; no refresh token, because Grove never acts on the user's behalf against Syntropy. Access tokens are revoked after the identity is read.
- **Authorization:** Grove-owned membership. `grove_members` holds one row per invited email per tenant/site/environment with a role and optional explicit `admin:<module>:<capability>` grants. Syntropy says who the person is; Grove says what they may do.
- **Tenancy:** `tenantId` is the Syntropy organization id carried in the `org` claim. Sign-in is refused when the account's pool belongs to a different organization or to a project pool. One deployment serves one organization, because Syntropy user pools and single sign-on are organization-scoped; `siteId` and `environment` are host configuration.
- **Sessions:** server-side in `grove_sessions`, identified by a random 256-bit id of which only a SHA-256 hash is stored. Eight hours, HttpOnly, SameSite=Strict, Secure on https. Browser writes require the session's CSRF token and a matching Origin. Sign-in attempts live ten minutes, are bound to a Lax cookie scoped to `/auth`, and are consumed once.
- **Operator token:** an optional server-only bearer credential for CI schema pushes and first-owner bootstrap. It authenticates as the `operator` actor, which holds every permission in the configured scope, is never a member, and can never sign in through the browser.

## Roles

| Role | CMS permissions |
| --- | --- |
| viewer | read schema, content, media, delivery |
| editor | viewer plus edit content, write media |
| publisher | editor plus publish, delete media |
| developer | publisher plus write schema, read members |
| owner | everything, including managing members and every `admin:*` permission |

Extra `permissions` on a member are application-module grants only; CMS capabilities always come from the role. Owners manage members. A workspace must keep at least one signed-in owner: the last accepted owner cannot be removed or demoted, while a pending owner invitation can always be corrected.

An invitation is keyed by email. On the first sign-in whose verified email matches, the invitation binds to that account's subject and is thereafter matched by subject only, so a later email change at Syntropy does not lock the member out and a different account with the same address cannot take the seat over.

## Deploying

1. In the Syntropy dashboard, Settings → Auth Clients, register a client against the client organization's **org-level** user pool. Redirect URI: `https://<grove-host>/auth/callback`. Allowed origin: `https://<grove-host>`. Keep the client secret server-side.
2. Configure the Synapp environment:

   ```dotenv
   DATABASE_URL=postgres://...
   GROVE_PUBLIC_URL=https://grove.example.org
   GROVE_TENANT=<syntropy organization id>
   GROVE_SITE=<site slug>
   GROVE_ENVIRONMENT=production
   SYNTROPY_AUTH_URL=https://auth.syntropy.chat
   SYNTROPY_AUTH_CLIENT_ID=<client id>
   SYNTROPY_AUTH_CLIENT_SECRET=<client secret>
   GROVE_OPERATOR_TOKEN=<random, at least 32 characters>
   # Media: GROVE_MEDIA_DIRECTORY or the GROVE_S3_* variables from .env.example
   # Email: the GROVE_EMAIL_* variables; GROVE_EMAIL_SIGNING_SECRET is required once GROVE_EMAIL_API_KEY is set
   ```

3. Start with `npm run build && npm run host:syntropy`. The host applies migrations at boot, binds `0.0.0.0` (`GROVE_BIND` overrides) on `PORT`, and only answers requests whose Host header matches `GROVE_PUBLIC_URL`. It refuses `GROVE_DEV_TOKEN`, `GROVE_LOCAL_LOGIN` and `GROVE_PBA_CONFIG`.
4. Invite the first owner with the operator token, then sign in:

   ```sh
   export GROVE_URL=https://grove.example.org GROVE_TOKEN="$GROVE_OPERATOR_TOKEN" GROVE_TENANT=<org id> GROVE_SITE=<site> GROVE_ENVIRONMENT=production
   npm run grove -- members invite owner@client.example --role owner
   npm run grove -- schema push examples/schema.ts --expected 0
   ```

The editor shows **Sign in with Syntropy** when the host offers a login URL. `GET /auth/session` reports the member's email, name, role and CSRF token; `POST /auth/logout` ends the Grove session only and leaves the Syntropy session alone.

## API and CLI

Base: `/v1/tenants/:tenant/sites/:site/environments/:environment/members`.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/members` | `members:read` |
| POST | `/members` `{email, role, permissions?}` | `members:write` |
| PATCH | `/members/:id` `{role?, permissions?}` | `members:write` |
| DELETE | `/members/:id` | `members:write` |

```sh
npm run grove -- members list
npm run grove -- members invite editor@client.example --role editor --permissions admin:registrations:read
npm run grove -- members update <id> --role publisher
npm run grove -- members remove <id>
```

## Verification

`tests/access.test.ts` covers the role map, invitation binding, subject-based authorization through the service, owner protection, input validation, the HTTP routes and the session store, all against real PostgreSQL. `tests/syntropy.test.ts` runs the complete sign-in flow against a stand-in provider that implements discovery, PKCE-checked code exchange, opaque access tokens, an id_token and a userinfo endpoint that can be switched off: PKCE and state, cookie attributes, invitation binding, session persistence across a host restart, CSRF and origin checks on writes, single-use attempts, non-member and unverified and wrong-organization refusals, tampered state, failed exchanges, the id_token fallback's issuer/audience/expiry checks, the operator token, logout, expiry and removal.

## Limits and remaining work

- Not yet exercised against a live Syntropy Auth client. Registering a client for a real organization and completing one sign-in is the acceptance step before any client uses it. Syntropy's userinfo endpoint has been observed failing for hosted apps; the id_token fallback exists for that case.
- One organization per deployment. Serving several organizations from one host needs one auth client per organization and tenant resolution from the request host.
- No members UI in the editor yet; the CLI and API are the management surface. No per-site API tokens beyond the single operator credential.
- Sign-in attempts are stored per `GET /auth/login`; expired attempts are purged on each new sign-in, but there is no rate limit.
- The PBA registrations adapter binds to the local developer actor and is refused on this host until it maps to a member.
- No browser QA has been performed on the sign-in screen.
