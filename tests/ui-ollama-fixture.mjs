// Deterministic Ollama fixture for browser verification; never used in production.
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
const models = [{ name:'fixture-model:small',model:'fixture-model:small',size:2100000000,modified_at:'2026-10-10T00:00:00Z',digest:'test-digest',details:{format:'gguf',family:'fixture',parameter_size:'3B',quantization_level:'Q4_K_M'} }];
let running = [];
export async function startFixture(port=11435) {
  const server = http.createServer(async(req,res)=> {
    let payload = '';
    for await (const chunk of req) payload += chunk;
    let body; try { body = payload ? JSON.parse(payload) : {}; } catch { body = {}; }
    const send = (value,code=200)=> { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
    const path = req.url;
    if(path === '/api/version') return send({version:'fixture-0.1'});
    if(path === '/api/tags') return send({models});
    if(path === '/api/ps') return send({models:running});
    if(path === '/api/show') return send({license:'Fixture only',modelfile:'FROM fixture-model:small\nSYSTEM You are helpful.',parameters:'temperature 0.7',template:'{{ .Prompt }}',details:models[0].details,capabilities:['completion','vision'],model_info:{'general.architecture':'fixture','fixture.context_length':32768}});
    if(path === '/api/copy') { const source=models.find(x=>x.name===body.source); if(!source)return send({error:'model not found'},404); models.push({...source,name:body.destination,model:body.destination}); return send({}); }
    if(path === '/api/delete') {const i=models.findIndex(x=>x.name===body.model); if(i<0)return send({error:'model not found'},404); models.splice(i,1); return send({});}
    if(path?.startsWith('/api/blobs/')) { if(req.method==='HEAD'){res.writeHead(404); return res.end();} res.writeHead(201); return res.end(); }
    if(path === '/api/pull'||path === '/api/create') {
      res.writeHead(200,{'Content-Type':'application/x-ndjson'});
      for(const completed of [0,25,60,100]) { if(res.destroyed)return; res.write(JSON.stringify({status:completed===100?'success':'pulling fixture',digest:'fixture-layer',total:100,completed})+'\n'); await delay(30); }
      if(!models.some(x=>x.name===body.model))models.push({...models[0],name:body.model,model:body.model});
      return res.end();
    }
    if(path === '/api/generate' && body.keep_alive===0) { running=running.filter(x=>x.name!==body.model); return send({model:body.model,done:true}); }
    if(path === '/api/chat'||path === '/api/generate') {
      const requestedTool = body.tools?.[0]?.function?.name;
      const toolResult = body.messages?.findLast(message=>message.role==='tool');
      if(path === '/api/chat' && requestedTool && !toolResult && body.messages?.some(message=>message.role==='user' && message.content.includes('Use MCP'))) {
        res.writeHead(200,{'Content-Type':'application/x-ndjson'});
        res.write(JSON.stringify({message:{role:'assistant',content:'I can read the Spark note with your approval.'},done:false})+'\n');
        return res.end(JSON.stringify({message:{role:'assistant',tool_calls:[{function:{name:requestedTool,arguments:{location:'DGX Spark'}}}]},done:true})+'\n');
      }
      if(path === '/api/chat' && toolResult) {
        res.writeHead(200,{'Content-Type':'application/x-ndjson'});
        res.write(JSON.stringify({message:{role:'assistant',content:`Tool reply received: ${toolResult.content}`},done:false})+'\n');
        return res.end(JSON.stringify({message:{role:'assistant',content:''},done:true,eval_count:8,eval_duration:80000000})+'\n');
      }
      const chunks=['Fixture ', 'answer: ', 'the stream works.'];
      const result={model:body.model,message:{role:'assistant',content:chunks.join('')},response:chunks.join(''),done:true,eval_count:12,eval_duration:120000000,total_duration:200000000,prompt_eval_count:8,prompt_eval_duration:80000000};
      running=[{...models[0],name:body.model,model:body.model,size_vram:1500000000,expires_at:new Date(Date.now()+300000).toISOString()}];
      if(body.stream===false)return send(result);
      res.writeHead(200,{'Content-Type':'application/x-ndjson'});
      res.write(JSON.stringify({message:{role:'assistant',thinking:'A fixture reasoning step.'},done:false})+'\n');
      for(const content of chunks) { if(res.destroyed)return; res.write(JSON.stringify({message:{role:'assistant',content},response:content,done:false})+'\n'); await delay(30); }
      res.write(JSON.stringify({...result,message:{role:'assistant',content:''},response:''})+'\n'); return res.end();
    }
    send({error:'fixture route missing'},404);
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve)); return server;
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  await startFixture(Number(process.env.FIXTURE_PORT||11435));
  console.log('Ollama fixture listening on loopback');
}
