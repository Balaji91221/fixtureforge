import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TicketEnvironment, EnvironmentManager, loadScenario, evaluate, runScenario, stateDiff, eventTimeline, FixtureMcpServer, validateSnapshot, writeReport, MemoryStore, SQLiteStore } from '../src/index.ts';
const scenario=JSON.parse(readFileSync(new URL('../examples/scenarios/ticket-triage.json',import.meta.url)));
function fixture(fn){const dir=mkdtempSync(path.join(tmpdir(),'fixtureforge-'));const manager=new EnvironmentManager(dir);try{return fn(manager,dir);}finally{manager.close();rmSync(dir,{recursive:true,force:true});}}

test('SQLite persists across independent managers and handles reject stale versions',()=>fixture((manager,dir)=>{
 const run=manager.create(scenario,'one');const a=manager.openActor('one',run.credentials.actorTokens.alice);
 const second=new EnvironmentManager(dir);try{
  const b=second.openActor('one',run.credentials.actorTokens.alice);
  assert.equal(b.call('get',{id:'triage-T1'}).title,'Payment failed');
  a.call('update',{id:'triage-T1',patch:{title:'first'},expectedVersion:1});
  assert.throws(()=>b.call('close',{id:'triage-T1',expectedVersion:1}),/Stale/);
  b.dispose();
 }finally{second.close();}
 a.dispose();const reopened=new EnvironmentManager(dir);try{assert.equal(reopened.snapshot('one',run.credentials.ownerToken).tickets[0].title,'first');}finally{reopened.close();}
}));
test('namespace credentials cannot cross and actor cannot run owner operations',()=>fixture(manager=>{
 const a=manager.create(scenario,'a'),b=manager.create(scenario,'b');
 assert.throws(()=>manager.openActor('b',a.credentials.actorTokens.alice),/Invalid/);
 assert.throws(()=>manager.reset('b',a.credentials.ownerToken),/Invalid owner/);
 assert.throws(()=>manager.destroy('a',a.credentials.actorTokens.alice),/Invalid owner/);
 assert.equal(manager.snapshot('b',b.credentials.ownerToken).tickets.length,1);
 assert.throws(()=>manager.create(scenario,'../escape'),/Invalid environment/);
}));
test('reset restores deterministic baseline and revokes already-open actor handles',()=>fixture(manager=>{
 const run=manager.create(scenario,'one'),client=manager.openActor('one',run.credentials.actorTokens.alice);
 client.call('create',{title:'extra',operationKey:'k'});
 const reset=manager.reset('one',run.credentials.ownerToken);
 assert.deepEqual(reset.snapshot,run.snapshot);
 assert.throws(()=>client.call('search',{}),/revoked/);
 assert.throws(()=>manager.openActor('one',run.credentials.actorTokens.alice),/revoked/);
 const renewed=manager.openActor('one',reset.actorTokens.alice);assert.equal(renewed.call('search',{}).length,1);renewed.dispose();client.dispose();
}));
test('snapshot restore preserves idempotency and rejects invalid state without mutations',()=>fixture(manager=>{
 const run=manager.create(scenario,'one'),client=manager.openActor('one',run.credentials.actorTokens.alice);
 const created=client.call('create',{title:'new',operationKey:'k'}),saved=manager.snapshot('one',run.credentials.ownerToken);
 manager.reset('one',run.credentials.ownerToken);const restored=manager.restore('one',run.credentials.ownerToken,saved);
 const actor=manager.openActor('one',restored.actorTokens.alice);
 assert.deepEqual(actor.call('create',{title:'new',operationKey:'k'}),created);
 assert.deepEqual(manager.snapshot('one',run.credentials.ownerToken),saved);
 const invalid=structuredClone(saved);invalid.nextId=1;
 assert.throws(()=>manager.restore('one',run.credentials.ownerToken,invalid),/next ID/);
 assert.deepEqual(manager.snapshot('one',run.credentials.ownerToken),saved);actor.dispose();client.dispose();
}));
test('failed transaction rolls back fields, version, event, and clock together',()=>fixture(manager=>{
 const run=manager.create(scenario,'one'),client=manager.openActor('one',run.credentials.actorTokens.alice);
 assert.throws(()=>client.call('update',{id:'triage-T1',patch:{title:'should rollback',assigneeId:'missing'},expectedVersion:1}),/Unknown assignee/);
 assert.deepEqual(manager.snapshot('one',run.credentials.ownerToken),run.snapshot);client.dispose();
}));
test('assignment grants scoped access, closed edits and excess fields fail',()=>{
 const e=new TicketEnvironment({alice:'member',bob:'member'});const ticket=e.create('alice','payment');
 assert.equal(e.search('bob',{query:'payment'}).length,0);
 e.update('alice',ticket.id,{assigneeId:'bob'},1);assert.equal(e.search('bob',{query:'PAY'}).length,1);
 e.closeTicket('bob',ticket.id,2);assert.throws(()=>e.update('alice',ticket.id,{title:'changed'},3),/Closed/);
});
test('simulation clock and repeated seeded solutions are deterministic',()=>fixture(manager=>{
 const a=manager.create(scenario,'a'),b=manager.create(scenario,'b');
 manager.advance('a',a.credentials.ownerToken,500);manager.advance('b',b.credentials.ownerToken,500);
 assert.deepEqual(manager.snapshot('a',a.credentials.ownerToken),manager.snapshot('b',b.credentials.ownerToken));
 assert.deepEqual(runScenario(scenario),runScenario(scenario));
 assert.equal(runScenario(scenario).evaluation.verdict,'PASS');
}));
test('task predicates fail incomplete and vacuous claims and reject unknown syntax',()=>{
 const {snapshot}=loadScenario(scenario);assert.equal(evaluate(snapshot,scenario.task).verdict,'FAIL');
 assert.equal(evaluate(snapshot,{id:'empty',predicates:[{kind:'all_closed',where:{query:'no such title'}}]}).verdict,'FAIL');
 assert.throws(()=>evaluate(snapshot,{id:'x',predicates:[{kind:'agent_says_done'}]}),/Unsupported/);
 const impossible=JSON.parse(readFileSync(new URL('../examples/scenarios/impossible.json',import.meta.url)));
 assert.equal(runScenario(impossible).evaluation.verdict,'FAIL');
 const bad=structuredClone(scenario);bad.solution=[];assert.throws(()=>loadScenario(bad),/Reference solution/);
});
test('state diffs and event timelines explain the completed reference trace',()=>{
 const report=runScenario(scenario);assert.equal(report.diff.changed.length,1);
 assert.equal(report.timeline.at(-1).changes.find(c=>c.field==='status').after,'closed');
 assert.deepEqual(stateDiff(report.before,report.after),report.diff);assert.deepEqual(eventTimeline(report.after),report.timeline);
});
test('destroy revokes live handles, closes databases, and removes only owned namespace',()=>fixture((manager,dir)=>{
 const a=manager.create(scenario,'a'),b=manager.create(scenario,'b'),client=manager.openActor('a',a.credentials.actorTokens.alice);
 manager.destroy('a',a.credentials.ownerToken);
 assert.throws(()=>client.call('search',{}),/closed/);assert.equal(existsSync(path.join(dir,'a.sqlite')),false);
 assert.equal(manager.snapshot('b',b.credentials.ownerToken).tickets.length,1);
}));
test('snapshot version and seeded references are validated',()=>{
 const {snapshot}=loadScenario(scenario);assert.throws(()=>validateSnapshot({...snapshot,schemaVersion:1}),/schema/);
 const bad=structuredClone(scenario);bad.tickets[0].ownerId='missing';assert.throws(()=>loadScenario(bad),/cannot access/);
});
test('MCP adapter exposes only actor tools and cannot override actor or namespace',()=>fixture(manager=>{
 const run=manager.create(scenario,'one'),mcp=new FixtureMcpServer(manager,'one',run.credentials.actorTokens.alice);
 try{
  assert.ok(mcp.handle({jsonrpc:'2.0',id:0,method:'tools/list'}).error);
  mcp.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}});
  mcp.handle({jsonrpc:'2.0',method:'notifications/initialized'});
  assert.equal(mcp.handle({jsonrpc:'2.0',id:2,method:'tools/list'}).result.tools.length,6);
  const call=(name,args)=>mcp.handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}});
  assert.equal(call('ticket_search',{}).result.isError,false);
  assert.equal(call('ticket_create',{actor:'admin',title:'x'}).result.isError,true);
  assert.ok(call('reset',{}).error);
  manager.reset('one',run.credentials.ownerToken);assert.equal(call('ticket_search',{}).result.isError,true);
 }finally{mcp.close();}
}));
test('real stdio MCP client lifecycle queries persisted fixture',()=>fixture((manager,dir)=>{
 const run=manager.create(scenario,'one');
 const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ticket_search',arguments:{query:'payment'}}}];
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'mcp','--dir',dir,'--run','one'],{env:{...process.env,FIXTUREFORGE_ACTOR_TOKEN:run.credentials.actorTokens.alice},input:requests.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:5000});
 assert.equal(child.status,0,child.stderr);const responses=child.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(JSON.parse(responses[1].result.content[0].text)[0].id,'triage-T1');assert.ok(!child.stdout.includes(run.credentials.ownerToken));
}));
test('HTML reports escape untrusted content and refuse overwrites',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fixtureforge-report-'));try{const file=path.join(dir,'report.html');await writeReport(file,{title:'<script>alert(1)</script>'});assert.ok(!readFileSync(file,'utf8').includes('<script>'));await assert.rejects(writeReport(file,{}));}finally{rmSync(dir,{recursive:true,force:true});}
});

