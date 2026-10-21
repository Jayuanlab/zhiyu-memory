import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {createMemoryHttpServer} from '../../packages/memory/src/http';
import {MemoryError} from '../../packages/memory/src/contracts';
import {object,keys,fail} from '../../packages/memory/src/validation';
import {createServiceIdentityProvider} from '../../packages/memory-postgres/src/service-identity';
import type {Identity} from '../../packages/memory/src/ports';

export type InstalledProject = {
 capabilities: unknown;
 operations: Record<string,{permission:string;call:(identity:Identity,input:unknown)=>Promise<unknown>}>;
 ready():Promise<void>;
 close():Promise<void>;
};
const modulePath=process.env.MEMORY_SERVICE_PROJECT_MODULE;
const database=process.env.MEMORY_SERVICE_DATABASE_URL;
if(!modulePath||!path.isAbsolute(modulePath)||!database)throw Error('trusted_project_configuration_required');
const sql=postgres(database,{max:8,onnotice:()=>{}});
const installed=await import(pathToFileURL(modulePath).href);
const project:InstalledProject=await installed.createInstalledMemoryProject();
await project.ready();
await sql`SELECT id FROM general_memory_credentials_g5 LIMIT 0`;
await sql`SELECT id FROM general_memory_project_calls_v1 LIMIT 0`;
await sql`SELECT id FROM general_memory_project_call_events_v1 LIMIT 0`;
const auth=createServiceIdentityProvider(sql);
const unsupported=async()=>fail('facet_not_installed',404);
const server=createMemoryHttpServer({maxBodyBytes:1048576,clientForBearer:async token=>{
 const identity=await auth.authenticate(token);
 return{
  capabilities:()=>({protocol:'general-memory.project.http.v1',...identity.namespace,project:project.capabilities}),
  execute:unsupported,read:unsupported,evidence:unsupported,recall:unsupported,issueUse:unsupported,dispatchRemote:unsupported,useStatus:unsupported,records:{execute:unsupported,read:unsupported},
  projectCall:async value=>{
   const body=object(value);keys(body,['operation','input']);
   if(typeof body.operation!=='string'||!Object.hasOwn(project.operations,body.operation))fail('project_operation_unknown',422);
   const operation=project.operations[body.operation];
   const id=randomUUID();
   // Do not run a business operation if the started audit cannot commit.
   await sql`INSERT INTO general_memory_project_calls_v1(id,tenant_id,project_id,principal_id,operation,state) VALUES(${id},${identity.namespace.tenantId},${identity.namespace.projectId},${identity.principalId},${body.operation},'started')`;
   try{
    const result=await sql.begin(async tx=>{
     await auth.authorize(tx,identity,operation.permission);
     // Hold the identity shared lock across the installed operation; revocation waits for admission.
     return operation.call(identity,body.input);
    });
    await sql`INSERT INTO general_memory_project_call_events_v1(id,call_id,state) VALUES(${randomUUID()},${id},'completed')`;
    return result;
   }catch(error){
    await sql`INSERT INTO general_memory_project_call_events_v1(id,call_id,state) VALUES(${randomUUID()},${id},'failed_or_unknown')`.catch(()=>{});
    if(error instanceof MemoryError)throw error;
    if(error&&typeof error==='object'&&'code'in error&&'status'in error&&typeof error.code==='string'&&Number.isInteger(error.status)&&Number(error.status)>=400&&Number(error.status)<600)throw new MemoryError(error.code,Number(error.status),error.code);
    throw new MemoryError('project_operation_failed_or_unknown',503,'Project operation failed or outcome is unknown');
   }
  },
 };
}});
server.listen(Number(process.env.MEMORY_SERVICE_PORT??3640),'127.0.0.1',()=>{
 const addr=server.address();if(!addr||typeof addr==='string')throw Error('listen_failed');
 const ready={ready:true,port:addr.port,pid:process.pid,mode:'installed_project'};
 if(process.send)process.send(ready);else console.log(JSON.stringify(ready));
});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.close();server.closeIdleConnections();await project.close();await sql.end({timeout:5});process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());process.on('message',m=>{if(m==='stop')void stop();});
