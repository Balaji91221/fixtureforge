import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { DomainError, TicketEnvironment, fail } from './domain.ts';
import { dispatch } from './scenarios.ts';
import { EnvironmentManager } from './storage.ts';

async function body(req:IncomingMessage) {
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=part.length;if(bytes>16384)fail('Request exceeds 16 KiB');chunks.push(part);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createHttpServer(options:{manager:EnvironmentManager;defaultRun?:string}|{environment:TicketEnvironment}) {
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    let dispose=()=>{};
    try{
      const url=new URL(req.url??'/','http://127.0.0.1');let route=url.pathname;
      let call:(tool:string,args:Record<string,any>)=>unknown;
      if('manager' in options){
        const match=route.match(/^\/runs\/([^/]+)(\/.*)$/),run=match?decodeURIComponent(match[1]):options.defaultRun;
        if(!run)throw new DomainError('not_found','Run path required');
        if(match)route=match[2];
        const header=req.headers.authorization;
        if(!header?.startsWith('Bearer '))throw new DomainError('forbidden','Bearer actor credential required');
        const client=options.manager.openActor(run,header.slice(7));dispose=()=>client.dispose();call=(tool,args)=>client.call(tool,args);
      }else{
        // Deliberately insecure identities are available only in the explicitly selected demo mode.
        const actor=String(req.headers['x-fixture-actor']??'');call=(tool,args)=>dispatch(options.environment,actor,tool,args);
      }
      let result;
      if(req.method==='GET'&&route==='/tickets'){
        const filter:Record<string,any>={};for(const [key,value]of url.searchParams){if(Object.hasOwn(filter,key))fail('Repeated filter');filter[key]=key==='limit'?Number(value):value;}
        result=call('search',filter);
      }else if(req.method==='POST'&&route==='/tickets')result=call('create',await body(req));
      else {
        const match=route.match(/^\/tickets\/([^/]+)(\/close)?$/);
        if(!match)throw new DomainError('not_found','Unknown endpoint');
        const id=decodeURIComponent(match[1]);
        if(req.method==='GET'&&!match[2])result=call('get',{id});
        else if(req.method==='PATCH'&&!match[2]){
          const data=await body(req);
          if(Object.hasOwn(data,'id'))fail('Ticket ID belongs in the route, not the body');
          result=Object.hasOwn(data,'status')?call('transition',{id,...data}):call('update',{id,...data});
        }else if(req.method==='POST'&&match[2]){const data=await body(req);if(Object.hasOwn(data,'id'))fail('Ticket ID belongs in the route');result=call('close',{id,...data});}
        else throw new DomainError('not_found','Unknown endpoint');
      }
      res.end(JSON.stringify(result));
    }catch(error){
      res.statusCode=error instanceof DomainError?({forbidden:403,not_found:404,conflict:409,gone:410}[error.code]??400):400;
      res.end(JSON.stringify({error:error instanceof DomainError?error.code:'invalid_request',message:String(error)}));
    }finally{dispose();}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
  return server;
}
