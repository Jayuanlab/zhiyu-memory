import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const adminUrl=process.env.MEMORY_TEST_ADMIN_URL;
if(!adminUrl) throw Error('MEMORY_TEST_ADMIN_URL_required_for_disposable_databases');
const sql=postgres(adminUrl,{max:1,onnotice:()=>{}});
fs.mkdirSync('.runtime',{recursive:true});
const results=[];
try {
 for(const [name,entry] of [['local','examples/memory-project/acceptance.ts'],['remote','examples/memory-project/service-acceptance.ts'],['quickstart','scripts/smoke-quickstart.mjs']]){
  const database='zhiyu_test_'+randomUUID().replaceAll('-','');
  assert.match(database,/^zhiyu_test_[a-f0-9]{32}$/);
  const url=new URL(adminUrl);url.pathname='/'+database;
  let created=false;
  try{
   await sql`CREATE DATABASE ${sql(database)}`;created=true;
   const output=path.resolve('.runtime',name+'-result.json');
   const env={...process.env,MEMORY_TEST_ADMIN_URL:'',MEMORY_SERVICE_DATABASE_URL:'',MEMORY_DEMO_DATABASE_URL:url.href,MEMORY_DEMO_RESULT:output};
   const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',entry],{env,windowsHide:true,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(Error('integration_timeout'));},180000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);resolve(code);});
   });
   assert.equal(code,0,name+'_failed');
   const result=JSON.parse(fs.readFileSync(output,'utf8'));
   results.push({name,...result});
  }finally{if(created) await sql`DROP DATABASE ${sql(database)} WITH (FORCE)`;}
 }
 fs.writeFileSync('.runtime/integration.json',JSON.stringify({passed:true,results},null,2));
 console.log(JSON.stringify({passed:true,suites:results.map(r=>({name:r.name,checks:r.checks.length})),temporaryDatabasesDropped:true}));
}finally{await sql.end();}
