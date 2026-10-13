import { createInterface } from 'node:readline';
import { DomainError, object, fail } from './domain.ts';
import { EnvironmentManager, ActorClient } from './storage.ts';
const versions=['2024-11-05','2025-03-26','2025-06-18','2025-11-25'];
const string={type:'string'},integer={type:'integer',minimum:1};
export class FixtureMcpServer {
  private client:ActorClient;private initialized=false;private ready=false;
  constructor(manager:EnvironmentManager,run:string,credential:string){this.client=manager.openActor(run,credential);}
  close(){this.client.dispose();}
  handle(request:any):any {
    const id=object(request)?request.id??null:null;
    const error=(code:number,message:string)=>({jsonrpc:'2.0',id,error:{code,message}});
    if(!object(request)||request.jsonrpc!=='2.0'||typeof request.method!=='string')return error(-32600,'Invalid JSON-RPC request');
    if(Object.hasOwn(request,'id')&&(typeof request.id!=='string'&&typeof request.id!=='number'||typeof request.id==='number'&&!Number.isSafeInteger(request.id)))return error(-32600,'Invalid request ID');
    const {method}=request,params=request.params??{};
    if(!object(params))return Object.hasOwn(request,'id')?error(-32602,'Invalid params'):null;
    if(!Object.hasOwn(request,'id')){if(method==='notifications/initialized'&&this.initialized)this.ready=true;return null;}
    let result;
    if(method==='ping')result={};
    else if(method==='initialize'){
      if(this.initialized)return error(-32600,'Already initialized');
      if(typeof params.protocolVersion!=='string')return error(-32602,'protocolVersion required');
      this.initialized=true;result={protocolVersion:versions.includes(params.protocolVersion)?params.protocolVersion:versions.at(-1),capabilities:{tools:{listChanged:false}},serverInfo:{name:'fixtureforge',version:'0.2.0'}};
    }else if(!this.ready)return error(-32002,'Complete initialization first');
    else if(method==='tools/list'){
      if(params.cursor!==undefined)return error(-32602,'No next page');
      const schema=(properties:object,required:string[])=>({type:'object',properties,required,additionalProperties:false});
      const specs=[
        ['create','Create a ticket for the bound actor',schema({title:string,operationKey:string},['title'])],
        ['search','Search only tickets visible to the bound actor',schema({query:string,status:{enum:['open','in_progress','closed']},ownerId:string,assigneeId:{type:['string','null']},limit:{type:'integer',minimum:1,maximum:1000}},[])],
        ['get','Read one visible ticket',schema({id:string},['id'])],
        ['update','Update title or assignee with an expected version',schema({id:string,expectedVersion:integer,patch:schema({title:string,assigneeId:{type:['string','null']}},[])},['id','expectedVersion','patch'])],
        ['transition','Move a ticket to a supported status',schema({id:string,status:{enum:['in_progress','closed']},expectedVersion:integer},['id','status','expectedVersion'])],
        ['close','Close a ticket using an expected version',schema({id:string,expectedVersion:integer},['id','expectedVersion'])],
      ];
      result={tools:specs.map(([name,description,inputSchema])=>({name:`ticket_${name}`,description,inputSchema,annotations:{readOnlyHint:['search','get'].includes(String(name)),destructiveHint:false,openWorldHint:false}}))};
    }else if(method==='tools/call'){
      if(Object.keys(params).some(k=>!['name','arguments','_meta'].includes(k)))return error(-32602,'Unknown parameters');
      const name=params.name,args=params.arguments??{};
      if(typeof name!=='string'||!/^ticket_(create|search|get|update|transition|close)$/.test(name)||!object(args))return error(-32602,'Invalid tool call');
      try{result={content:[{type:'text',text:JSON.stringify(this.client.call(name.slice(7),args))}],isError:false};}
      catch(error){result={content:[{type:'text',text:JSON.stringify({error:error instanceof DomainError?error.code:'infrastructure',message:String(error)})}],isError:true};}
    }else return error(-32601,'Method not found');
    return {jsonrpc:'2.0',id,result};
  }
}
export async function serveMcp(manager:EnvironmentManager,run:string,credential:string){
  const server=new FixtureMcpServer(manager,run,credential),lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  try{
    for await(const line of lines){
      if(Buffer.byteLength(line)>1024*1024)fail('Frame exceeds 1 MiB');
      let response;
      try{response=server.handle(JSON.parse(line));}
      catch{response={jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}};}
      if(response)process.stdout.write(JSON.stringify(response)+'\n');
    }
  }finally{lines.close();server.close();}
}
