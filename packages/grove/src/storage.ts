import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';

export interface StorageAdapter {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}
export function localStorage(directory: string): StorageAdapter {
  const root = resolve(directory);
  const path = (key: string) => {
    const file = resolve(root, key);
    if (!file.startsWith(root + sep) || key.split('/').some(p => p.startsWith('.'))) throw new Error('Invalid media storage key');
    return file;
  };
  return {
    async put(key, bytes) { const file = path(key); await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); },
    async get(key) { return readFile(path(key)); },
    async remove(key) { await unlink(path(key)).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
  };
}
/** Credentials stay in the server's standard AWS credential provider chain/config. */
export function s3Storage(bucket: string, options: S3ClientConfig = {}): StorageAdapter {
  const client = new S3Client(options);
  return {
    async put(key, bytes, contentType) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType })); },
    async get(key) { const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })); if (!result.Body) throw new Error('Media object is missing'); return result.Body.transformToByteArray(); },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}
