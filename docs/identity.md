# Identity — sign-in and membership

Recorded 2026-09-26, replacing the 2026-09-17 Syntropy-only design. Grove is a standalone application with its own sign-in, and any OpenID Connect provider can be plugged in, the way Pear ships native email/password by default and takes an OIDC provider by configuration. In both cases membership is Grove's.

## Two questions, two owners

- **Who is this person?** The sign-in method answers: Grove's native accounts, or an OpenID Connect provider. Either way the host ends up with a stable subject, an email address and whether that address is verified.
- **What may they do here?** Grove's membership table answers, per workspace. Identity providers are never asked for roles.

## Sign-in modes

### Native accounts (default)

`GROVE_AUTH_MODE=password`. Accounts live in `grove_accounts`; passwords are hashed with scrypt (N=32768, r=8, p=1, 64-byte key, 16-byte salt). Nothing is emailed. A workspace owner invites a member by email, then creates a one-time link for them:

```sh
npm run grove -- members invite editor@client.example --role editor
npm run grove -- members link editor@client.example
# → https://grove.example.org/accept#token=…  (valid 7 days, single use)
```

Opening the link shows a set-password screen; accepting it sets the password, binds the membership to the new account and signs the member in. Passwords are 12 to 256 characters. Members change their own password from the sidebar. A forgotten password is reset the same way an account is created: an owner issues a new link. Ten failed sign-ins for one email address lock it for fifteen minutes on that host process. The link is only issued for an address that is already a member, so owners cannot mint accounts for strangers, and a link carries the token in the URL fragment so it never reaches server logs.

### OpenID Connect

`GROVE_AUTH_MODE=oidc`. Grove is a standard relying party: discovery, authorization-code flow with PKCE, `client_secret_post`, userinfo, best-effort token revocation. The provider's discovery document must name the configured issuer.

| Variable | Meaning |
| --- | --- |
| `GROVE_OIDC_ISSUER` | Issuer URL, https outside loopback |
| `GROVE_OIDC_CLIENT_ID`, `GROVE_OIDC_CLIENT_SECRET` | The registered confidential client |
| `GROVE_OIDC_SCOPES` | Space-separated; default `openid email profile` |
| `GROVE_OIDC_TENANT_CLAIM` | Optional dotted claim path that must equal `GROVE_TENANT`, for example `org.id`. Unset means any account the provider vouches for may hold a membership |

Register `https://<grove-host>/auth/callback` as the redirect URI. Grove requests no refresh token: it never acts on the member's behalf against the provider. If userinfo fails, the id_token that arrived directly from the token endpoint is used after its issuer, audience and expiry are checked.

**Syntropy Auth preset.** Register a confidential client in the Syntropy dashboard against the client organization's **org-level** user pool, then:

```dotenv
GROVE_AUTH_MODE=oidc
GROVE_OIDC_ISSUER=https://auth.syntropy.chat
GROVE_OIDC_SCOPES=openid email profile org
GROVE_OIDC_TENANT_CLAIM=org.id
GROVE_TENANT=<the Syntropy organization id>
```

Syntropy's `org` claim carries the pool owner's id, so accounts from another organization, or from a project-level pool, are refused. Syntropy supplies no role; membership below applies unchanged. Anything Syntropy-specific beyond configuration, such as organization membership sync or the dashboard module, belongs in a Syntropy edition outside this repository, as pear-cloud extends Pear.

### Development host

`npm run dev:local` and `npm run dev` keep the development token and practice roles. The deployable host refuses both.

## Membership

`grove_members` holds one row per invited email per tenant, site and environment with a role and optional explicit `admin:<module>:<capability>` grants.

| Role | CMS permissions |
| --- | --- |
| viewer | read schema, content, media, delivery |
| editor | viewer plus edit content, write media |
| publisher | editor plus publish, delete media |
| developer | publisher plus write schema, read members |
| owner | everything, including managing members and every `admin:*` permission |

Extra `permissions` on a member are application-module grants only; CMS capabilities always come from the role. Owners can also set **role grants** for the workspace, module permissions every member with a given role holds, so a module does not have to be granted person by person; see [remote modules](remote-modules.md). Developers additionally read remote module connections (`connections:read`); only owners register them (`connections:write`). Owners manage members. A workspace must keep at least one signed-in owner: the last accepted owner cannot be removed or demoted, while a pending owner invitation can always be corrected.

An invitation is keyed by email. On the first sign-in whose verified email matches, the invitation binds to that identity's subject and is matched by subject from then on, so a later email change does not lock the member out and another account with the same address cannot take the seat.

## Sessions and the operator token

Sessions are server-side rows in `grove_sessions` identified by a random 256-bit id of which only a SHA-256 hash is stored. Eight hours, HttpOnly, SameSite=Strict, Secure on https. Browser writes require the session's CSRF token and a matching Origin. OIDC sign-in attempts live ten minutes in a Lax cookie scoped to `/auth` and are consumed once. A session whose membership has been removed is revoked on the next session read.

