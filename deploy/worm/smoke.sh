#!/bin/sh
set -eu
image=${1:?Usage: smoke.sh <built-grove-worm-image>}
prefix=grove-worm-smoke-$(date +%s)-$$
cleanup() {
 docker logs "$prefix-app" 2>&1 | tail -25 || true
 docker rm -f "$prefix-app" "$prefix-api" "$prefix-db" >/dev/null 2>&1 || true
 docker network rm "$prefix" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$prefix" >/dev/null
docker run -d --name "$prefix-db" --network "$prefix" -e POSTGRES_PASSWORD=smoke-test-only -e POSTGRES_DB=grove postgres:16-bookworm >/dev/null
for attempt in $(seq 1 30); do
 if docker exec "$prefix-db" pg_isready -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
docker run -d --name "$prefix-api" --network "$prefix" --entrypoint node "$image" -e 'require("node:http").createServer((q,r)=>{r.setHeader("content-type","application/json");r.end("[]")}).listen(8080,"0.0.0.0")' >/dev/null
docker run -d --name "$prefix-app" --network "container:$prefix-api" \
 -e "DATABASE_URL=postgres://postgres:smoke-test-only@$prefix-db:5432/grove" \
 -e GROVE_PUBLIC_URL=https://admin.worm.so \
 -e GROVE_TENANT=00000000-0000-4000-8000-000000000001 \
 -e GROVE_SITE=worm -e GROVE_ENVIRONMENT=qa \
 -e SYNTROPY_AUTH_URL=https://auth.syntropy.chat \
 -e SYNTROPY_AUTH_CLIENT_ID=smoke-test-client \
 -e SYNTROPY_AUTH_CLIENT_SECRET=smoke-test-secret \
 -e GROVE_OPERATOR_TOKEN=smoke-test-operator-token-32-characters \
 -e WORM_API_URL=http://127.0.0.1:8080 \
 -e WORM_SERVICE_ROLE_KEY=smoke-test-only "$image" >/dev/null
sleep 4
docker exec -i "$prefix-app" node --input-type=module <<'JS'
import http from 'node:http';
import assert from 'node:assert/strict';
const request=(path, options={})=>new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port:4310,path,method:options.method??'GET',headers:{host:'admin.worm.so',...options.headers}},res=>{
 let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
 });req.on('error',reject);req.end(options.body);
});
assert.equal((await request('/')).status,200);
assert.equal((await request('/auth/session')).status,401);
assert.equal((await request('/',{headers:{host:'untrusted.invalid'}})).status,400);
const base='/v1/tenants/00000000-0000-4000-8000-000000000001/sites/worm/environments/qa';
assert.equal((await request(base+'/members')).status,401);
const headers={authorization:'Bearer smoke-test-operator-token-32-characters','content-type':'application/json'};
const invited=await request(base+'/members',{method:'POST',headers,body:JSON.stringify({email:'smoke@example.invalid',role:'owner'})});
assert.equal(invited.status,201,invited.body);
assert.equal((await request(base+'/members',{headers})).status,200);
console.log('PASS: editor, anonymous session, invalid Host rejection, unauthenticated API denial, operator invitation and member read.');
console.log('This uses a disposable PostgreSQL database and stand-in Worm API; it does not verify live OIDC or Worm writes.');
JS
docker exec "$prefix-db" psql -U postgres -d grove -Atc 'SELECT count(*) FROM grove_migrations' | awk '{if ($0 != 4) exit 1; print "PASS: all four Grove database migrations applied."}'
docker inspect --format 'Runtime user: {{.Config.User}}; image: {{.Image}}' "$prefix-app"
