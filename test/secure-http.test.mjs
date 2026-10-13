import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EnvironmentManager,createHttpServer} from '../src/index.ts';
const scenario=JSON.parse(readFileSync(new URL('../examples/scenarios/ticket-triage.json',import.meta.url)));
test('HTTP scoped credentials share domain semantics and reject route/body overrides',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fixtureforge-http-')),manager=new EnvironmentManager(dir),a=manager.create(scenario,'a'),b=manager.create(scenario,'b');
 const server=createHttpServer({manager});
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(run,method,endpoint,body,token=a.credentials.actorTokens.alice)=>fetch(`${base}/runs/${run}${endpoint}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('b','GET','/tickets')).status,403);
  assert.equal((await request('a','GET','/tickets',undefined,a.credentials.actorTokens.bob)).status,200);
  assert.equal((await (await request('a','GET','/tickets',undefined,a.credentials.actorTokens.bob)).json()).length,0);
  const extra=await (await request('a','POST','/tickets',{title:'Unicode café ✓',operationKey:'k'})).json();
  assert.equal(extra.title,'Unicode café ✓');
  assert.equal((await request('a','PATCH','/tickets/triage-T1',{id:extra.id,patch:{title:'wrong'},expectedVersion:1})).status,400);
  const edited=await(await request('a','PATCH','/tickets/triage-T1',{patch:{title:'Payment resolved',assigneeId:'bob'},expectedVersion:1})).json();assert.equal(edited.version,2);
  const closed=await(await request('a','POST','/tickets/triage-T1/close',{expectedVersion:2},a.credentials.actorTokens.bob)).json();assert.equal(closed.status,'closed');
  assert.equal((await request('a','POST','/tickets/triage-T1/close',{expectedVersion:2},a.credentials.actorTokens.bob)).status,409);
  manager.reset('a',a.credentials.ownerToken);assert.equal((await request('a','GET','/tickets')).status,403);
 }finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});manager.close();rmSync(dir,{recursive:true,force:true});}
});

test('CLI transient start cleans its namespace on SIGTERM and persist retains it',{timeout:10000},async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const {existsSync}=await import('node:fs');
 for(const persistent of [false,true]) {
  const dir=mkdtempSync(path.join(tmpdir(),'fixtureforge-start-'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'start','--scenario',fileURLToPath(new URL('../examples/scenarios/ticket-triage.json',import.meta.url)),'--dir',dir,'--run','owned','--port','0',...(persistent?['--persist']:[])]);
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try {
   const ready=await new Promise((resolve,reject)=>{
    let output='',errors='';const timer=setTimeout(()=>reject(new Error('start timed out: '+errors)),4000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('start exited: '+errors));});
    child.stderr.on('data',data=>{errors+=data;});child.stdout.on('data',data=>{output+=data;try{const result=JSON.parse(output);clearTimeout(timer);resolve(result);}catch{}});
   });
   assert.equal((await fetch(ready.url+'/tickets',{headers:{Authorization:`Bearer ${ready.credentials.actorTokens.alice}`}})).status,200);
   child.kill('SIGTERM');assert.deepEqual(await exited,{code:0,signal:null});
   assert.equal(existsSync(path.join(dir,'owned.sqlite')),persistent);
   if(persistent){const manager=new EnvironmentManager(dir);try{assert.equal(manager.snapshot('owned',ready.credentials.ownerToken).tickets.length,1);manager.destroy('owned',ready.credentials.ownerToken);}finally{manager.close();}}
  } finally {if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}rmSync(dir,{recursive:true,force:true});}
 }
});
