import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdminModule } from '@eclosion-tech/grove/server';
import type { Scope } from '@eclosion-tech/grove';

/** What an external admin module exports as its default: a factory the host calls once at startup. */
export type AdminModuleFactory = (input: { scope: Scope; env: NodeJS.ProcessEnv }) => AdminModule[] | Promise<AdminModule[]>;

const bare = /^(@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*(\/[a-zA-Z0-9._-]+)*$/;

/**
 * Loads trusted application modules named in GROVE_ADMIN_MODULES (comma-separated absolute paths or package names).
 * This is host configuration, never request data: the operator decides which code runs in this process.
 */
export async function loadAdminModules(scope: Scope, env: NodeJS.ProcessEnv = process.env): Promise<AdminModule[]> {
  const specifiers = (env.GROVE_ADMIN_MODULES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const modules: AdminModule[] = [];
  const ids = new Set<string>();
  for (const specifier of specifiers) {
    if (!isAbsolute(specifier) && !bare.test(specifier)) throw new Error(`GROVE_ADMIN_MODULES entries must be absolute paths or package names: ${specifier}`);
    const loaded = await import(isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier) as { default?: unknown };
    if (typeof loaded.default !== 'function') throw new Error(`${specifier} must export a default function ({ scope, env }) => AdminModule[]`);
    const result = await (loaded.default as AdminModuleFactory)({ scope, env });
    if (!Array.isArray(result)) throw new Error(`${specifier} returned no module list`);
    for (const module of result) {
      if (!module || typeof module !== 'object' || typeof module.id !== 'string' || !Array.isArray(module.resources)) throw new Error(`${specifier} returned an invalid admin module`);
      if (ids.has(module.id)) throw new Error(`Admin module id ${module.id} is registered twice`);
      ids.add(module.id); modules.push(module);
    }
  }
  return modules;
}
