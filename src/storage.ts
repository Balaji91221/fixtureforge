import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, realpathSync, existsSync, lstatSync, openSync, closeSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DomainError, TicketEnvironment, validateSnapshot, identifier, fail } from './domain.ts';
import type { Snapshot, StateStore } from './domain.ts';
import { loadScenario, evaluate, dispatch, stateDiff, eventTimeline } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';
const SCHEMA = 1, APP = 0x46495846;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('hex');
function sameHash(actual:unknown, expected:string) { return typeof actual==='string'&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected)); }

export class SQLiteStore implements StateStore {
  readonly db: DatabaseSync;
  private closed=false;
  private guard?: (db:DatabaseSync)=>void;
  onClose?:()=>void;
  constructor(file:string, guard?: (db:DatabaseSync)=>void) {
    if(!existsSync(file)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()) fail('Database must be an existing regular file');
    this.db=new DatabaseSync(file);
    this.guard=guard;
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const v=(this.db.prepare('PRAGMA user_version').get() as any).user_version;
      const app=(this.db.prepare('PRAGMA application_id').get() as any).application_id;
      if(v!==SCHEMA||app!==APP) fail('Unsupported database schema; preserve and migrate a copy');
    } catch(error) {this.db.close();this.closed=true;throw error;}
  }
  static initialize(file:string, snapshot:Snapshot, metadata:Record<string,unknown>) {
    const fd=openSync(file,'wx',0o600);closeSync(fd);
    const db=new DatabaseSync(file);
    try {
      db.exec('BEGIN IMMEDIATE; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,revision INTEGER NOT NULL);');
      db.prepare('INSERT INTO state VALUES(1,?,1)').run(JSON.stringify(validateSnapshot(snapshot)));
      for(const [key,value] of Object.entries(metadata)) db.prepare('INSERT INTO meta VALUES(?,?)').run(key,JSON.stringify(value));
      db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=${SCHEMA}; COMMIT;`);
    }catch(error){try{db.exec('ROLLBACK');}catch{} db.close();unlinkSync(file);throw error;}
    db.close();chmodSync(file,0o600);
  }
  static meta(db:DatabaseSync,key:string):any {
    const row=db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any;
    if(!row) fail('Missing environment metadata');
    return JSON.parse(row.value);
  }
  static setMeta(db:DatabaseSync,key:string,value:unknown) {db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,JSON.stringify(value));}
  private active() {
    if(this.closed) throw new DomainError('gone','Environment handle is closed');
    if(SQLiteStore.meta(this.db,'lifecycle')!=='active') throw new DomainError('gone','Environment is destroyed');
    this.guard?.(this.db);
  }
  read():Snapshot {
    if(this.closed) throw new DomainError('gone','Environment handle is closed');
    this.db.exec('BEGIN');
    try{this.active();const value=validateSnapshot(JSON.parse((this.db.prepare('SELECT body FROM state WHERE id=1').get() as any).body));this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  transact<T>(fn:(state:Snapshot)=>T):T {
    if(this.closed) throw new DomainError('gone','Environment handle is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.active();const row=this.db.prepare('SELECT body,revision FROM state WHERE id=1').get() as any;
      const state=validateSnapshot(JSON.parse(row.body)), result=fn(state);
      if(result instanceof Promise) fail('Transactions must be synchronous');
      const cloned=structuredClone(result);
      this.db.prepare('UPDATE state SET body=?,revision=revision+1 WHERE id=1 AND revision=?').run(JSON.stringify(validateSnapshot(state)),row.revision);
      this.db.exec('COMMIT');return cloned;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  admin<T>(fn:(db:DatabaseSync)=>T):T {
    if(this.closed) throw new DomainError('gone','Environment handle is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try{this.active();const result=fn(this.db);if(result instanceof Promise)fail('Transactions must be synchronous');const cloned=structuredClone(result);this.db.exec('COMMIT');return cloned;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){if(!this.closed){this.closed=true;this.db.close();this.onClose?.();}}
}
export class ActorClient {
  readonly actor:string;
  private env:TicketEnvironment;
  constructor(actor:string, env:TicketEnvironment){this.actor=actor;this.env=env;}
  call(tool:string,args:Record<string,any>){return dispatch(this.env,this.actor,tool,args);}
  dispose(){this.env.dispose();}
}
export type Credentials={ownerToken:string;actorTokens:Record<string,string>};
export class EnvironmentManager {
  readonly directory:string;
  private handles=new Map<string,Set<SQLiteStore>>();
  private closed=false;
  constructor(directory:string){mkdirSync(directory,{recursive:true,mode:0o700});this.directory=realpathSync(directory);}
  private file(id:string){if(this.closed)throw new DomainError('gone','Manager is closed');identifier(id,'environment ID');return path.join(this.directory,`${id}.sqlite`);}
  private track(id:string,guard?:(db:DatabaseSync)=>void){
    const store=new SQLiteStore(this.file(id),guard),set=this.handles.get(id)??new Set<SQLiteStore>();
    set.add(store);this.handles.set(id,set);store.onClose=()=>set.delete(store);return store;
  }
  private owned(id:string,ownerToken:string){
    const store=this.track(id,db=>{if(typeof ownerToken!=='string'||!sameHash(SQLiteStore.meta(db,'ownerHash'),digest(ownerToken)))throw new DomainError('forbidden','Invalid owner credential');});
    try{store.read();return store;}catch(error){store.close();throw error;}
  }
  private actorCredentials(users:Record<string,unknown>){
    const actorTokens:Record<string,string>={},hashes:Record<string,string>={};
    for(const actor of Object.keys(users)){actorTokens[actor]=token();hashes[actor]=digest(actorTokens[actor]);}
    return {actorTokens,hashes};
  }
  create(spec:unknown,id:string):{id:string;credentials:Credentials;snapshot:Snapshot}{
    const {scenario,snapshot}=loadScenario(spec),file=this.file(id);
    const ownerToken=token(),{actorTokens,hashes}=this.actorCredentials(scenario.users);
    SQLiteStore.initialize(file,snapshot,{lifecycle:'active',scenario,baseline:snapshot,ownerHash:digest(ownerToken),actorHashes:hashes});
    return {id,credentials:{ownerToken,actorTokens},snapshot};
  }
  openActor(id:string,actorToken:string):ActorClient{
    if(typeof actorToken!=='string'||!actorToken)throw new DomainError('forbidden','Missing actor credential');
    let actor='';
    const store=this.track(id,db=>{
      const hashes=SQLiteStore.meta(db,'actorHashes') as Record<string,string>;
      const found=Object.entries(hashes).find(([,hash])=>sameHash(hash,digest(actorToken)))?.[0];
      if(!found|| (actor && actor!==found))throw new DomainError('forbidden','Invalid or revoked actor credential');
      actor=found;
    });
    try{const state=store.read();return new ActorClient(actor,new TicketEnvironment(state.users,state.seed,store));}
    catch(error){store.close();throw error;}
  }
  snapshot(id:string,ownerToken:string){const store=this.owned(id,ownerToken);try{return store.read();}finally{store.close();}}
  evaluate(id:string,ownerToken:string){const store=this.owned(id,ownerToken);try{return evaluate(store.read(),SQLiteStore.meta(store.db,'scenario').task);}finally{store.close();}}
  report(id:string,ownerToken:string){
    const store=this.owned(id,ownerToken);try{const after=store.read(),before=SQLiteStore.meta(store.db,'baseline');
      return {schemaVersion:1,environmentId:id,evaluation:evaluate(after,SQLiteStore.meta(store.db,'scenario').task),before,after,diff:stateDiff(before,after),timeline:eventTimeline(after)};
    }finally{store.close();}
  }
  reset(id:string,ownerToken:string){const store=this.owned(id,ownerToken);try{return store.admin(db=>{
    const baseline=SQLiteStore.meta(db,'baseline') as Snapshot,{actorTokens,hashes}=this.actorCredentials(baseline.users);
    db.prepare('UPDATE state SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(baseline));SQLiteStore.setMeta(db,'actorHashes',hashes);
    return {id,actorTokens,snapshot:baseline};
  });}finally{store.close();}}
  restore(id:string,ownerToken:string,input:unknown){
    const snapshot=validateSnapshot(input),store=this.owned(id,ownerToken);
    try{return store.admin(db=>{
      const baseline=SQLiteStore.meta(db,'baseline') as Snapshot;
      if(snapshot.seed!==baseline.seed || JSON.stringify(Object.entries(snapshot.users).sort())!==JSON.stringify(Object.entries(baseline.users).sort()))fail('Snapshot scenario identity does not match environment');
      const {actorTokens,hashes}=this.actorCredentials(snapshot.users);
      db.prepare('UPDATE state SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(snapshot));SQLiteStore.setMeta(db,'actorHashes',hashes);
      return {id,actorTokens,snapshot};
    });}finally{store.close();}
  }
  advance(id:string,ownerToken:string,milliseconds:number){const store=this.owned(id,ownerToken);try{const s=store.read();return new TicketEnvironment(s.users,s.seed,store).advance(milliseconds);}finally{store.close();}}
  destroy(id:string,ownerToken:string){
    const file=this.file(id),store=this.owned(id,ownerToken);
    try{store.admin(db=>{SQLiteStore.setMeta(db,'lifecycle','destroyed');SQLiteStore.setMeta(db,'actorHashes',{});});}finally{store.close();}
    for(const handle of [...(this.handles.get(id)??[])])handle.close();this.handles.delete(id);
    unlinkSync(file);
    for(const suffix of ['-wal','-shm','-journal'])if(existsSync(file+suffix))unlinkSync(file+suffix);
  }
  close(){for(const handles of this.handles.values())for(const handle of [...handles])handle.close();this.handles.clear();this.closed=true;}
}
export async function createEnvironment(options:{scenario:unknown;directory:string;id?:string}) {
  const manager=new EnvironmentManager(options.directory),id=options.id??`run-${randomBytes(8).toString('hex')}`;
  try{const created=manager.create(options.scenario,id);return {manager,...created};}catch(error){manager.close();throw error;}
}
