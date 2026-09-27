import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localStorage, s3Storage, type StorageAdapter } from '@eclosion-tech/grove/server';
import type { Scope } from '@eclosion-tech/grove';

/** Operator-installed modules are trusted server code, like admin modules. Never load a browser-supplied path. */
export async function hostStorage(scope: Scope, env = process.env, load: (specifier: string) => Promise<{ default?: unknown }> = specifier => import(specifier)): Promise<StorageAdapter> {
  if (env.GROVE_STORAGE_MODULE !== undefined) {
    if (!isAbsolute(env.GROVE_STORAGE_MODULE)) throw new Error('GROVE_STORAGE_MODULE must be an absolute local path');
    const module = await load(pathToFileURL(env.GROVE_STORAGE_MODULE).href);
    if (typeof module.default !== 'function') throw new Error('The storage module must export a default adapter factory');
    const adapter = await module.default({ scope });
    if (!adapter || !['put', 'get', 'remove'].every(name => typeof adapter[name] === 'function')) throw new Error('The storage module must implement put, get and remove');
    return adapter;
  }
  return env.GROVE_S3_BUCKET ? s3Storage(env.GROVE_S3_BUCKET, { region: env.AWS_REGION ?? 'auto', endpoint: env.GROVE_S3_ENDPOINT, forcePathStyle: true }) : localStorage(env.GROVE_MEDIA_DIRECTORY ?? '.grove/media');
}