test('restore requires explicit valid clock fields and rejects noncanonical idempotency keys',()=>fixture(manager=>{
 const run=manager.create(scenario,'one'),actor=manager.openActor('one',run.credentials.actorTokens.alice);
 actor.call('create',{title:'retry safely',operationKey:'retry'});
 const saved=manager.snapshot('one',run.credentials.ownerToken);
 for(const field of ['clockMs','tickMs']) {
  const missing=structuredClone(saved);delete missing[field];
  assert.throws(()=>manager.restore('one',run.credentials.ownerToken,missing),/schema/);
  const undefinedField={...saved,[field]:undefined};assert.throws(()=>validateSnapshot(undefinedField),/clock/);
 }
 for(const key of [' '+saved.operations[0].key,JSON.stringify(['alice','x'.repeat(201)])]) {
  const bad=structuredClone(saved);bad.operations[0].key=key;
  assert.throws(()=>manager.restore('one',run.credentials.ownerToken,bad),/Idempotency/);
 }
 assert.deepEqual(manager.snapshot('one',run.credentials.ownerToken),saved);
 assert.equal(actor.call('create',{title:'retry safely',operationKey:'retry'}).id,'triage-T2');actor.dispose();
}));
test('uncloneable transaction results never commit state in memory or SQLite',()=>fixture((manager,dir)=>{
 const run=manager.create(scenario,'one');
 for(const store of [new MemoryStore(run.snapshot),new SQLiteStore(path.join(dir,'one.sqlite'))]) {
  try {
   assert.throws(()=>store.transact(state=>{state.clockMs++;return ()=>{};}),/clone/i);
   assert.deepEqual(store.read(),run.snapshot);
   if(store instanceof SQLiteStore){assert.throws(()=>store.admin(db=>{SQLiteStore.setMeta(db,'lifecycle','destroyed');return ()=>{};}),/clone/i);assert.deepEqual(store.read(),run.snapshot);}
  } finally {store.close();}
 }
}));
test('all_closed rejects status filters that conceal still-open tickets',()=>{
 const env=new TicketEnvironment();const one=env.create('alice','done');env.closeTicket('alice',one.id,one.version);env.create('alice','pending');
 assert.equal(evaluate(env.snapshot(),{id:'all',predicates:[{kind:'all_closed'}]}).verdict,'FAIL');
 for(const status of ['closed','open','in_progress'])assert.throws(()=>evaluate(env.snapshot(),{id:'all',predicates:[{kind:'all_closed',where:{status}}]}),/filter on status/);
});
