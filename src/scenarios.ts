import { writeFile } from 'node:fs/promises';
import { DomainError, TicketEnvironment, MemoryStore, initialState, validateSnapshot, filterTickets, object, identifier, usersValid, fail } from './domain.ts';
import type { Snapshot, Ticket, TicketFilter, Role, Status } from './domain.ts';

export type Predicate =
  | { kind: 'ticket_count'; where?: TicketFilter; equals: number }
  | { kind: 'ticket'; id: string; fields: Partial<Pick<Ticket, 'title'|'status'|'ownerId'|'assigneeId'|'version'>> }
  | { kind: 'all_closed'; where?: TicketFilter; allowEmpty?: boolean }
  | { kind: 'event_count'; action: string; equals: number }
  | { kind: 'no_duplicate_titles'; ownerId?: string };
export type TaskSpec = { id: string; predicates: Predicate[] };
export type Action = { actor: string; tool: 'create'|'search'|'get'|'update'|'transition'|'close'; args: Record<string, any> };
export type Scenario = {
  schemaVersion: 1; id: string; seed: string; users: Record<string,Role>;
  epochMs?: number; tickMs?: number;
  tickets?: Array<{ title: string; ownerId: string; assigneeId?: string|null; status?: Status }>;
  task: TaskSpec; solvability: 'known-solution'|'intentionally-impossible'|'unverified'; solution?: Action[];
};
function keys(value: Record<string, any>, required: string[], optional: string[] = []) {
  if (required.some(k => !Object.hasOwn(value,k)) || Object.keys(value).some(k => ![...required,...optional].includes(k))) fail('Invalid schema fields');
}
export function validateTask(value: unknown): TaskSpec {
  if (!object(value)) fail('Invalid task'); keys(value,['id','predicates']); identifier(value.id,'task ID');
  if (!Array.isArray(value.predicates) || !value.predicates.length || value.predicates.length > 100) fail('Task needs 1–100 predicates');
  for (const p of value.predicates) {
    if (!object(p)) fail('Invalid predicate');
    if (p.kind === 'ticket_count') {
      keys(p,['kind','equals'],['where']);
      if (!Number.isSafeInteger(p.equals) || p.equals < 0) fail('Invalid expected count');
      filterTickets([],p.where);
      if (p.where?.limit !== undefined) fail('Predicates cannot limit matching tickets');
    } else if (p.kind === 'all_closed') {
      keys(p,['kind'],['where','allowEmpty']); filterTickets([],p.where);
      if (p.where?.status !== undefined) fail('all_closed cannot filter on status');
      if (p.where?.limit !== undefined || (p.allowEmpty !== undefined && typeof p.allowEmpty !== 'boolean')) fail('Invalid all_closed predicate');
    } else if (p.kind === 'ticket') {
      keys(p,['kind','id','fields']); identifier(p.id,'ticket ID');
      if (!object(p.fields) || !Object.keys(p.fields).length || Object.keys(p.fields).some(k => !['title','status','ownerId','assigneeId','version'].includes(k))) fail('Invalid ticket predicate');
      if (p.fields.title !== undefined && typeof p.fields.title !== 'string') fail('Invalid expected title');
      if (p.fields.status !== undefined && !['open','in_progress','closed'].includes(p.fields.status)) fail('Invalid expected status');
      if (p.fields.version !== undefined && (!Number.isSafeInteger(p.fields.version) || p.fields.version < 1)) fail('Invalid expected version');
      if (p.fields.ownerId !== undefined && typeof p.fields.ownerId !== 'string') fail('Invalid expected owner');
      if (p.fields.assigneeId !== undefined && p.fields.assigneeId !== null && typeof p.fields.assigneeId !== 'string') fail('Invalid expected assignee');
    } else if (p.kind === 'event_count') {
      keys(p,['kind','action','equals']);
      if (!['create','update','transition','clock_advance'].includes(p.action) || !Number.isSafeInteger(p.equals) || p.equals < 0) fail('Invalid event predicate');
    } else if (p.kind === 'no_duplicate_titles') {
      keys(p,['kind'],['ownerId']); if (p.ownerId !== undefined && typeof p.ownerId !== 'string') fail('Invalid owner');
    } else fail('Unsupported predicate kind');
  }
  return structuredClone(value) as TaskSpec;
}
export function evaluate(snapshotInput: Snapshot, taskInput: TaskSpec) {
  const snapshot = validateSnapshot(snapshotInput), task = validateTask(taskInput);
  const results = task.predicates.map((predicate, index) => {
    let passed = false, actual: unknown, evidence: string[] = [];
    if (predicate.kind === 'ticket_count') {
      const matches = filterTickets(snapshot.tickets,predicate.where); actual = matches.length;
      passed = actual === predicate.equals; evidence = matches.map(t => t.id);
    } else if (predicate.kind === 'ticket') {
      const ticket = snapshot.tickets.find(t=>t.id===predicate.id); actual = ticket ?? null;
      passed = !!ticket && Object.entries(predicate.fields).every(([k,v])=>Object.is(ticket[k as keyof Ticket],v));
      evidence = ticket ? [ticket.id] : [];
    } else if (predicate.kind === 'all_closed') {
      const matches = filterTickets(snapshot.tickets,predicate.where); actual = matches.map(t=>({id:t.id,status:t.status}));
      passed = (matches.length > 0 || predicate.allowEmpty === true) && matches.every(t=>t.status==='closed'); evidence = matches.map(t=>t.id);
    } else if (predicate.kind === 'event_count') {
      const matches = snapshot.events.filter(e=>e.action===predicate.action); actual = matches.length; passed = actual === predicate.equals;
      evidence = matches.map(e=>`event:${e.sequence}`);
    } else {
      const matches = snapshot.tickets.filter(t=>predicate.ownerId===undefined || t.ownerId===predicate.ownerId);
      const seen = new Set<string>(); const duplicates: string[] = [];
      for (const ticket of matches) { const key=JSON.stringify([ticket.ownerId,ticket.title]); if(seen.has(key)) duplicates.push(ticket.id); seen.add(key); }
      actual = duplicates; passed = duplicates.length===0; evidence = duplicates;
    }
    return { index, predicate, passed, actual, evidence };
  });
  return { schemaVersion:1, taskId:task.id, verdict: results.every(r=>r.passed) ? 'PASS' as const : 'FAIL' as const, results };
}
export function dispatch(env: TicketEnvironment, actor: string, tool: string, args: Record<string, any>) {
  if (!object(args)) fail('Tool arguments must be an object');
  if (tool==='create') { keys(args,['title'],['operationKey']); return env.create(actor,args.title,args.operationKey); }
  if (tool==='search') { keys(args,[],['query','status','ownerId','assigneeId','limit']); return env.search(actor,args); }
  if (tool==='get') { keys(args,['id']); return env.get(actor,args.id); }
  if (tool==='update') { keys(args,['id','patch','expectedVersion']); return env.update(actor,args.id,args.patch,args.expectedVersion); }
  if (tool==='transition') { keys(args,['id','status','expectedVersion']); return env.transition(actor,args.id,args.status,args.expectedVersion); }
  if (tool==='close') { keys(args,['id','expectedVersion']); return env.closeTicket(actor,args.id,args.expectedVersion); }
  fail('Unknown tool');
}
export function loadScenario(value: unknown, verifySolution = true): { scenario: Scenario; snapshot: Snapshot } {
  if (!object(value)) fail('Invalid scenario');
  keys(value,['schemaVersion','id','seed','users','task','solvability'],['epochMs','tickMs','tickets','solution']);
  if (value.schemaVersion!==1) fail('Unsupported scenario version');
  identifier(value.id,'scenario ID'); identifier(value.seed,'seed'); usersValid(value.users);
  const task=validateTask(value.task);
  if (!['known-solution','intentionally-impossible','unverified'].includes(value.solvability)) fail('Invalid solvability label');
  const env=new TicketEnvironment(value.users,value.seed,new MemoryStore(initialState(value.users,value.seed,value.epochMs,value.tickMs)));
  if (value.tickets!==undefined && (!Array.isArray(value.tickets)||value.tickets.length>10000)) fail('Invalid seeded tickets');
  for(const seed of value.tickets??[]) {
    if(!object(seed)) fail('Invalid seeded ticket'); keys(seed,['title','ownerId'],['assigneeId','status']);
    let ticket=env.create(seed.ownerId,seed.title);
    if(seed.assigneeId!==undefined) ticket=env.update(seed.ownerId,ticket.id,{assigneeId:seed.assigneeId},ticket.version);
    if(seed.status!==undefined && seed.status!=='open') env.transition(seed.ownerId,ticket.id,seed.status,ticket.version);
  }
  if(value.solution!==undefined && (!Array.isArray(value.solution)||value.solution.length>1000)) fail('Invalid solution trace');
  for(const action of value.solution??[]) {
    if(!object(action)) fail('Invalid action'); keys(action,['actor','tool','args']);
    if(!Object.hasOwn(value.users,action.actor)||!['create','search','get','update','transition','close'].includes(action.tool)||!object(action.args)) fail('Invalid solution action');
  }
  if(value.solvability==='known-solution' && !Array.isArray(value.solution)) fail('Known-solution scenarios require a trace');
  const snapshot=env.snapshot(),scenario=structuredClone({...value,task}) as Scenario;
  if(verifySolution && scenario.solvability==='known-solution') {
    const solved=new TicketEnvironment(scenario.users,scenario.seed,new MemoryStore(snapshot));
    for(const action of scenario.solution!) dispatch(solved,action.actor,action.tool,action.args);
    if(evaluate(solved.snapshot(),task).verdict!=='PASS') throw new DomainError('invalid','Reference solution does not satisfy task predicates');
  }
  return {scenario,snapshot};
}
export function runScenario(value: unknown, actions?: Action[]) {
  const {scenario,snapshot:before}=loadScenario(value);
  const env=new TicketEnvironment(scenario.users,scenario.seed,new MemoryStore(before));
  const trace=[];
  for(const action of actions??scenario.solution??[]) {
    try { trace.push({action,result:dispatch(env,action.actor,action.tool,action.args)}); }
    catch(error) { trace.push({action,error:{code:error instanceof DomainError?error.code:'infrastructure',message:String(error)}}); }
  }
  const after=env.snapshot();
  return {schemaVersion:1,scenarioId:scenario.id,trace,before,after,evaluation:evaluate(after,scenario.task),diff:stateDiff(before,after),timeline:eventTimeline(after)};
}
export function stateDiff(before: Snapshot, after: Snapshot) {
  validateSnapshot(before); validateSnapshot(after);
  const a=new Map(before.tickets.map(t=>[t.id,t])),b=new Map(after.tickets.map(t=>[t.id,t]));
  return {added:after.tickets.filter(t=>!a.has(t.id)),removed:before.tickets.filter(t=>!b.has(t.id)),changed:after.tickets.filter(t=>a.has(t.id)&&JSON.stringify(a.get(t.id))!==JSON.stringify(t)).map(t=>({id:t.id,before:a.get(t.id),after:t}))};
}
export function eventTimeline(snapshot: Snapshot) {
  return snapshot.events.map(e=>({...e,changes:Object.keys(e.after??{}).filter(k=>JSON.stringify(e.before?.[k as keyof Ticket])!==JSON.stringify(e.after?.[k as keyof Ticket])).map(field=>({field,before:e.before?.[field as keyof Ticket]??null,after:e.after?.[field as keyof Ticket]}))}));
}
export async function writeReport(file: string, report: unknown) {
  const escape=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  await writeFile(file,`<!doctype html><meta charset="utf-8"><title>FixtureForge report</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto}pre{white-space:pre-wrap;padding:24px;background:#f1f3f6}</style><h1>FixtureForge state and event evidence</h1><pre>${escape(JSON.stringify(report,null,2))}</pre>`,{flag:'wx',mode:0o600});
}
