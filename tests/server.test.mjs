import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createManager, isPrivateAddress, validateTarget } from '../server.mjs';

const password = 'test-only-long-password';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
async function listen(server) { await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); return `http://127.0.0.1:${server.address().port}`; }
function mockOllama() {
  const calls = [];
  const server = http.createServer(async (req,res) => {
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    const text = Buffer.concat(bytes).toString();
    const body = /^application\/json/.test(req.headers['content-type'] || '') && text ? JSON.parse(text) : null;
    calls.push({method:req.method,path:req.url,body,bytes:Buffer.concat(bytes)});
    res.setHeader('Content-Type','application/json');
    if (req.url === '/api/version') return res.end(JSON.stringify({version:'mock-1'}));
    if (req.url === '/api/tags') return res.end(JSON.stringify({models:[{name:'test:latest',size:1024}]}));
    if (req.url === '/api/ps') return res.end(JSON.stringify({models:[]}));
    if (req.url.startsWith('/api/blobs/')) {
      if (req.method === 'HEAD') { res.statusCode = 404; return res.end(); }
      return res.end('{}');
    }
    if (req.url === '/api/pull' || req.url === '/api/create') {
      res.setHeader('Content-Type','application/x-ndjson');
      if (body.model === 'failure') return res.end(JSON.stringify({error:'Model unavailable'}) + '\n');
      if (body.model === 'slow') {
        res.write(JSON.stringify({status:'downloading',completed:1,total:100}) + '\n');
        const timer = setTimeout(() => res.end(JSON.stringify({status:'success'}) + '\n'),2000);
        res.on('close',() => clearTimeout(timer)); return;
      }
      res.write(JSON.stringify({status:'downloading',completed:128,total:128}) + '\n');
      return res.end(JSON.stringify({status:'success'}) + '\n');
    }
    if (req.url === '/api/chat') {
      res.setHeader('Content-Type','application/x-ndjson');
      const last = body.messages.at(-1).content;
      if (last === 'slow-headers') {
        const timer = setTimeout(() => res.end(JSON.stringify({message:{role:'assistant',content:'late'},done:true}) + '\n'),2000);
        res.on('close',() => clearTimeout(timer)); return;
      }
      if (last === 'upstream-http-error') { res.statusCode=404; return res.end(JSON.stringify({error:'Model not found'})); }
      res.write(JSON.stringify({message:{role:'assistant',content:'Hello ',thinking:'Consider this.'},done:false}) + '\n');
      if (last === 'stream-error') return res.end(JSON.stringify({error:'Inference failed'}) + '\n');
      if (last === 'disconnect') {
        const timer = setTimeout(() => res.end(JSON.stringify({message:{role:'assistant',content:'world'},done:true}) + '\n'),2000);
        res.on('close',() => clearTimeout(timer)); return;
      }
      return res.end(JSON.stringify({message:{role:'assistant',content:'world',tool_calls:[{function:{name:'do-not-run'}}]},done:true,eval_count:2,eval_duration:200000000}) + '\n');
    }
    if (req.url === '/api/generate') return res.end(JSON.stringify({done:true,response:'A short explanation.',eval_count:10,eval_duration:1000000000}));
    if (req.url === '/api/show') return res.end(JSON.stringify({details:{parameter_size:'1B'}}));
    if (req.url === '/api/delete' || req.url === '/api/copy') return res.end('{}');
    res.statusCode=404; res.end(JSON.stringify({error:'Unknown mock endpoint'}));
  });
  return {server,calls};
}
async function fixture(t,{publicOrigin,hostname} = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'spark-manager-test-'));
  const importRoot = path.join(temporary,'imports'); await fs.mkdir(importRoot);
  const mock = mockOllama(), rawUrl = await listen(mock.server), ollamaUrl = hostname ? rawUrl.replace('127.0.0.1',hostname) : rawUrl;
  const manager = await createManager({dataDir:path.join(temporary,'data'),importRoots:[importRoot],initialPassword:password,host:'127.0.0.1',port:0,ollamaUrl,publicOrigin});
  const address = await manager.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await manager.close(); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve)); await fs.rm(temporary,{recursive:true,force:true}); });
  let cookie,csrf;
  async function call(endpoint, {method='GET',body,authenticated=true,origin=publicOrigin || base,csrfToken} = {}) {
    const headers = {};
    if (origin !== null) headers.Origin = origin;
    if (authenticated && cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type']='application/json';
    if (authenticated && csrf) headers['X-CSRF-Token'] = csrfToken ?? csrf;
    const response = await fetch(base + endpoint,{method,headers,body:body === undefined ? undefined : JSON.stringify(body)});
    let data; const text = await response.text();
    try { data=JSON.parse(text); } catch { data=text; }
    return {status:response.status,data,response};
  }
  async function login() {
    const result = await call('/api/login',{method:'POST',body:{password},authenticated:false});
    assert.equal(result.status,200);
    cookie = result.response.headers.get('set-cookie').split(';')[0]; csrf=result.data.csrf;
    return {cookie,csrf};
  }
  async function waitJob(id,wanted='completed') {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await call('/api/jobs');
      const job = result.data.find(item => item.id === id);
      if (job.status === wanted) return job;
      if (job.status === 'failed' && wanted !== 'failed') assert.fail(job.error);
      await delay(20);
    }
    assert.fail(`Timed out waiting for job ${wanted}`);
  }
  return {manager,base,temporary,importRoot,mock,call,login,waitJob};
}

