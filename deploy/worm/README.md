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

Use a dedicated Grove PostgreSQL database and a private S3 bucket. Synapp service
containers do not expose persistent local media mounts; the default local media
directory must not be used for this deployment. `GROVE_S3_BUCKET` is required,
with credentials limited to that bucket. See `docs/identity.md` for the
remaining runtime variables and acceptance procedure.

The approved pilot origin is `https://admin.worm.so`; the initial owner is
`kara@worm.so`. The selected Worm API and data environment must be verified
before deploying or running any administrative action.

## Container smoke test

```sh
sh deploy/worm/smoke.sh <built-image>
```

This creates a disposable PostgreSQL container and a stand-in Worm API on a
private Docker network. It checks the editor, session endpoint, Host validation,
unauthenticated API denial, operator membership invitation, and all four Grove
migrations, then removes the test containers and network. It does not publish
ports, use live credentials, or certify live OIDC sign-in or Worm actions.

