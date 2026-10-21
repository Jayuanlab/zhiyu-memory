import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
const configFile=process.argv[2];if(!configFile)throw Error('private_configuration_path_required');
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.dirname(configFile),statusFile=path.join(dir,'service-status.json'),stopFile=path.join(dir,'service-stop.json');
const secrets=Object.entries(config.env).filter(([k,v])=>/URL|SECRET|TOKEN|PASSWORD/.test(k)&&typeof v==='string'&&v.length>3).map(([,v])=>v);
const clean=s=>secrets.reduce((a,v)=>a.replaceAll(v,'[redacted]'),s);
const status={startedAt:new Date().toISOString(),supervisorPid:process.pid,state:'starting',restarts:0,workerStarted:false};
const save=()=>fs.writeFileSync(statusFile,JSON.stringify({...status,heartbeatAt:new Date().toISOString()},null,2));
let child,stopping=false;
function stop(){stopping=true;status.state='stopping';save();if(child?.connected)child.send('stop');}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const timer=setInterval(()=>{if(fs.existsSync(stopFile)&&!stopping)stop();save();},3000);
try{
 while(!stopping){
  child=fork(path.join(root,'apps/service/main.ts'),[],{cwd:root,execArgv:['--import','tsx','--conditions=react-server'],env:{...process.env,...config.env},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  status.pid=child.pid;status.state='starting';save();
  const startTimer=setTimeout(()=>{if(status.state!=='ready'){status.lastFailure='startup_timeout';child.kill();}},30000);
  child.on('message',m=>{if(m?.ready){clearTimeout(startTimer);status.state='ready';status.port=m.port;status.lastReadyAt=new Date().toISOString();save();}});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>fs.appendFileSync(path.join(dir,'service.log'),clean(b.toString('utf8'))));
  const code=await new Promise(resolve=>{child.once('error',e=>{status.lastFailure=e.code??'spawn_failed';resolve(1);});child.once('exit',resolve);});
  clearTimeout(startTimer);status.lastExitAt=new Date().toISOString();status.lastExitCode=code;status.state=stopping?'stopped':'backoff';save();
  if(!stopping){status.restarts++;await new Promise(r=>setTimeout(r,Math.min(1000*2**Math.min(status.restarts,5),30000)));}
 }
}finally{clearInterval(timer);status.state='stopped';save();}
