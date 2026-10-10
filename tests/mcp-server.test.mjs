import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createManager, VERSION, DEVELOPER } from '../server.mjs';

const PASSWORD='only-for-mcp-tests-long-password';
const SECRET='mcp-only-private-token-0123456789';
const delay=ms => new Promise(resolve => setTimeout(resolve,ms));
async function listen(server) { await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); return `http://127.0.0.1:${server.address().port}`; }
function httpMcp() {
  const calls=[];
  const server=http.createServer(async (req,res) => {
    if (req.method==='DELETE') { calls.push({method:'DELETE'}); res.statusCode=204; return res.end(); }
    const bytes=[]; for await(const chunk of req) bytes.push(chunk);
    const input=JSON.parse(Buffer.concat(bytes).toString());
    calls.push({method:input.method,params:input.params,authorization:req.headers.authorization});
    if(req.url==='/slow-mcp'&&input.method==='initialize'){const timer=setTimeout(()=>res.end('{}'),5000);res.on('close',()=>clearTimeout(timer));return;}
    if(input.id===undefined) {res.statusCode=202;return res.end();}
    res.setHeader('Content-Type','application/json');
    if(input.method==='initialize') {
      res.setHeader('MCP-Session-Id','fixture-session');
      return res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{protocolVersion:input.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:`Echo ${SECRET}`,version:'1'}}}));
    }
    if(input.method==='tools/list') return res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{tools:[{name:'echo',description:`Return supplied text. Private test ${SECRET}`,inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}}));
    if(input.method==='tools/call') {
      const text=input.params.arguments.text;
      if(text==='fail') return res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,error:{code:-32000,message:`Tool failed with ${SECRET}`}}));
      if(text==='slow') {
        const timer=setTimeout(() => res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:'late'}]}})),5000);
        res.on('close',() => clearTimeout(timer));return;
      }
      return res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:`Echo: ${text}; ${SECRET}`}],structuredContent:{[SECRET]:`Value: ${SECRET}`},isError:false}}));
    }
    res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,error:{code:-32601,message:'Unavailable'}}));
  });
  return {server,calls};
}
function ollamaTools() {
  const calls=[];
  const server=http.createServer(async (req,res) => {
    const bytes=[];for await(const chunk of req)bytes.push(chunk);
    const input=JSON.parse(Buffer.concat(bytes).toString());calls.push(input);
    res.setHeader('Content-Type','application/x-ndjson');
    const last=input.messages.at(-1), user=input.messages.filter(item => item.role==='user').at(-1).content;
    if(!input.tools?.length) return res.end(JSON.stringify({message:{role:'assistant',content:'Plain chat',tool_calls:[{function:{name:'ignored',arguments:{}}}]},done:true})+'\n');
    if(last.role==='tool' && user==='ollama-error') return res.end(JSON.stringify({error:`Ollama next round failed ${SECRET}`})+'\n');
    if(last.role==='tool' && user!=='repeat' && user!=='sixteen-calls') return res.end(JSON.stringify({message:{role:'assistant',content:`Result: ${last.content}`},done:true})+'\n');
    const alias=input.tools[0].function.name;
    const args={text:user==='failure'?'fail':user==='execution-abort'?'slow':'hello'};
    if(user==='fragment') {
      res.write(JSON.stringify({message:{role:'assistant',tool_calls:[{function:{index:0,name:alias.slice(0,20),arguments:'{"text":"'}}]},done:false})+'\n');
      return res.end(JSON.stringify({message:{role:'assistant',tool_calls:[{function:{index:0,name:alias.slice(20),arguments:'hello"}'}}]},done:true})+'\n');
    }
    const count=user==='batch'?3:user==='sixteen-calls'?4:user==='too-many'?9:1;
    return res.end(JSON.stringify({message:{role:'assistant',content:'I can use a tool.',tool_calls:Array.from({length:count},(_,index) => ({function:{index,name:alias,arguments:args}}))},done:true})+'\n');
  });
  return {server,calls};
}
async function fixture(t,{approvalTimeoutMs=300000}={}) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'spark-mcp-integration-'));
  const ollama=ollamaTools(),mcp=httpMcp();
  const ollamaUrl=await listen(ollama.server),mcpUrl=(await listen(mcp.server))+'/mcp';
  const manager=await createManager({dataDir:path.join(temporary,'data'),host:'127.0.0.1',port:0,ollamaUrl,initialPassword:PASSWORD,approvalTimeoutMs});
  const address=await manager.start(),base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await manager.close();for(const server of [ollama.server,mcp.server]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await fs.rm(temporary,{recursive:true,force:true});});
  async function request(endpoint,{method='GET',body,auth}={}) {
    const headers={Origin:base};if(auth){headers.Cookie=auth.cookie;headers['X-CSRF-Token']=auth.csrf;}if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),response};
  }
  async function login() {const result=await request('/api/login',{method:'POST',body:{password:PASSWORD}});assert.equal(result.status,200);return{cookie:result.response.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf};}
  const auth=await login();
  async function configured(extra={}) {const result=await request('/api/mcp/servers',{method:'POST',auth,body:{name:'Fixture MCP',transport:'http',enabled:true,url:mcpUrl,bearerToken:SECRET,...extra}});assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function startChat(message,ids=[],authOverride=auth) {
    const controller=new AbortController();
    const response=await fetch(base+'/api/chat',{method:'POST',headers:{Origin:base,Cookie:authOverride.cookie,'X-CSRF-Token':authOverride.csrf,'Content-Type':'application/json'},body:JSON.stringify({model:'mock-tool-model',message,mcpServerIds:ids}),signal:controller.signal});
    assert.equal(response.status,200);
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
    async function next() {
      for(;;){const index=pending.indexOf('\n');if(index>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(line)return JSON.parse(line);continue;}const result=await reader.read();if(result.done)return null;pending+=decoder.decode(result.value,{stream:true});}
    }
    async function untilTool() {for(;;){const value=await next();if(value?.toolCall)return value.toolCall;if(!value)assert.fail('No pending tool call');}}
    async function finish(onTool) {const events=[];for(;;){const event=await next();if(!event)break;events.push(event);if(event.toolCall&&onTool)await onTool(event.toolCall);}return events;}
    return{controller,response,reader,next,untilTool,finish};
  }
  return{temporary,manager,ollama,mcp,mcpUrl,base,auth,login,request,configured,startChat};
}

