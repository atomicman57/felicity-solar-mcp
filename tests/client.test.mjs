import test from 'node:test';
import assert from 'node:assert/strict';
import {FelicityClient,redact} from '../src/client.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../src/server.mjs';
test('Authentication fields never leave nested telemetry objects',()=>{
 assert.deepEqual(redact({voltage:224,token:'hidden',nested:[{password:'hidden',soc:99,openApiPassword:'hidden'}]}),{voltage:224,nested:[{soc:99}]});
});
test('Pagination fetches a full second page and caches no truncated fleet',async()=>{
 const c=new FelicityClient();let calls=0;c.request=async(_,b)=>{calls++;return {dataList:Array.from({length:b.pageNum===1?100:2},(_,i)=>({id:(b.pageNum-1)*100+i})),total:102};};
 const r=await c.pages('/plant/list_condition_plant');assert.equal(r.items.length,102);assert.equal(r.complete,true);assert.equal(calls,2);
});
test('Concurrent authentication makes a single login and does not expose vendor auth errors',async()=>{
 let calls=0;const c=new FelicityClient({user:'test',pass:'test',fetcher:async()=>{calls++;return {ok:true,json:async()=>({code:200,data:{token:'test-token'}})};}});
 await Promise.all([c.authenticate(),c.authenticate()]);assert.equal(calls,1);
 c.fetcher=async()=>({ok:true,json:async()=>({code:500,message:'password=secret'})});
 await assert.rejects(c.request('/plant/plantDetails'),e=>!e.message.includes('secret'));
});
test('Actual MCP handshake exposes only read tools and propagates failures',async()=>{
 const fake={plants:async()=>({items:[{id:'example',password:'hidden'}],complete:true}),plant:async()=>{throw new Error('Plant is not accessible to this account.');}};
 const s=createServer(fake),c=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await s.connect(b);await c.connect(a);
 try{const tools=await c.listTools();assert.equal(tools.tools.length,14);assert.ok(tools.tools.every(x=>x.annotations.readOnlyHint));
  const r=await c.callTool({name:'list_plants',arguments:{}});assert.ok(!r.content[0].text.includes('password'));
  const fail=await c.callTool({name:'get_plant',arguments:{plantId:'no'}});assert.equal(fail.isError,true);
 }finally{await c.close();await s.close();}
});
