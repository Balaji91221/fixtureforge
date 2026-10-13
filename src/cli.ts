#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { TicketEnvironment, DomainError, fail } from './domain.ts';
import { runScenario, writeReport } from './scenarios.ts';
import { EnvironmentManager } from './storage.ts';
import { createHttpServer } from './http.ts';
import { serveMcp } from './mcp.ts';
import { runDemo } from './index.ts';

const json=(value:unknown)=>console.log(JSON.stringify(value,null,2));
function options(argv:string[]){
  const result:Record<string,string|boolean>={};
  const allowed=['scenario','dir','run','owner-env','actor-env','port','persist','output','snapshot','actions','milliseconds'];
  for(let i=0;i<argv.length;i++){
    const key=argv[i].replace(/^--/,'');
    if(!argv[i].startsWith('--')||!allowed.includes(key)||Object.hasOwn(result,key))fail('Unknown or duplicate argument');
    if(key==='persist'){result[key]=true;continue;}
    if(!argv[i+1]||argv[i+1].startsWith('--'))fail(`Missing --${key} value`);result[key]=argv[++i];
  }
  return result;
}
function required(opts:Record<string,string|boolean>,name:string){const value=opts[name];if(typeof value!=='string'||!value)fail(`--${name} is required`);return value;}
function credential(opts:Record<string,string|boolean>,kind:'owner'|'actor'){
  const name=String(opts[`${kind}-env`]??`FIXTUREFORGE_${kind.toUpperCase()}_TOKEN`),value=process.env[name];
  if(!value)throw new DomainError('forbidden',`Set credential environment variable ${name}`);return value;
}
async function listen(server:ReturnType<typeof createHttpServer>,port:number,onReady:(port:number)=>void){
  if(!Number.isSafeInteger(port)||port<0||port>65535)fail('Invalid port');
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const actual=(server.address() as {port:number}).port;onReady(actual);
  await new Promise<void>(resolve=>{
    let stopping=false;
    const stop=()=>{if(stopping)return;stopping=true;server.close(()=>resolve());server.closeAllConnections();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    server.once('close',()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();});
  });
}
try{
  const command=process.argv[2]??'demo';
  if(command==='demo')json(runDemo());
  else if(command==='serve'&&(!process.argv[3]||!process.argv[3].startsWith('--'))){
    const env=new TicketEnvironment();
    try{await listen(createHttpServer({environment:env}),Number(process.argv[3]??4317),port=>console.error(`FixtureForge demo listening on http://127.0.0.1:${port}`));}finally{env.dispose();}
  }else{
    const opts=options(process.argv.slice(3));
    if(command==='run'){
      const report=runScenario(JSON.parse(readFileSync(required(opts,'scenario'),'utf8')),opts.actions?JSON.parse(readFileSync(String(opts.actions),'utf8')):undefined);
      if(opts.output)await writeReport(String(opts.output),report);json(report);process.exitCode=report.evaluation.verdict==='PASS'?0:1;
    }else{
      if(!['create','start','serve','snapshot','evaluate','reset','restore','destroy','report','advance','mcp'].includes(command))fail('Commands: demo, run, create, start, serve, snapshot, evaluate, reset, restore, destroy, report, advance, mcp');
      const manager=new EnvironmentManager(required(opts,'dir'));
      const run=String(opts.run??`run-${randomBytes(8).toString('hex')}`);
      let created:ReturnType<EnvironmentManager['create']>|undefined;
      try{
        if(command==='create'||command==='start'){
          created=manager.create(JSON.parse(readFileSync(required(opts,'scenario'),'utf8')),run);
          if(command==='create')json(created);
          else await listen(createHttpServer({manager,defaultRun:run}),Number(opts.port??4317),port=>json({...created,url:`http://127.0.0.1:${port}`,persistent:opts.persist===true}));
        }else{
          required(opts,'run');
          if(command==='serve')await listen(createHttpServer({manager,defaultRun:run}),Number(opts.port??4317),port=>console.error(`FixtureForge listening on http://127.0.0.1:${port}`));
          else if(command==='mcp')await serveMcp(manager,run,credential(opts,'actor'));
          else{
            const owner=credential(opts,'owner');
            if(command==='snapshot')json(manager.snapshot(run,owner));
            if(command==='evaluate'){const result=manager.evaluate(run,owner);json(result);process.exitCode=result.verdict==='PASS'?0:1;}
            if(command==='reset')json(manager.reset(run,owner));
            if(command==='restore')json(manager.restore(run,owner,JSON.parse(readFileSync(required(opts,'snapshot'),'utf8'))));
            if(command==='advance')json({clockMs:manager.advance(run,owner,Number(required(opts,'milliseconds')))});
            if(command==='destroy'){manager.destroy(run,owner);json({destroyed:run});}
            if(command==='report'){const report=manager.report(run,owner);if(opts.output)await writeReport(String(opts.output),report);json(report);}
          }
        }
      }finally{
        if(command==='start'&&created&&opts.persist!==true)manager.destroy(run,created.credentials.ownerToken);
        manager.close();
      }
    }
  }
}catch(error){console.error(JSON.stringify({error:error instanceof DomainError?error.code:'infrastructure',message:String(error)}));process.exitCode=2;}