test('MCP configuration CRUD/test/tools redacts secrets and transport switching purges incompatible fields',async t=>{
  const f=await fixture(t);const connection=await f.configured();
  assert.equal(connection.hasToken,true);assert.equal(Object.hasOwn(connection,'bearerToken'),false);
  for(const endpoint of ['/api/mcp/servers','/api/state',`/api/mcp/servers/${connection.id}/tools`]){
    const result=await f.request(endpoint,{auth:f.auth});assert.equal(result.status,200);assert.equal(JSON.stringify(result.data).includes(SECRET),false);
  }
  const probe=await f.request(`/api/mcp/servers/${connection.id}/test`,{method:'POST',auth:f.auth});assert.equal(probe.data.ok,true);assert.equal(probe.data.tools[0].name,'echo');assert.equal(JSON.stringify(probe.data).includes(SECRET),false);
  assert.equal(f.mcp.calls.filter(call=>call.method==='initialize').every(call=>call.authorization===`Bearer ${SECRET}`),true);
  const preserved=await f.request('/api/mcp/servers',{method:'POST',auth:f.auth,body:{id:connection.id,name:'Renamed',transport:'http',url:f.mcpUrl,enabled:true}});assert.equal(preserved.data.hasToken,true);
  const cleared=await f.request('/api/mcp/servers',{method:'POST',auth:f.auth,body:{id:connection.id,name:'Renamed',transport:'http',url:f.mcpUrl,enabled:true,bearerToken:''}});assert.equal(cleared.data.hasToken,false);
  const stdio=await f.request('/api/mcp/servers',{method:'POST',auth:f.auth,body:{id:connection.id,name:'Local',transport:'stdio',enabled:true,command:process.execPath,args:[],env:{PRIVATE_TEST:SECRET}}});assert.equal(stdio.status,200);assert.equal(stdio.data.url,undefined);assert.equal(stdio.data.hasToken,false);assert.deepEqual(stdio.data.envKeys,['PRIVATE_TEST']);assert.equal(stdio.data.env,undefined);
  const httpAgain=await f.request('/api/mcp/servers',{method:'POST',auth:f.auth,body:{id:connection.id,name:'Remote',transport:'http',enabled:true,url:f.mcpUrl}});assert.equal(httpAgain.status,200);assert.equal(httpAgain.data.command,undefined);assert.equal(httpAgain.data.envKeys,undefined);
  const persisted=JSON.parse(await fs.readFile(path.join(f.manager.dataDir,'state.json'),'utf8')).mcpServers[0];assert.equal(persisted.env,undefined);assert.equal(persisted.command,undefined);assert.equal(persisted.bearerToken,undefined);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.manager.dataDir,'state.json'))).mode&0o777,0o600);
  for(const url of ['http://8.8.8.8/mcp','http://169.254.169.254/mcp','http://127.0.0.1/mcp?token=secret'])assert.equal((await f.request('/api/mcp/servers',{method:'POST',auth:f.auth,body:{name:'Bad',url,transport:'http',enabled:true}})).status,400);
  assert.equal((await f.request(`/api/mcp/servers/${connection.id}`,{method:'DELETE',auth:f.auth})).status,200);
  const health=await f.request('/api/health');assert.equal(health.data.version,VERSION);assert.equal(health.data.developedBy,DEVELOPER);
});

