import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@eclosion-tech/grove/client';
import type { MemberRole, Schema } from '@eclosion-tech/grove';

// JSON schemas are data; TypeScript schema modules are trusted code executed only in the client repo.
const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const integer = (name: string) => {
  const value = flag(name);
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Provide --${name} <non-negative integer>`);
  return Number(value);
};
const usage = `Grove — code-first content operations

Environment: GROVE_URL, GROVE_TOKEN, GROVE_TENANT, GROVE_SITE, GROVE_ENVIRONMENT

schema get
schema push <schema.ts|schema.json> --expected <version> [--dry-run] [--allow-breaking]
documents list [--type <name>] [--after <id>] [--limit <n>]
documents get <id>
documents where-used <id> [--offset <n>]
documents migrate <id> <snapshots.json> --expected <revision> --schema <version>
documents save <id> <patch.json> --type <name> --expected <revision> --schema <version>
documents publish|unpublish <id> --expected <revision>
documents history <id> [--before <revision>] [--limit <n>]
documents restore <id> --revision <historical-revision> --expected <current-revision>
admin modules
admin query <module> <resource> [--input <query.json>]
admin get <module> <resource> --record <id>
admin action <module> <resource> --action <name> --record <id> --expected <version> --request <unique-id> [--input <values.json>]
admin activity <module> <resource>
media list [--search <text>] [--after <id>] [--limit <n>] [--archived]
media upload <image-file>
media get|where-used <id>
media update <id> <metadata.json> --expected <revision>
media archive|restore <id> --expected <revision>
delivery <id> [--locale <locale>]
members list
members invite <email> --role <owner|developer|publisher|editor|viewer> [--permissions <admin:module:capability,...>]
members update <id> [--role <role>] [--permissions <admin:module:capability,...>]
members remove <id>

Use expected version 0 to create a schema or document. Restore always creates a draft.
Members sign in through the host's identity provider; an invitation binds to their account on first verified sign-in.
`;
async function main() {
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(usage); return; }
  if (!process.env.GROVE_TOKEN) throw new Error('Set GROVE_TOKEN (never pass credentials on the command line)');
  const client = createClient({
    baseUrl: process.env.GROVE_URL ?? 'http://127.0.0.1:4310',
    scope: { tenantId: process.env.GROVE_TENANT ?? 'local', siteId: process.env.GROVE_SITE ?? 'demo', environment: process.env.GROVE_ENVIRONMENT ?? 'development' },
    headers: () => ({ Authorization: `Bearer ${process.env.GROVE_TOKEN}` }),
  });
  const [action, id, file] = args;
  let output: unknown;
  if (command === 'admin') {
    if (action === 'modules') output = await client.adminModules();
    else if (id && file) {
      const input = flag('input') ? JSON.parse(await readFile(flag('input')!, 'utf8')) : {};
      if (action === 'query') output = await client.adminQuery(id, file, input);
      else if (action === 'get' && flag('record')) output = await client.adminGet(id, file, flag('record')!);
      else if (action === 'activity') output = await client.adminActivity(id, file);
      else if (action === 'action' && flag('record') && flag('action') && flag('request')) output = await client.adminRun(id, file, flag('action')!, { requestId: flag('request')!, recordId: flag('record')!, expectedVersion: integer('expected'), values: input });
      else throw new Error(usage);
    } else throw new Error(usage);
  } else if (command === 'schema' && action === 'get') output = await client.getSchema();
  else if (command === 'schema' && action === 'push' && id) {
    const definition: Schema = id.endsWith('.json') ? JSON.parse(await readFile(id, 'utf8')) : (await import(pathToFileURL(resolve(id)).href)).default;
    output = await client.pushSchema(definition, integer('expected'), { dryRun: args.includes('--dry-run'), allowBreaking: args.includes('--allow-breaking') });
  } else if (command === 'documents' && action === 'list') output = await client.listDocuments({ type: flag('type'), search: flag('search'), after: flag('after'), limit: flag('limit') ? integer('limit') : undefined });
  else if (command === 'documents' && id) {
    if (action === 'where-used') output = await client.whereUsed(id, flag('offset') ? integer('offset') : 0);
    else if (action === 'migrate' && file) output = await client.migrateDocument(id, { ...JSON.parse(await readFile(file, 'utf8')), expectedRevision: integer('expected'), expectedSchemaVersion: integer('schema') });
    else if (action === 'get') output = await client.getDocument(id);
    else if (action === 'history') output = await client.history(id, { before: flag('before') ? integer('before') : undefined, limit: flag('limit') ? integer('limit') : undefined });
    else if (action === 'save' && file) {
      if (!flag('type')) throw new Error('Provide --type');
      output = await client.saveDocument(id, { type: flag('type')!, expectedRevision: integer('expected'), expectedSchemaVersion: integer('schema'), data: JSON.parse(await readFile(file, 'utf8')) });
    } else if (action === 'publish' || action === 'unpublish') output = await client[action](id, integer('expected'));
    else if (action === 'restore') output = await client.restore(id, integer('revision'), integer('expected'));
    else throw new Error(usage);
  } else if (command === 'media') {
    if (action === 'list') output = await client.listMedia({ search: flag('search'), after: flag('after'), limit: flag('limit') ? integer('limit') : undefined, archived: args.includes('--archived') });
    else if (action === 'upload' && id) output = await client.uploadMedia(new Blob([new Uint8Array(await readFile(id))]), basename(id));
    else if (action === 'get' && id) output = await client.getMedia(id);
    else if (action === 'where-used' && id) output = await client.mediaWhereUsed(id, flag('offset') ? integer('offset') : 0);
    else if (action === 'update' && id && file) output = await client.updateMedia(id, { ...JSON.parse(await readFile(file, 'utf8')), expectedRevision: integer('expected') });
    else if (action === 'archive' && id) output = await client.archiveMedia(id, integer('expected'));
    else if (action === 'restore' && id) output = await client.restoreMedia(id, integer('expected'));
    else throw new Error(usage);
  } else if (command === 'members') {
    const permissions = flag('permissions') === undefined ? undefined : flag('permissions')!.split(',').map(s => s.trim()).filter(Boolean);
    const role = flag('role') as MemberRole | undefined;
    if (action === 'list') output = await client.listMembers();
    else if (action === 'invite' && id && role) output = await client.inviteMember({ email: id, role, permissions });
    else if (action === 'update' && id && (role || permissions)) output = await client.updateMember(id, { role, permissions });
    else if (action === 'remove' && id) output = await client.removeMember(id);
    else throw new Error(usage);
  } else if (command === 'delivery' && action) output = await client.deliver(action, flag('locale'));
  else throw new Error(usage);
  console.log(JSON.stringify(output, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
