# @eclosion-tech/grove

Grove is a code-first content workspace and developer-defined administration platform. This package is the reusable core: schema registry, draft/published documents with history, typed references and media, Grove-owned membership and sessions, the admin platform with its action journal, and the signed remote module protocol that lets an application serve its own admin module to a Grove instance.

Entry points:

- `@eclosion-tech/grove` — browser-safe types and schema helpers
- `@eclosion-tech/grove/client` — typed HTTP client
- `@eclosion-tech/grove/editing` — the editing session controller used by the editor
- `@eclosion-tech/grove/server` — services, Fetch handlers, PostgreSQL migrations and storage adapters (server only)
- `@eclosion-tech/grove/remote` — serve an admin module to a Grove instance from your own process; no CMS runtime, no native dependencies

```ts
import { createRemoteModuleHandler, remoteKeyResolver } from '@eclosion-tech/grove/remote';

const handler = createRemoteModuleHandler({
  module,                                   // an ordinary AdminModule
  catalogRevision: 'my-app-3',              // bump when the contract changes
  resolveKey: remoteKeyResolver('https://grove.example.org/.well-known/grove-keys'),
  allow: ({ hostId, scope }) => hostId === 'https://grove.example.org' && (!scope || scope.siteId === 'my-site'),
  ledger,                                   // records outcomes in the same transaction as your mutations
});
```

Source, documentation and the protocol specification live at https://forge.syntropy.chat/Eclosion-Tech/Grove. Licensed under the GNU AGPL v3.