test('MCP tools require exact originating-session approval; replay fails and history persists tool result',async t=>{
  const f=await fixture(t),connection=await f.configured(),other=await f.login();
  const stream=await f.startChat('use-tools',[connection.id]);const initial=await stream.next(),call=await stream.untilTool();
  assert.ok(initial.chatId);assert.equal(f.mcp.calls.some(item=>item.method==='tools/call'),false);
  const route=`/api/chat/${initial.chatId}/tool-decision`;
  assert.equal((await f.request(route,{method:'POST',auth:other,body:{callId:call.id,approved:true}})).status,403);
  assert.equal((await f.request(`/api/chat/other/tool-decision`,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}})).status,404);
  assert.equal((await f.request(`/api/mcp/servers/${connection.id}`,{method:'DELETE',auth:f.auth})).status,409);
  assert.equal((await f.request('/api/mcp/servers',{method:'POST',auth:f.auth,body:{id:connection.id,name:'Changed',transport:'http',url:f.mcpUrl,enabled:true}})).status,409);
  assert.equal((await f.request(route,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}})).status,200);
  assert.equal((await f.request(route,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}})).status,404);
  const events=await stream.finish();assert.equal(events.find(item=>item.toolResult).toolResult.status,'completed');assert.equal(events.at(-1).saved,true);
  assert.equal(JSON.stringify(events).includes(SECRET),false);
  assert.equal(f.mcp.calls.filter(item=>item.method==='tools/call').length,1);
  assert.deepEqual(f.mcp.calls.find(item=>item.method==='tools/call').params,{name:'echo',arguments:{text:'hello'}});
  const saved=(await f.request(`/api/chats/${initial.chatId}`,{auth:f.auth})).data;assert.equal(saved.toolEvents[0].status,'completed');assert.equal(saved.toolEvents[0].arguments.text,'hello');assert.equal(JSON.stringify(saved).includes(SECRET),false);
  assert.deepEqual(saved.messages.map(item=>item.role),['user','assistant','tool','assistant']);assert.equal(saved.messages[1].tool_calls.length,1);assert.match(saved.messages[2].tool_name,/^mcp_/);
});

test('denial and expiry never call MCP; plain chats leave tools disconnected',async t=>{
  const f=await fixture(t,{approvalTimeoutMs:120}),connection=await f.configured();
  const denied=await f.startChat('deny',[connection.id]),first=await denied.next(),call=await denied.untilTool();
  await f.request(`/api/chat/${first.chatId}/tool-decision`,{method:'POST',auth:f.auth,body:{callId:call.id,approved:false}});
  assert.equal((await denied.finish()).find(event=>event.toolResult).toolResult.status,'denied');
  const expired=await f.startChat('timeout',[connection.id]);await expired.next();const expiredCall=await expired.untilTool();
  const expiryEvents=await expired.finish();assert.equal(expiryEvents.find(event=>event.toolResult).toolResult.status,'denied');
  assert.equal((await f.request(`/api/chat/${first.chatId}/tool-decision`,{method:'POST',auth:f.auth,body:{callId:expiredCall.id,approved:true}})).status,404);
  assert.equal(f.mcp.calls.filter(item=>item.method==='tools/call').length,0);
  const count=f.mcp.calls.length,plain=await f.startChat('plain');const plainEvents=await plain.finish();assert.equal(plainEvents.some(event=>event.toolCall),false);assert.equal(f.mcp.calls.length,count);
});

test('function.index fragments aggregate and MCP errors are redacted and fed back to the model',async t=>{
  const f=await fixture(t),connection=await f.configured();
  for(const [message,expected] of [['fragment','completed'],['failure','failed']]){
    const stream=await f.startChat(message,[connection.id]),initial=await stream.next(),call=await stream.untilTool();assert.deepEqual(call.arguments,{text:message==='failure'?'fail':'hello'});
    await f.request(`/api/chat/${initial.chatId}/tool-decision`,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}});
    const events=await stream.finish();assert.equal(events.find(event=>event.toolResult).toolResult.status,expected);assert.equal(events.at(-1).saved,true);assert.equal(JSON.stringify(events).includes(SECRET),false);
  }
});