test('private target validation blocks public, metadata, credentials, paths and mixed mapped IPs',async () => {
  for (const ip of ['127.0.0.1','10.2.3.4','172.16.1.2','192.168.2.3','100.109.121.1','::1','fd7a:115c:a1e0::1','::ffff:127.0.0.1','::ffff:7f00:1']) assert.equal(isPrivateAddress(ip),true,ip);
  for (const ip of ['8.8.8.8','169.254.169.254','169.254.170.2','0.0.0.0','172.15.0.1','100.128.0.1','::','fe80::1','2001:4860:4860::8888','::ffff:8.8.8.8','100.100.100.200','fd00:ec2::254','fd00:ec2:0:0:0:0:0:254']) assert.equal(isPrivateAddress(ip),false,ip);
  await validateTarget('http://127.0.0.1:11434');
  for (const url of ['https://8.8.8.8','http://169.254.169.254','file:///etc/passwd','http://user:secret@127.0.0.1','http://127.0.0.1/api','http://127.0.0.1?x=1','http://127.0.0.1/#x']) await assert.rejects(validateTarget(url));
});

test('session authentication, credential permissions, CSRF and origin requirements',async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/health',{authenticated:false})).data.ok,true);
  assert.equal((await f.call('/api/state',{authenticated:false})).status,401);
  assert.equal((await f.call('/api/session',{authenticated:false})).data.authenticated,false);
  assert.equal((await f.call('/api/login',{method:'POST',body:{password},authenticated:false,origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('/api/login',{method:'POST',body:{password:'wrong'},authenticated:false})).status,401);
  await f.login();
  assert.equal((await f.call('/api/session')).data.authenticated,true);
  assert.equal((await f.call('/api/settings',{method:'POST',body:{title:'Test',subtitle:''},csrfToken:'bad'})).status,403);
  assert.equal((await f.call('/api/settings',{method:'POST',body:{title:'Test',subtitle:''},origin:null})).status,403);
  assert.equal((await f.call('/api/settings',{method:'POST',body:{title:'Test',subtitle:''},origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('/api/settings',{method:'POST',body:{title:'Test',subtitle:''}})).status,200);
  assert.equal((await f.call('/api/settings',{method:'POST',body:{title:'x'.repeat(1100000),subtitle:''}})).status,413);
  for (const name of ['credentials.json','state.json','first-login.txt']) { const stat=await fs.stat(path.join(f.manager.dataDir,name)); assert.equal(stat.isFile(),true); if (process.platform !== 'win32') assert.equal(stat.mode & 0o777,0o600); }
  const contents = await fs.readFile(path.join(f.manager.dataDir,'credentials.json'),'utf8');
  assert.equal(contents.includes(password),false);
  assert.equal((await f.call('/api/logout',{method:'POST'})).status,200);
  assert.equal((await f.call('/api/state')).status,401);
});

test('reverse proxy fixed public origin allows local proxy Host while blocking other Origin',async t => {
  const f = await fixture(t,{publicOrigin:'https://spark.example.ts.net:9443'});
  await f.login();
  assert.match((await f.call('/api/login',{method:'POST',body:{password},authenticated:false})).response.headers.get('set-cookie'),/; Secure/);
  assert.equal((await f.call('/api/state')).status,200);
  assert.equal((await f.call('/api/settings',{method:'POST',body:{title:'A',subtitle:''},origin:f.base})).status,403);
});

test('fixed server CRUD, status and validated operations issue actual Ollama API requests',async t => {
  const f = await fixture(t); await f.login();
  const status = await f.call('/api/status'); assert.equal(status.data.online,true); assert.equal(status.data.models[0].name,'test:latest'); assert.equal(status.data.version,'mock-1'); assert.equal(typeof status.data.system.totalMemory,'number');
  for (const url of ['http://8.8.8.8','http://169.254.169.254','https://127.0.0.1/v1']) assert.equal((await f.call('/api/servers',{method:'POST',body:{name:'Blocked',url}})).status,400);
  assert.equal((await f.call('/api/delete',{method:'POST',body:{model:'../../etc/passwd'}})).status,400);
  assert.equal((await f.call('/api/delete',{method:'POST',body:{model:'test:latest',arbitrary:'field'}})).status,400);
  assert.equal((await f.call('/api/show',{method:'POST',body:{model:'test:latest'}})).data.details.parameter_size,'1B');
  assert.equal((await f.call('/api/copy',{method:'POST',body:{source:'test:latest',destination:'copy:latest'}})).status,200);
  assert.equal((await f.call('/api/delete',{method:'POST',body:{model:'copy:latest'}})).status,200);
  assert.equal((await f.call('/api/unload',{method:'POST',body:{model:'test:latest'}})).status,200);
  const server = await f.call('/api/servers',{method:'POST',body:{name:'Other',url:f.mock.server.address() ? `http://127.0.0.1:${f.mock.server.address().port}` : ''}});
  assert.equal(server.status,200);
  assert.equal((await f.call('/api/active-server',{method:'POST',body:{id:server.data.id}})).status,200);
  assert.equal((await f.call(`/api/servers/${server.data.id}`,{method:'DELETE'})).status,200);
  assert.equal((await f.call('/api/servers/local',{method:'DELETE'})).status,400);
  assert.equal(f.mock.calls.some(call => call.path === '/api/delete' && call.method === 'DELETE'),true);
});

test('persistent serial jobs support pull create benchmark failure cancellation and retry',async t => {
  const f = await fixture(t); await f.login();
  const pull = await f.call('/api/jobs',{method:'POST',body:{type:'pull',model:'hf.co/org/repo:q4'}}); assert.equal(pull.status,202);
  await f.waitJob(pull.data.id);
  const create = await f.call('/api/jobs',{method:'POST',body:{type:'create',model:'custom',from:'test:latest',system:'Help precisely.',parameters:{temperature:0.5,num_ctx:2048,top_k:40,top_p:0.9},quantize:'q4_K_M'}});
  await f.waitJob(create.data.id);
  assert.equal(f.mock.calls.find(call => call.path === '/api/create').body.from,'test:latest');
  assert.equal((await f.call('/api/jobs',{method:'POST',body:{type:'create',model:'bad',from:'test',parameters:{exec:'bad'}}})).status,400);
  const benchmark = await f.call('/api/jobs',{method:'POST',body:{type:'benchmark',model:'test'}});
  assert.equal((await f.waitJob(benchmark.data.id)).result.tokensPerSecond,10);
  const fail = await f.call('/api/jobs',{method:'POST',body:{type:'pull',model:'failure'}});
  assert.equal((await f.waitJob(fail.data.id,'failed')).error,'Model unavailable');
  const slow = await f.call('/api/jobs',{method:'POST',body:{type:'pull',model:'slow'}});
  await f.waitJob(slow.data.id,'running');
  const queued = await f.call('/api/jobs',{method:'POST',body:{type:'pull',model:'queued'}});
  assert.equal(queued.data.status,'queued');
  assert.equal((await f.call(`/api/jobs/${queued.data.id}/cancel`,{method:'POST'})).data.status,'cancelled');
  assert.equal((await f.call(`/api/jobs/${slow.data.id}/cancel`,{method:'POST'})).data.status,'cancelled');
  const retried = await f.call(`/api/jobs/${queued.data.id}/retry`,{method:'POST'}); assert.equal(retried.status,202);
  await f.waitJob(retried.data.id);
  const saved = JSON.parse(await fs.readFile(path.join(f.manager.dataDir,'state.json'),'utf8'));
  assert.equal(saved.jobs.find(job => job.id === pull.data.id).status,'completed');
});

test('GGUF import scans configured roots hashes/uploads bytes then creates model; rejects symlink escape',async t => {
  const f = await fixture(t,{hostname:'localhost'}); await f.login();
  const modelPath = path.join(f.importRoot,'test.gguf');
  const contents = Buffer.alloc(4 * 1024 * 1024,0xab); contents.write('GGUF'); await fs.writeFile(modelPath,contents);
  const outside = path.join(f.temporary,'outside.gguf'); await fs.writeFile(outside,contents);
  await fs.symlink(outside,path.join(f.importRoot,'escape.gguf'));
  await fs.writeFile(path.join(f.importRoot,'bad.gguf'),'not-a-model');
  const files = await f.call('/api/import-files');
  assert.equal(files.data.files.some(file => file.name === 'escape.gguf'),false);
  assert.equal((await f.call('/api/jobs',{method:'POST',body:{type:'import',model:'escape',path:outside}})).status,400);
  assert.equal((await f.call('/api/jobs',{method:'POST',body:{type:'import',model:'escape',path:path.join(f.importRoot,'escape.gguf')}})).status,400);
  const job = await f.call('/api/jobs',{method:'POST',body:{type:'import',model:'imported',path:modelPath}});
  await f.waitJob(job.data.id);
  const upload = f.mock.calls.find(call => call.path.startsWith('/api/blobs/') && call.method === 'POST');
  assert.deepEqual(upload.bytes,contents);
  const creation = f.mock.calls.find(call => call.path === '/api/create');
  assert.equal(creation.body.model,'imported'); assert.match(creation.body.files['test.gguf'],/^sha256:[a-f0-9]{64}$/);
  const bad = await f.call('/api/jobs',{method:'POST',body:{type:'import',model:'bad',path:path.join(f.importRoot,'bad.gguf')}});
  assert.match((await f.waitJob(bad.data.id,'failed')).error,/not a GGUF/);
});

test('chat streams tokens, preserves thinking and history, filters tools, handles NDJSON errors',async t => {
  const f = await fixture(t); await f.login();
  const result = await f.call('/api/chat',{method:'POST',body:{model:'test',message:'first',system:'Be brief',options:{temperature:0.2,num_ctx:2048}}});
  assert.equal(result.status,200);
  const chunks = result.data.trim().split('\n').map(line => JSON.parse(line));
  const id = chunks[0].chatId; assert.equal(chunks.at(-1).saved,true);
  assert.equal(chunks.some(chunk => chunk.message?.tool_calls),false);
  const saved = (await f.call(`/api/chats/${id}`)).data;
  assert.deepEqual(saved.messages.map(message => message.role),['system','user','assistant']);
  assert.equal(saved.messages.at(-1).content,'Hello world'); assert.equal(saved.messages.at(-1).thinking,'Consider this.');
  const follow = await f.call('/api/chat',{method:'POST',body:{chatId:id,model:'test',message:'second'}}); assert.equal(follow.status,200);
  assert.equal(f.mock.calls.filter(call => call.path === '/api/chat').at(-1).body.messages.length,4);
  const failed = await f.call('/api/chat',{method:'POST',body:{model:'test',message:'stream-error'}});
  const failedChunks = failed.data.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(failedChunks.at(-1).error,'Inference failed'); assert.equal(failedChunks.at(-1).saved,true);
  assert.equal((await f.call(`/api/chats/${failedChunks[0].chatId}`)).data.messages.at(-1).interrupted,true);
  const upstreamHttp = await f.call('/api/chat',{method:'POST',body:{model:'test',message:'upstream-http-error'}});
  assert.equal(upstreamHttp.status,502); assert.equal(upstreamHttp.data.error,'Model not found');
  assert.equal((await f.call('/api/chat',{method:'POST',body:{chatId:'__proto__',model:'test',message:'bad'}})).status,400);
  assert.equal((await f.call('/api/chat',{method:'POST',body:{model:'test',message:'bad',images:['data:image/png;base64,AAAA']}})).status,400);
  assert.equal((await f.call(`/api/chats/${id}`,{method:'DELETE'})).status,200);
});

test('restart marks queued and running jobs interrupted and preserves conversations',async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'spark-restart-test-'));
  t.after(() => fs.rm(temp,{recursive:true,force:true}));
  const seed = {version:1,settings:{title:'A',subtitle:''},servers:[{id:'local',name:'DGX',url:'http://127.0.0.1:11434'}],activeServerId:'local',jobs:[{id:'pending',status:'queued'},{id:'active',status:'running'}],chats:{saved:{id:'saved',title:'Persisted',serverId:'local',model:'test',messages:[{role:'user',content:'Retain this'}],updatedAt:'2026-10-10T00:00:00Z'}}};
  await fs.writeFile(path.join(temp,'state.json'),JSON.stringify(seed));
  const manager = await createManager({dataDir:temp,initialPassword:password,port:0});
  const state=JSON.parse(await fs.readFile(path.join(temp,'state.json'),'utf8'));
  assert.equal(state.jobs.every(job => job.status === 'interrupted'),true);
  assert.equal(state.chats.saved.messages[0].content,'Retain this');
  await manager.close();
});


