import fs from 'node:fs';
import postgres from 'postgres';
import {createServiceIdentityProvider} from '../packages/memory-postgres/src/service-identity';
const url=process.env.MEMORY_SERVICE_DATABASE_URL;
if(!url)throw Error('MEMORY_SERVICE_DATABASE_URL_required');
const sql=postgres(url,{max:1,onnotice:()=>{}});
fs.mkdirSync('private',{recursive:true});
const file=process.env.MEMORY_DEMO_CREDENTIAL_FILE ?? 'private/demo-credential.json';
const fd=fs.openSync(file,'wx',0o600);
try{
 const namespace={tenantId:'demo',projectId:'quickstart'},principalId='demo-reader';
 const allowed=['propose','read','receipt','recall','use'];
 await sql`INSERT INTO demo_dev_members_g4 VALUES(${namespace.tenantId},${namespace.projectId},${principalId},${sql.json(allowed)},'[]'::jsonb) ON CONFLICT(tenant_id,project_id,principal_id) DO NOTHING`;
 const credential=await createServiceIdentityProvider(sql).issue({namespace,principalId},allowed,new Date(Date.now()+3600000).toISOString(),'local-demo-operator');
 fs.writeFileSync(fd,JSON.stringify(credential));
 console.log(JSON.stringify({savedTo:file,expiresAt:credential.expiresAt,reviewPermission:false}));
}finally{fs.closeSync(fd);await sql.end();}
