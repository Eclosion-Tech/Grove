# Worm Grove runtime

Build with a clean, secret-free Grove checkout as the primary context and a
clean Worm.so checkout as the named `worm` context:

```sh
docker buildx build --platform linux/amd64 \
  --build-context worm=/path/to/Worm.so \
  -f deploy/worm/Dockerfile \
  -t forge.syntropy.chat/eclosion-tech/grove-worm:<release> \
  /path/to/Grove
```

The build compiles the Grove host/editor and the Worm module from source. The
runtime runs as a non-root user, contains production dependencies, and checks
the host's session endpoint without authenticating. Supply runtime secrets
through Syntropy's encrypted service environment, never the build context.

Use a dedicated Grove PostgreSQL database and Syntropy project blob storage.
Set `SYNTROPY_BLOB_API_URL=https://www.syntropy.chat/api/v1/blobs` and
`SYNTROPY_BLOB_API_KEY` to a secret key for the owning project with only
`blobs:read` and `blobs:write` scopes. Syntropy derives the organization/project
prefix from that key and returns 60-second signed object URLs. Bucket credentials
remain in Syntropy. The host limits images to 10 MB and never forwards the project
credential to object storage.

Synapp containers do not expose persistent local media mounts; the default local
media directory must not be used for this deployment. Sign-in uses `GROVE_AUTH_MODE=oidc` with the Syntropy Auth preset from
`docs/identity.md` (issuer `https://auth.syntropy.chat`, scopes including `org`,
tenant claim `org.id`); that document lists the remaining runtime variables.

The approved pilot origin is `https://admin.worm.so`; the initial owner is
`kara@worm.so`. The authorized data environment is production, using `https://api.worm.so`.

## Container smoke test

```sh
sh deploy/worm/smoke.sh <built-image>
```

This creates a disposable PostgreSQL container and a stand-in Worm API on a
private Docker network. It checks the editor, session endpoint, Host validation,
unauthenticated API denial, operator membership invitation, and all five Grove
migrations, then removes the test containers and network. It does not publish
ports, use live credentials, or certify live OIDC sign-in or Worm actions.

