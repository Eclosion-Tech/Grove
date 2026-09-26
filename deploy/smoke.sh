#!/bin/sh
set -eu
image=${1:?Usage: smoke.sh <built-grove-image>}
prefix=grove-smoke-$(date +%s)-$$
cleanup() {
 docker logs "$prefix-app" 2>&1 | tail -25 || true
 docker rm -f "$prefix-app" "$prefix-db" >/dev/null 2>&1 || true
 docker network rm "$prefix" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$prefix" >/dev/null
docker run -d --name "$prefix-db" --network "$prefix" -e POSTGRES_PASSWORD=smoke-test-only -e POSTGRES_DB=grove postgres:17-alpine >/dev/null
for attempt in $(seq 1 30); do
 if docker exec "$prefix-db" pg_isready -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
docker run -d --name "$prefix-app" --network "$prefix" \
 -e "DATABASE_URL=postgres://postgres:smoke-test-only@$prefix-db:5432/grove" \
 -e GROVE_PUBLIC_URL=https://grove.example.test \
 -e GROVE_TENANT=smoke-tenant -e GROVE_SITE=smoke -e GROVE_ENVIRONMENT=qa \
 -e GROVE_AUTH_MODE=password \
 -e GROVE_OPERATOR_TOKEN=smoke-test-operator-token-32-characters \
 -e GROVE_MEDIA_DIRECTORY=/tmp/media "$image" >/dev/null
sleep 4
docker exec -i "$prefix-app" node --input-type=module <<'JS'
import http from 'node:http';
import assert from 'node:assert/strict';
const request=(path, options={})=>new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port:4310,path,method:options.method??'GET',headers:{host:'grove.example.test',...options.headers}},res=>{
 let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
 });req.on('error',reject);req.end(options.body);
});
assert.equal((await request('/')).status,200);
assert.deepEqual(JSON.parse((await request('/auth/session')).body),{mode:'password'});
assert.equal((await request('/',{headers:{host:'untrusted.invalid'}})).status,400);
const keys=JSON.parse((await request('/.well-known/grove-keys')).body);
assert.equal(keys.keys[0].crv,'Ed25519');
const base='/v1/tenants/smoke-tenant/sites/smoke/environments/qa';
assert.equal((await request(base+'/members')).status,401);
const headers={authorization:'Bearer smoke-test-operator-token-32-characters','content-type':'application/json'};
const invited=await request(base+'/members',{method:'POST',headers,body:JSON.stringify({email:'smoke@example.invalid',role:'owner'})});
assert.equal(invited.status,201,invited.body);
assert.equal((await request(base+'/connections',{headers})).status,200);
console.log('PASS: editor, anonymous session, invalid Host rejection, published keys, unauthenticated API denial, operator invitation and connection read.');
JS
docker exec "$prefix-db" psql -U postgres -d grove -Atc 'SELECT count(*) FROM grove_migrations' | awk '{if ($0 != 7) exit 1; print "PASS: all seven Grove database migrations applied."}'
docker inspect --format 'Runtime user: {{.Config.User}}; image: {{.Image}}' "$prefix-app"
