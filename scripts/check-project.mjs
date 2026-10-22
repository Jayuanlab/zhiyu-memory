import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name);
 if(entry.isDirectory()){if(entry.name!=='node_modules')walk(file);}else files.push(file);
}}
for(const dir of ['packages','apps','examples','scripts','docs','skills'])walk(dir);
for(const file of [...files,'README.md','AGENTS.md']){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file));
 // Tests intentionally assert rejection of the replacement character in returned data.
 if(file.endsWith('.md'))assert.ok(!text.includes('\uFFFD'),file+': invalid documentation text');
 if(/\.(ts|mjs)$/.test(file))assert.ok(!/^\s*(?:import|export)\b[^\n]*(?:from|import\s*\()[^\n]*(?:@\/|next\/|apps\/web|lib\/brain|work-runtime)/m.test(text),file+': application dependency');
}
assert.ok(fs.readFileSync('README.md','utf8').includes('独立记忆服务'));
console.log(JSON.stringify({dependencyIsolation:true,utf8:true,files:files.length}));
