// Harmless deterministic MCP server for browser verification, never production.
import http from 'node:http';
export async function startMcpFixture() {
  const calls = [];
  const tools = [{name:'read_spark_note',description:'Read a harmless fixture note about the Spark.',inputSchema:{type:'object',properties:{location:{type:'string'}},required:['location']}}];
  const server = http.createServer(async (req,res) => {
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    let text = '';
    for await (const chunk of req) text += chunk;
    let request;
    try { request = JSON.parse(text); } catch { res.writeHead(400); return res.end(); }
    if (!Object.hasOwn(request,'id')) { res.writeHead(202); return res.end(); }
    let result;
    if (request.method === 'initialize') result = {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'browser-mcp-fixture',version:'1.0.0'}};
    else if (request.method === 'tools/list') result = {tools};
    else if (request.method === 'tools/call') {
      calls.push(request.params);
      result = {content:[{type:'text',text:`MCP fixture note: ${request.params.arguments.location} is ready.`}],isError:false};
    } else { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})); }
    res.writeHead(200,{'Content-Type':'application/json','Mcp-Session-Id':'browser-fixture-session'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}/mcp`,calls,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
