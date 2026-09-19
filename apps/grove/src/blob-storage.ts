import type { StorageAdapter } from '@eclosion-tech/grove/server';

const maximumBytes = 10 * 1024 * 1024;
function safeUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Blob storage requires HTTPS');
  return url;
}

/** Project-scoped Syntropy storage; provider credentials never enter the Grove runtime. */
export function syntropyBlobStorage(options: { apiUrl: string; apiKey: string; fetcher?: typeof fetch }): StorageAdapter {
  const endpoint = safeUrl(options.apiUrl).toString();
  if (!options.apiKey.startsWith('syn_sk_') || /[\r\n]/.test(options.apiKey)) throw new Error('Set a Syntropy project secret key for blob storage');
  const fetcher = options.fetcher ?? fetch;
  async function operation(input: object): Promise<any> {
    let response: Response;
    try { response = await fetcher(endpoint, { method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error('Syntropy blob storage could not be reached'); }
    if (!response.ok) throw new Error(`Syntropy blob storage refused the request (${response.status})`);
    try { return await response.json(); } catch { throw new Error('Invalid Syntropy blob storage response'); }
  }
  async function transfer(url: string, init: RequestInit = {}) {
    const target = safeUrl(url);
    try {
      const response = await fetcher(target, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('Provider rejected transfer');
      return response;
    } catch { throw new Error('Blob transfer failed'); }
  }
  return {
    async put(key, bytes, contentType) {
      if (!bytes.length || bytes.length > maximumBytes) throw new Error('Choose an image up to 10 MB');
      const signed = await operation({ operation: 'put', key, contentType, contentLength: bytes.byteLength });
      if (signed.method !== 'PUT' || !signed.headers || typeof signed.headers !== 'object') throw new Error('Invalid upload response');
      // Only the signed object headers go to storage. Never forward the project API credential.
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(signed.headers)) {
        if (!['content-type', 'content-length', 'content-disposition', 'cache-control'].includes(name.toLowerCase()) || typeof value !== 'string') throw new Error('Invalid upload headers');
        headers[name] = value;
      }
      await (await transfer(signed.url, { method: 'PUT', headers, body: Buffer.from(bytes) })).body?.cancel();
    },
    async get(key) {
      const signed = await operation({ operation: 'get', key });
      if (signed.method !== 'GET') throw new Error('Invalid download response');
      const response = await transfer(signed.url);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Media object is missing');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > maximumBytes) throw new Error('Media object exceeds 10 MB');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks, length);
    },
    async remove(key) { await operation({ operation: 'delete', key }); },
  };
}