test('disconnect cancels every unprocessed batch tool and restart recovery keeps matching tool history',async t=>{
  const f=await fixture(t),connection=await f.configured();
  const stream=await f.startChat('batch',[connection.id]),initial=await stream.next(),call=await stream.untilTool();
  const snapshot=JSON.parse(await fs.readFile(path.join(f.manager.dataDir,'state.json'),'utf8'));assert.equal(snapshot.chats[initial.chatId].toolEvents.length,3);assert.equal(snapshot.chats[initial.chatId].toolEvents.every(event=>event.status==='pending'),true);
  stream.controller.abort();await stream.reader.cancel().catch(()=>{});
  let saved;
  for(let i=0;i<50;i++){saved=(await f.request(`/api/chats/${initial.chatId}`,{auth:f.auth})).data;if(saved.toolEvents.every(event=>event.status==='cancelled'))break;await delay(20);}
  assert.equal(saved.toolEvents.every(event=>event.status==='cancelled'),true);assert.equal(saved.messages.filter(item=>item.role==='tool').length,3);assert.equal(f.mcp.calls.some(item=>item.method==='tools/call'),false);
  assert.equal((await f.request(`/api/chat/${initial.chatId}/tool-decision`,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}})).status,404);
  const recoveryDir=path.join(f.temporary,'recovery');await fs.mkdir(recoveryDir);await fs.writeFile(path.join(recoveryDir,'state.json'),JSON.stringify(snapshot));
  const recovered=await createManager({dataDir:recoveryDir,port:0,initialPassword:PASSWORD});await recovered.close();
  const recovery=JSON.parse(await fs.readFile(path.join(recoveryDir,'state.json'),'utf8')).chats[initial.chatId];assert.equal(recovery.toolEvents.every(event=>event.status==='cancelled'),true);assert.equal(recovery.messages.filter(item=>item.role==='tool').length,3);
});

test('bounded MCP rounds/calls stop repeated requests and never execute undeclared tools',async t=>{
  const f=await fixture(t),connection=await f.configured();
  for(const [message,expectedCalls] of [['repeat',8],['sixteen-calls',16],['too-many',0]]){
    const countBefore=f.mcp.calls.filter(item=>item.method==='tools/call').length;
    const stream=await f.startChat(message,[connection.id]),initial=await stream.next();
    const events=await stream.finish(async call=>{await f.request(`/api/chat/${initial.chatId}/tool-decision`,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}});});
    assert.ok(events.at(-1).error);assert.equal(events.at(-1).saved,true);assert.equal(f.mcp.calls.filter(item=>item.method==='tools/call').length-countBefore,expectedCalls);
  }
});


test('aborting approved MCP execution cancels remote request and saves cancelled history',async t=>{
  const f=await fixture(t),connection=await f.configured();
  const stream=await f.startChat('execution-abort',[connection.id]),initial=await stream.next(),call=await stream.untilTool();
  await f.request(`/api/chat/${initial.chatId}/tool-decision`,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}});
  for(let i=0;i<50;i++){if(f.mcp.calls.some(item=>item.method==='tools/call'))break;await delay(10);}
  assert.equal(f.mcp.calls.filter(item=>item.method==='tools/call').length,1);
  stream.controller.abort();await stream.reader.cancel().catch(()=>{});
  let saved;
  for(let i=0;i<50;i++){saved=(await f.request(`/api/chats/${initial.chatId}`,{auth:f.auth})).data;if(saved.toolEvents[0].status==='cancelled')break;await delay(20);}
  assert.equal(saved.toolEvents[0].status,'cancelled');assert.equal(saved.messages.filter(item=>item.role==='tool').length,1);
  assert.equal(f.ollama.calls.length,1);
});

test('an Ollama error during a later tool round also redacts configured credentials',async t=>{
  const f=await fixture(t),connection=await f.configured();
  const stream=await f.startChat('ollama-error',[connection.id]),initial=await stream.next(),call=await stream.untilTool();
  await f.request(`/api/chat/${initial.chatId}/tool-decision`,{method:'POST',auth:f.auth,body:{callId:call.id,approved:true}});
  const events=await stream.finish();assert.match(events.at(-1).error,/Ollama next round failed/);assert.equal(JSON.stringify(events).includes(SECRET),false);
});


test('service shutdown aborts an in-flight MCP discovery request',async t=>{
  const f=await fixture(t),connection=await f.configured({url:f.mcpUrl.replace('/mcp','/slow-mcp')});
  const pending=f.request(`/api/mcp/servers/${connection.id}/test`,{method:'POST',auth:f.auth});pending.catch(()=>{});
  for(let i=0;i<50;i++){if(f.mcp.calls.some(item=>item.method==='initialize'))break;await delay(10);}
  const started=performance.now();await f.manager.close();assert.ok(performance.now()-started<2000,'MCP discovery must not hold service shutdown open');
  const result=await pending;assert.equal(result.status,502);
});
