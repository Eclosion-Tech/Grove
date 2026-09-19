import test from 'node:test';
import assert from 'node:assert/strict';
import { syntropyBlobStorage } from '../apps/grove/src/blob-storage.js';
const apiUrl='https://www.syntropy.chat/api/v1/blobs',apiKey='syn_sk_test-only';
const json=(body:unknown,status=200)=>Response.json(body,{status});

test('Syntropy storage keeps the project credential on the API and transfers only signed object headers',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];
 const fetcher:typeof fetch=async (input,init={})=>{
  const url=String(input);calls.push({url,init});
  if(url===apiUrl){const request=JSON.parse(String(init.body));return json(request.operation==='delete'?{ok:true}:{url:'https://objects.invalid/owned/key?signature=test',method:request.operation==='put'?'PUT':'GET',headers:{'content-type':'image/webp','content-length':'3'}});}
  return new Response(init.method==='PUT'?null:new Uint8Array([1,2,3]));
 };
 const storage=syntropyBlobStorage({apiUrl,apiKey,fetcher});
 await storage.put('tenant/site/production/image.webp',new Uint8Array([1,2,3]),'image/webp');
 assert.deepEqual(await storage.get('tenant/site/production/image.webp'),Buffer.from([1,2,3]));
 await storage.remove('tenant/site/production/image.webp');
 assert.equal(calls.filter(c=>c.url===apiUrl).length,3);
 for(const c of calls){assert.equal(c.init.redirect,'error');const headers=new Headers(c.init.headers);assert.equal(headers.get('authorization'),c.url===apiUrl?`Bearer ${apiKey}`:null);}
 assert.deepEqual(JSON.parse(String(calls[0]!.init.body)),{operation:'put',key:'tenant/site/production/image.webp',contentType:'image/webp',contentLength:3});
});

test('storage rejects missing keys, insecure URLs, and unexpected upload credentials',async()=>{
 assert.throws(()=>syntropyBlobStorage({apiUrl:'http://external.invalid',apiKey}),/HTTPS/);
 assert.throws(()=>syntropyBlobStorage({apiUrl,apiKey:'public-key'}),/secret key/);
 const storage=syntropyBlobStorage({apiUrl,apiKey,fetcher:async()=>json({url:'https://objects.invalid/key',method:'PUT',headers:{authorization:'unexpected'}})});
 await assert.rejects(storage.put('image.webp',new Uint8Array([1]),'image/webp'),/Invalid upload headers/);
});

test('storage bounds uploads and streamed downloads to 10 MB',async()=>{
 let requests=0;
 const storage=syntropyBlobStorage({apiUrl,apiKey,fetcher:async input=>{requests++;return String(input)===apiUrl?json({url:'https://objects.invalid/key',method:'GET'}):new Response(new Uint8Array(10*1024*1024+1));}});
 await assert.rejects(storage.put('x',new Uint8Array(10*1024*1024+1),'image/webp'),/10 MB/);assert.equal(requests,0);
 await assert.rejects(storage.get('x'),/10 MB/);
});

test('provider and API errors do not leak signed URLs or credentials',async()=>{
 const denied=syntropyBlobStorage({apiUrl,apiKey,fetcher:async()=>json({error:'secret'},403)});
 await assert.rejects(denied.get('x'),{message:'Syntropy blob storage refused the request (403)'});
 const unavailable=syntropyBlobStorage({apiUrl,apiKey,fetcher:async input=>{if(String(input)===apiUrl)return json({url:'https://objects.invalid/key?signature=secret',method:'GET'});throw Error('signature=secret');}});
 await assert.rejects(unavailable.get('x'),{message:'Blob transfer failed'});
});