`GROVE_OPERATOR_TOKEN` is an optional server-only bearer credential for CI schema pushes and first-owner bootstrap. It authenticates as the `operator` actor, which holds every permission in the configured scope, is never a member, and can never sign in through the browser.

## Deploying

```dotenv
DATABASE_URL=postgres://...
GROVE_PUBLIC_URL=https://grove.example.org
GROVE_TENANT=<workspace tenant id>
GROVE_SITE=<site slug>
GROVE_ENVIRONMENT=production
GROVE_OPERATOR_TOKEN=<random, at least 32 characters>
GROVE_AUTH_MODE=password              # or oidc plus the GROVE_OIDC_* variables above
# Media: GROVE_MEDIA_DIRECTORY or the GROVE_S3_* variables from .env.example
# Email: the GROVE_EMAIL_* variables; GROVE_EMAIL_SIGNING_SECRET is required once GROVE_EMAIL_API_KEY is set
# Application modules: GROVE_ADMIN_MODULES, see admin-platform.md
```

`npm run build && npm run host` applies migrations at boot, binds `0.0.0.0` (`GROVE_BIND` overrides) on `PORT`, and only answers requests whose Host header matches `GROVE_PUBLIC_URL`. Bootstrap the first owner with the operator token:

```sh
export GROVE_URL=https://grove.example.org GROVE_TOKEN="$GROVE_OPERATOR_TOKEN" GROVE_TENANT=<tenant> GROVE_SITE=<site> GROVE_ENVIRONMENT=production
npm run grove -- members invite owner@client.example --role owner
npm run grove -- members link owner@client.example        # password mode only
npm run grove -- schema push examples/schema.ts --expected 0
```

In OIDC mode the owner simply signs in; the invitation binds on that first sign-in.

## API and CLI

Membership, under `/v1/tenants/:tenant/sites/:site/environments/:environment/members`:

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/members` | `members:read` |
| POST | `/members` `{email, role, permissions?}` | `members:write` |
| PATCH | `/members/:id` `{role?, permissions?}` | `members:write` |
| DELETE | `/members/:id` | `members:write` |

Sign-in, owned by the host:

| Method | Path | Mode | Behavior |
| --- | --- | --- | --- |
| GET | `/auth/session` | both | Current member, CSRF token and mode, or 401 with `{mode}` |
| POST | `/auth/login` `{email, password}` | password | Same-origin; uniform 401; 429 when locked |
| POST | `/auth/accept` `{token, password}` | password | Consumes the link, sets the password, signs in |
| POST | `/auth/invitations` `{email}` | password | Owner or operator; email must already be a member; returns the one-time URL |
| POST | `/auth/password` `{current, next}` | password | Signed-in member, CSRF required |
| GET | `/auth/login` | oidc | Redirects to the provider |
| GET | `/auth/callback` | oidc | Completes sign-in |
| POST | `/auth/logout` | both | Same-origin, CSRF required; ends the Grove session only |

CLI: `members list|invite|update|remove|link`.

## Verification

`tests/access.test.ts` covers the role map, invitation binding, subject-based authorization through the service, owner protection, input validation, the HTTP routes and the session store. `tests/password.test.ts` covers scrypt hashing, uniform verification, single-use and expiring links, the accept flow, CSRF on password changes and link minting, lockout, non-member refusal and revocation on removal. `tests/oidc.test.ts` runs the complete flow against a stand-in provider: discovery issuer check, PKCE and state, cookie attributes, invitation binding, restart persistence, tenant-claim binding on and off, tampered state, failed exchanges, the id_token fallback's issuer/audience/expiry checks, the operator token, logout, expiry and removal. All run against real PostgreSQL.

## Limits and remaining work

- No OIDC sign-in has been exercised against a live provider; one real sign-in, Syntropy Auth first, is the acceptance step before a client uses that mode.
- One workspace per deployment. No members screen in the editor; the CLI and API are the management surface. No per-site API tokens beyond the operator credential.
- The sign-in lockout is per host process and per email address; there is no request-level rate limit.
- Invitation links are handed over by the owner, not emailed. Adding email delivery would be an optional adapter, not a requirement.
- No browser QA has been performed on the sign-in, invitation or change-password screens.

## Syntropy project media storage

For hosted Grove instances, set `SYNTROPY_BLOB_API_KEY` to a Syntropy project secret with `blobs:read` and `blobs:write` scopes. `SYNTROPY_BLOB_API_URL` defaults to `https://www.syntropy.chat/api/v1/blobs`. This storage adapter takes precedence over local or direct S3 configuration, keeps bucket credentials in Syntropy, and uses short-lived signed transfers within the owning project. It is a storage option selected by configuration, independent of the sign-in mode. See `deploy/worm/README.md`.
