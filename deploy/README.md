# Grove host image

A generic image of the deployable Grove host. It contains no application-specific code: applications serve their admin modules from their own processes and a workspace owner registers the connection at runtime ([remote modules](../docs/remote-modules.md)).

```sh
docker build -f deploy/Dockerfile --build-arg GROVE_REVISION=$(git rev-parse HEAD) -t grove:local .
```

The runtime runs as a non-root user with production dependencies only and checks the host's session endpoint without authenticating. Configure it entirely through the environment described in [identity](../docs/identity.md) and [`.env.example`](../.env.example): a dedicated PostgreSQL database, the public origin, the workspace scope, an operator token, a sign-in mode, and a media storage adapter. Containers have no persistent local media directory, so use an S3-compatible bucket or another configured adapter rather than the default local directory.

## Smoke test

```sh
sh deploy/smoke.sh grove:local
```

This starts a disposable PostgreSQL container on a private network, boots the image in password mode, and checks the editor, the anonymous session endpoint, Host validation, unauthenticated API denial, the published signing keys, an operator invitation, and that every migration applied. It publishes no ports and uses no live credentials.

## Publish through CI

Run **Publish Host Image** (`.forgejo/workflows/publish-host.yml`) with a full
source commit SHA that is already merged into `main`. The workflow uses the
configured `CONTAINER_REGISTRY`, `REGISTRY_USER`, and `REGISTRY_PASSWORD`, builds
the Linux amd64 host, and reports its immutable image digest. It does not deploy
instances. Configure hosts with the reported `@sha256:` reference and a separate
read-only runtime pull credential when the registry is private.