test('chat disconnection persists partial history; active new chats block server edits/deletion',async t => {
  const f = await fixture(t), auth = await f.login();
  const configured = (await f.call('/api/servers',{method:'POST',body:{name:'Chat target',url:`http://127.0.0.1:${f.mock.server.address().port}`}})).data;
  const controller = new AbortController();
  const response = await fetch(f.base + '/api/chat',{method:'POST',headers:{Origin:f.base,Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify({serverId:configured.id,model:'test',message:'disconnect'}),signal:controller.signal});
  const reader=response.body.getReader(), first=await reader.read();
  const chunks = Buffer.from(first.value).toString().trim().split('\n').map(line => JSON.parse(line));
  const chatId=chunks[0].chatId;
  assert.equal((await f.call('/api/servers',{method:'POST',body:{id:configured.id,name:'Changed',url:`http://127.0.0.1:${f.mock.server.address().port}`}})).status,409);
  assert.equal((await f.call(`/api/servers/${configured.id}`,{method:'DELETE'})).status,409);
  controller.abort(); await reader.cancel().catch(() => {});
  let saved;
  for (let i=0;i<50;i++) { const result=await f.call(`/api/chats/${chatId}`); if (result.status===200) {saved=result.data;break;} await delay(20); }
  assert.ok(saved); assert.equal(saved.messages[0].content,'disconnect');
  assert.equal(saved.messages.at(-1).content,'Hello '); assert.equal(saved.messages.at(-1).interrupted,true);
  assert.equal((await f.call(`/api/servers/${configured.id}`,{method:'DELETE'})).status,200);
});

test('cancelling chat before Ollama sends headers retains the submitted user turn',async t => {
  const f = await fixture(t), auth=await f.login();
  const controller=new AbortController();
  const pending = fetch(f.base + '/api/chat',{method:'POST',headers:{Origin:f.base,Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify({model:'test',message:'slow-headers'}),signal:controller.signal});
  pending.catch(() => {});
  for(let i=0;i<50;i++) { if(f.mock.calls.some(call => call.path==='/api/chat')) break; await delay(10); }
  controller.abort(); await assert.rejects(pending);
  let chat;
  for(let i=0;i<50;i++) { chat=(await f.call('/api/state')).data.chats.find(item => item.title==='slow-headers'); if(chat) break; await delay(20); }
  assert.ok(chat); const saved=(await f.call(`/api/chats/${chat.id}`)).data;
  assert.deepEqual(saved.messages,[{role:'user',content:'slow-headers'}]);
});
