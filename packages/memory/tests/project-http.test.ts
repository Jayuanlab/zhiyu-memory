import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createMemoryHttpServer,createRemoteMemoryClient} from '../src/http';
import {MemoryError} from '../src/contracts';
test('installed project transport authenticates, refuses browser origin and preserves explicit failures without retry',async()=>{
 let calls=0;
 const server=createMemoryHttpServer({clientForBearer:async(token)=>{
  assert.equal(token,'x'.repeat(43));
  return{capabilities:()=>({project:'synthetic'}),projectCall:async()=>{calls++;throw new MemoryError('synthetic_denied',403,'denied');}} as any;
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
 try{
  assert.equal((await fetch(origin+'/v1/capabilities')).status,401);
  assert.equal((await fetch(origin+'/v1/capabilities',{headers:{authorization:'Bearer '+'x'.repeat(43),origin:'https://untrusted.example'}})).status,403);
  const client=createRemoteMemoryClient(origin,'x'.repeat(43));
  await assert.rejects(client.request('/v1/project/call',{operation:'synthetic',input:{}}),{code:'synthetic_denied',status:403});assert.equal(calls,1);
  assert.equal((await client.request('/v1/capabilities')).project,'synthetic');
 }finally{server.close();server.closeAllConnections();await once(server,'close');}
});
