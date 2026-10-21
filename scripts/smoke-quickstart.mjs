import {execFile, fork} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer} from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const url=process.env.MEMORY_DEMO_DATABASE_URL;
assert.match(new URL(url).pathname,/^\/zhiyu_test_[a-f0-9]{32}$/);
const privateFile=path.resolve('.runtime','smoke-credential-'+process.pid+'.json');
const receiver=createServer((req,res)=>{res.writeHead(200);res.end();});
let child;
try{
 receiver.listen(0,'127.0.0.1');await once(receiver,'listening');
 const env={...process.env,MEMORY_SERVICE_DATABASE_URL:url,MEMORY_SERVICE_PORT:'0',MEMORY_SERVICE_CONSUMER_URL:`http://127.0.0.1:${receiver.address().port}/model`,MEMORY_DEMO_CREDENTIAL_FILE:privateFile};
 const run=async(entry,args=[])=>promisify(execFile)(process.execPath,['--import','tsx',entry,...args],{env,timeout:20000,windowsHide:true});
 await run('apps/service/admin.ts',['init']);
 await run('scripts/demo-seed.ts');
 child=fork('apps/service/main.ts',[],{execArgv:['--import','tsx'],env,stdio:['ignore','ignore','inherit','ipc']});
 const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('service_exited');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('ready_timeout')),20000);timer.unref();})]);
 assert.equal(ready[0].ready,true);
 env.MEMORY_DEMO_ORIGIN=`http://127.0.0.1:${ready[0].port}`;
 const {stdout}=await run('scripts/demo-client.ts');
 const result=JSON.parse(stdout);assert.equal(result.exactRead,true);assert.equal(result.idempotentRetry,true);
 await assert.rejects(run('scripts/demo-seed.ts')); // Existing private token must never be overwritten.
 const output={passed:true,checks:['documented_init_seed_start_client_exact_read_retry_and_seed_overwrite_guard']};
 fs.writeFileSync(process.env.MEMORY_DEMO_RESULT,JSON.stringify(output,null,2));
 console.log(JSON.stringify(output));
}finally{
 if(child && child.exitCode===null){const done=once(child,'exit');child.send('stop');await done;}
 receiver.close();receiver.closeAllConnections();
 if(fs.existsSync(privateFile))fs.unlinkSync(privateFile);
}
