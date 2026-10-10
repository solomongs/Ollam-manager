import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import { validateMcpConfig,validateMcpTarget,publicMcpConfig,createMcpClient,MCP_PROTOCOL_VERSIONS,validateMcpExecutable,windowsProcessTreeCommand } from '../mcp-client.mjs';

async function fixture(t,options={}) {
  const calls=[]; let lastRequest;
  const server=http.createServer(async(req,res) => {
    let body=''; for await(const chunk of req) body+=chunk;
    const message=body ? JSON.parse(body) : undefined;
    calls.push({method:req.method,url:req.url,headers:req.headers,message});
    const send=value => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(req.method === 'DELETE') {res.statusCode=204;return res.end();}
    if(options.redirect) {res.statusCode=302;res.setHeader('Location','http://169.254.169.254/');return res.end();}
    if(req.method === 'GET') {res.setHeader('Content-Type','text/event-stream');return res.end(`data: ${JSON.stringify({jsonrpc:'2.0',id:lastRequest.id,result:{content:[{type:'text',text:'resumed'}]}})}\n\n`);}
    if(!Object.hasOwn(message,'id')) {res.statusCode=202;return res.end();}
    const response=result => send({jsonrpc:'2.0',id:message.id,result});
    if(message.method === 'initialize') {res.setHeader('MCP-Session-Id','session-test');return response({protocolVersion:options.version || '2025-06-18',capabilities:{tools:{}},serverInfo:{name:'mock',version:'1'}});}
    if(message.method === 'tools/list') {
      if(options.oversize) return response({tools:[],filler:'x'.repeat(3*1024*1024)});
      if(options.loop) return response({tools:[],nextCursor:'same'});
      if(message.params.cursor) return response({tools:[{name:'second',inputSchema:{type:'object'}}]});
      return response({tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}],nextCursor:'page2'});
    }
    if(message.method === 'tools/call') {
      if(options.slow) {const timer=setTimeout(() => response({content:[{type:'text',text:'late'}]}),1000);res.on('close',()=>clearTimeout(timer));return;}
      if(options.resume) {lastRequest=message;res.setHeader('Content-Type','text/event-stream');return res.end('id: cursor-1\nretry: 0\ndata: \n\n');}
      if(options.sse) {
        res.setHeader('Content-Type','text/event-stream');
        res.write(': hello\r\n\r\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progress:1}})+'\r');
        res.write('\n\r\n');
        return res.end(`data: ${JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:message.params.arguments.text}]}})}\r\n\r\n`);
      }
      return response({content:[{type:'text',text:message.params.arguments.text || 'ok'}]});
    }
    return send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Not implemented'}});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://localhost:${server.address().port}/mcp`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {url,calls,config:{name:'Fixture',transport:'http',url,bearerToken:'fixture-secret'}};
}

test('MCP URL/config validation, private HTTP/public HTTPS policy and secret update/redaction',async t=>{
  const f=await fixture(t);
  const config=await validateMcpConfig(f.config);
  assert.equal(config.transport,'http');assert.equal(config.url,f.url);
  const updated=await validateMcpConfig({name:'Renamed'},config);
  assert.equal(updated.bearerToken,'fixture-secret');
  assert.equal((await validateMcpConfig({name:'Renamed',bearerToken:''},config)).bearerToken,undefined);
  const visible=publicMcpConfig(config);
  assert.equal(visible.hasToken,true);assert.equal('bearerToken' in visible,false);
  await validateMcpTarget('https://8.8.8.8/mcp');
  for(const url of ['http://8.8.8.8/mcp','http://169.254.169.254/mcp','https://100.100.100.200/mcp','https://[fd00:ec2::254]/mcp','https://[fe80::1]/mcp','http://user:secret@localhost/mcp',f.url+'?token=secret',f.url+'#fragment','file:///tmp/mcp']) await assert.rejects(validateMcpTarget(url));
  await assert.rejects(validateMcpConfig({...f.config,unexpected:true}),/Unsupported/);
  await assert.rejects(validateMcpConfig({...f.config,bearerToken:'bad\r\nheader'}),/visible ASCII/);
});

test('HTTP initializes, negotiates stable version, lists pagination, calls tools and closes session',async t=>{
  const f=await fixture(t),client=createMcpClient(f.config);
  t.after(()=>client.close());
  const init=await client.initialize();assert.equal(init.protocolVersion,'2025-06-18');
  const tools=await client.listTools();assert.deepEqual(tools.map(tool=>tool.name),['echo','second']);
  const result=await client.callTool('echo',{text:'hello'});assert.equal(result.content[0].text,'hello');
  const initialization=f.calls.find(call=>call.message?.method==='initialize');
  assert.equal(initialization.message.params.protocolVersion,MCP_PROTOCOL_VERSIONS[0]);
  const ready=f.calls.find(call=>call.message?.method==='notifications/initialized');
  assert.equal(ready.headers['mcp-session-id'],'session-test');assert.equal(ready.headers['mcp-protocol-version'],'2025-06-18');
  assert.equal(ready.headers.authorization,'Bearer fixture-secret');assert.match(ready.headers.accept,/application\/json.*text\/event-stream/);
  await client.close();assert.equal(f.calls.at(-1).method,'DELETE');
  await assert.rejects(client.listTools(),/closed/);
});

test('Streamable HTTP POST SSE accepts chunk boundaries/notifications and resumes by event ID',async t=>{
  for(const options of [{sse:true},{resume:true}]) {
    const f=await fixture(t,options),client=createMcpClient(f.config);t.after(()=>client.close());
    const result=await client.callTool('echo',{text:'hello SSE'});
    assert.equal(result.content[0].text,options.resume?'resumed':'hello SSE');
    if(options.resume) assert.equal(f.calls.find(call=>call.method==='GET').headers['last-event-id'],'cursor-1');
    await client.close();
  }
});

test('HTTP rejects redirects, oversized messages, pagination loops and unsupported protocol',async t=>{
  for(const [options,action,pattern] of [
    [{redirect:true},'initialize',/redirects/],
    [{oversize:true},'listTools',/allowed size/],
    [{loop:true},'listTools',/cursor repeated/],
    [{version:'2099-01-01'},'initialize',/unsupported protocol/],
  ]) {
    const f=await fixture(t,options),client=createMcpClient(f.config);t.after(()=>client.close());
    await assert.rejects(client[action](),pattern);await client.close();
  }
});

test('timeout and AbortSignal send explicit cancellation before HTTP session cleanup',async t=>{
  for(const timed of [true,false]) {
    const f=await fixture(t,{slow:true}),controller=new AbortController();
    const client=createMcpClient(f.config,{signal:controller.signal,timeout:timed?100:1000});t.after(()=>client.close());
    await client.initialize();
    const pending=client.callTool('echo',{});
    if(!timed) setTimeout(()=>controller.abort(),40);
    await assert.rejects(pending,/timed out|closed|cancelled|abort/i);
    await client.close();
    const cancelled=f.calls.find(call=>call.message?.method==='notifications/cancelled');
    assert.equal(typeof cancelled?.message.params.requestId,'number');
    assert.equal(f.calls.at(-1).method,'DELETE');
  }
});

test('immediate close during asynchronous configuration never dispatches initialize',async t=>{
  const f=await fixture(t),client=createMcpClient(f.config);
  const pending=client.initialize();await client.close();
  await assert.rejects(pending,/closed/);assert.equal(f.calls.length,0);
});

const stdioScript=`const worker=process.platform==='win32'?require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}):null;const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'stdio-fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};else result={content:[{type:'text',text:JSON.stringify({value:m.params.arguments.text,uid:process.getuid?.(),env:process.env.FIXTURE_TOKEN,unrelated:process.env.UNRELATED_SECRET,workerPid:worker?.pid,systemRoot:process.env.SystemRoot,temporary:process.env.TEMP,profile:process.env.USERPROFILE})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
function stdioConfig(script=stdioScript) {return {name:'Stdio fixture',transport:'stdio',command:process.execPath,args:['-e',script],cwd:os.tmpdir(),env:{FIXTURE_TOKEN:'fixture-only'}};}
async function canSpawnNonroot() {
  if(typeof process.getuid !== 'function' || process.getuid() !== 0) return true;
  try { const mappings=(await readFile('/proc/self/uid_map','utf8')).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));return mappings.some(([inside,_outside,length])=>65534>=inside && 65534<inside+length); } catch {return false;}
}
function childOptions() {return typeof process.getuid==='function' && process.getuid()===0?{stdioUid:65534,stdioGid:65534}:{};}

test('stdio configuration validates commands/env and preserves hidden values',async()=>{
  const config=await validateMcpConfig(stdioConfig());
  const updated=await validateMcpConfig({name:'Renamed'},config);assert.equal(updated.env.FIXTURE_TOKEN,'fixture-only');
  assert.deepEqual(publicMcpConfig(updated).envKeys,['FIXTURE_TOKEN']);assert.equal('env' in publicMcpConfig(updated),false);
  await assert.rejects(validateMcpConfig({...stdioConfig(),command:'node'}),/absolute/);
  await assert.rejects(validateMcpConfig({...stdioConfig(),env:{'BAD=NAME':'x'}}),/variable name/);
});

test('stdio fixture negotiates legacy protocol over stdio, uses nonroot/minimal env and redacts updates',async t=>{
  if(!await canSpawnNonroot()) {t.skip('Sandbox maps only UID 0; a real nonroot child cannot be spawned (production root guard remains enforced).');return;}
  const previous=process.env.UNRELATED_SECRET;process.env.UNRELATED_SECRET='must-not-inherit';
  const config=await validateMcpConfig(stdioConfig());
  const updated=await validateMcpConfig({name:'Renamed'},config);assert.equal(updated.env.FIXTURE_TOKEN,'fixture-only');
  const publicConfig=publicMcpConfig(updated);assert.deepEqual(publicConfig.envKeys,['FIXTURE_TOKEN']);assert.equal('env' in publicConfig,false);
  const client=createMcpClient(config,childOptions());
  let workerPid;
  try {
    assert.equal((await client.initialize()).protocolVersion,'2024-11-05');
    assert.equal((await client.listTools())[0].name,'echo');
    const value=JSON.parse((await client.callTool('echo',{text:'stdio'})).content[0].text);
    assert.equal(value.value,'stdio');assert.equal(value.env,'fixture-only');assert.equal(value.unrelated,undefined);
    if(typeof process.getuid === 'function') assert.notEqual(value.uid,0);
    else assert.equal(value.uid,undefined);
    if (process.platform === 'win32') {
      workerPid=value.workerPid;assert.equal(typeof workerPid,'number');
      assert.equal(value.systemRoot,process.env.SystemRoot);assert.equal(value.temporary,process.env.TEMP);assert.equal(value.profile,process.env.USERPROFILE);
    }
  } finally {await client.close();if(previous===undefined)delete process.env.UNRELATED_SECRET;else process.env.UNRELATED_SECRET=previous;}
  if (process.platform === 'win32') {
    let gone=false;
    for(let attempt=0;attempt<20;attempt++) { try { process.kill(workerPid,0); } catch { gone=true;break; } await new Promise(resolve=>setTimeout(resolve,50)); }
    assert.equal(gone,true,'Closing MCP must terminate its Windows grandchild process as well as the server.');
  }
});

test('stdio refuses root execution without a trusted positive UID',async()=>{
  if(typeof process.getuid==='function' && process.getuid()===0) {
    const root=createMcpClient(stdioConfig());await assert.rejects(root.initialize(),/nonroot/);await root.close();
  }
});

test('stdio malformed output and hanging subprocess cleanup are bounded',async t=>{
  if(!await canSpawnNonroot()) {t.skip('Sandbox maps only UID 0; run this process lifecycle test under the nonroot deployment account.');return;}
  const malformed=createMcpClient(stdioConfig("process.stdout.write('not-json\\n');setInterval(()=>{},1000)"),childOptions());
  await assert.rejects(malformed.initialize(),/JSON-RPC|exited/);await malformed.close();
  const hanging=createMcpClient(stdioConfig("process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)"),{...childOptions(),timeout:75});
  const started=Date.now();await assert.rejects(hanging.initialize(),/timed out/);await hanging.close();assert.ok(Date.now()-started<2000);
});


test('MCP executable policy uses Windows .exe files without requiring POSIX execute bits',()=>{
  const file={isFile:()=>true,mode:0o600},directory={isDirectory:()=>true};
  assert.doesNotThrow(()=>validateMcpExecutable('C:\\Program Files\\nodejs\\node.exe',file,directory,'win32'));
  assert.doesNotThrow(()=>validateMcpExecutable('C:\\Tools\\PYTHON.EXE',file,directory,'win32'));
  for(const extension of ['cmd','bat','ps1','vbs','js'])assert.throws(()=>validateMcpExecutable(`C:\\Tools\\server.${extension}`,file,directory,'win32'),/\.exe/);
  assert.throws(()=>validateMcpExecutable('node.exe',file,directory,'win32'),/absolute/);
  assert.throws(()=>validateMcpExecutable('C:\\Tools\\folder.exe',{isFile:()=>false,mode:0o777},directory,'win32'),/regular file/);
  assert.throws(()=>validateMcpExecutable('/usr/bin/node',file,directory,'linux'),/execute permission/);
  assert.doesNotThrow(()=>validateMcpExecutable('/usr/bin/node',{isFile:()=>true,mode:0o755},directory,'linux'));
});

test('Windows MCP process-tree cleanup has a fixed executable and numeric child PID arguments',()=>{
  assert.deepEqual(windowsProcessTreeCommand(12345,'C:\\Windows'),{command:'C:\\Windows\\System32\\taskkill.exe',args:['/PID','12345','/T','/F']});
  assert.equal(windowsProcessTreeCommand(9,'D:\\Windows').command,'D:\\Windows\\System32\\taskkill.exe');
  for(const pid of ['1 & whoami',0,-1,NaN,Infinity,1.5])assert.throws(()=>windowsProcessTreeCommand(pid,'C:\\Windows'),/process ID/);
  for(const root of ['relative-path','\\\\remote\\Windows','C:\\Windows\0evil'])assert.throws(()=>windowsProcessTreeCommand(12345,root),/system directory/);
});
