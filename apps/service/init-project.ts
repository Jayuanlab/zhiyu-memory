import postgres from 'postgres';
import {initializeServiceIdentitySchema} from '../../packages/memory-postgres/src/service-identity';
const url=process.env.MEMORY_SERVICE_DATABASE_URL;if(!url)throw Error('MEMORY_SERVICE_DATABASE_URL_required');
const sql=postgres(url,{max:1,onnotice:()=>{}});
try{
 await initializeServiceIdentitySchema(sql);
 await sql`CREATE TABLE IF NOT EXISTS general_memory_project_calls_v1(id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,principal_id text NOT NULL,operation text NOT NULL,state text NOT NULL CHECK(state='started'),created_at timestamptz NOT NULL DEFAULT now())`;
 await sql`CREATE TABLE IF NOT EXISTS general_memory_project_call_events_v1(id text PRIMARY KEY,call_id text NOT NULL REFERENCES general_memory_project_calls_v1(id),state text NOT NULL CHECK(state IN ('completed','failed_or_unknown')),created_at timestamptz NOT NULL DEFAULT now())`;
 await sql.unsafe("CREATE OR REPLACE FUNCTION general_memory_project_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable project event'; END $$");
 for(const table of ['general_memory_project_calls_v1','general_memory_project_call_events_v1']){
  await sql`DROP TRIGGER IF EXISTS immutable_project_event ON ${sql(table)}`;
  await sql`CREATE TRIGGER immutable_project_event BEFORE UPDATE OR DELETE ON ${sql(table)} FOR EACH ROW EXECUTE FUNCTION general_memory_project_immutable_v1()`;
 }
 console.log(JSON.stringify({initialized:true,projectBusinessMigrationsRun:false}));
}finally{await sql.end();}
