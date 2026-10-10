import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { spawn, execFile } from 'node:child_process';

export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25','2025-06-18','2025-03-26','2024-11-05']);
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_INPUT = 256 * 1024;
const MAX_TOOLS = 500;
let processCount = 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) { throw new Error(message); }
function text(value,label,max=256,empty=false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /\0/.test(value)) fail(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  return value;
}
function checkedJSON(value,limit=MAX_INPUT) {
  let serialized; try { serialized = JSON.stringify(value); } catch { fail('MCP data must be JSON serializable.'); }
  if (!serialized || Buffer.byteLength(serialized) > limit) fail('MCP message exceeds the allowed size.');
  return serialized;
}
function addressType(address) {
  let ip = address.toLowerCase().split('%')[0];
  if (net.isIP(ip) === 6) { try { ip=new URL(`http://[${ip}]/`).hostname.slice(1,-1); } catch { return 'blocked'; } }
  if (ip.startsWith('::ffff:')) {
    const suffix = ip.slice(7);
    if (net.isIP(suffix) === 4) return addressType(suffix);
    const pieces = suffix.split(':');
    if (pieces.length !== 2 || !pieces.every(part => /^[a-f0-9]{1,4}$/.test(part))) return 'blocked';
    const a = parseInt(pieces[0],16), b = parseInt(pieces[1],16);
    return addressType(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  if (net.isIP(ip) === 4) {
    const [a,b,c,d] = ip.split('.').map(Number);
    if (a === 0 || a === 169 && b === 254 || a >= 224 || ip === '100.100.100.200' || ip === '168.63.129.16' || a === 192 && b === 0 && c === 0) return 'blocked';
    if (a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127) return 'private';
    if (a === 192 && b === 0 && c === 2 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return 'blocked';
    return 'public';
  }
  if (net.isIP(ip) === 6) {
    if (ip === '::' || ip === 'fd00:ec2::254' || /^(fe[89ab]|ff)/.test(ip) || ip.startsWith('2001:db8:')) return 'blocked';
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1' || /^(fc|fd)[a-f0-9]{2}:/.test(ip)) return 'private';
    return /^(2|3)[a-f0-9]{3}:/.test(ip) ? 'public' : 'blocked';
  }
  return 'blocked';
}
export async function validateMcpTarget(value) {
  text(value,'MCP endpoint',2048);
  let url; try { url = new URL(value); } catch { fail('MCP endpoint URL is invalid.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('Use an http(s) MCP endpoint without embedded credentials, query strings or fragments.');
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  let addresses, timer;
  try {
    addresses = net.isIP(hostname) ? [{address:hostname,family:net.isIP(hostname)}] : await Promise.race([
      lookup(hostname,{all:true}),
      new Promise((_resolve,reject) => { timer = setTimeout(() => reject(new Error('MCP DNS lookup timed out.')),5000); }),
    ]);
  } catch { fail('MCP hostname could not be safely resolved.'); }
  finally { clearTimeout(timer); }
  if (!addresses.length || addresses.some(item => addressType(item.address) === 'blocked')) fail('MCP metadata, link-local, unspecified and reserved addresses are blocked.');
  if (url.protocol === 'http:' && addresses.some(item => addressType(item.address) !== 'private')) fail('Public MCP servers require HTTPS. HTTP is limited to private and loopback addresses.');
  return {url,addresses};
}
export function validateMcpExecutable(command,commandStats,cwdStats,platform=process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(command)) fail('MCP executable must be an absolute path.');
  if (!commandStats.isFile() || !cwdStats.isDirectory()) fail('MCP executable must be a regular file and cwd must be a directory.');
  if (platform === 'win32') {
    if (paths.extname(command).toLowerCase() !== '.exe') fail('Windows MCP commands must be .exe executables. Pass script files as arguments to Node or Python; batch and shell scripts are not executed directly.');
  } else if (!(commandStats.mode & 0o111)) fail('MCP executable must have execute permission.');
}
export function windowsProcessTreeCommand(pid,systemRoot=process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows') {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('MCP child process ID is invalid.');
  if (typeof systemRoot !== 'string' || !/^[a-zA-Z]:[\\/]/.test(systemRoot) || systemRoot.includes('\0')) fail('Windows system directory is invalid.');
  return {command:path.win32.join(systemRoot,'System32','taskkill.exe'),args:['/PID',String(pid),'/T','/F']};
}

export async function validateMcpConfig(input,existing) {
  if (!record(input)) fail('MCP configuration must be an object.');
  const allowed = new Set(['id','name','transport','enabled','url','bearerToken','command','args','env','cwd']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Unsupported MCP configuration field: ${key}.`);
  const transport = input.transport ?? existing?.transport ?? 'http';
  if (!['http','stdio'].includes(transport)) fail('MCP transport must be http or stdio.');
  const result = {name:text(input.name ?? existing?.name,'MCP server name',80),transport,enabled:input.enabled ?? existing?.enabled ?? true};
  if (typeof result.enabled !== 'boolean') fail('MCP enabled must be a boolean.');
  const id = input.id ?? existing?.id;
  if (id !== undefined) { text(id,'MCP ID',64); if (!/^[a-zA-Z0-9._-]+$/.test(id) || ['__proto__','constructor','prototype'].includes(id)) fail('MCP ID is invalid.'); result.id=id; }
  if (transport === 'http') {
    if (['command','args','env','cwd'].some(key => input[key] !== undefined)) fail('HTTP MCP configuration cannot contain stdio settings.');
    const target = await validateMcpTarget(input.url ?? existing?.url);
    result.url = target.url.href;
    const token = input.bearerToken ?? (existing?.transport === 'http' ? existing.bearerToken : undefined);
    if (token !== undefined) { text(token,'Bearer token',8192,true); if (/[^\x21-\x7e]/.test(token)) fail('Bearer token must contain visible ASCII without spaces.'); if (token) result.bearerToken=token; }
  } else {
    if (input.url !== undefined || input.bearerToken !== undefined) fail('Stdio MCP configuration cannot contain HTTP settings.');
    result.command=text(input.command ?? existing?.command,'MCP executable',4096);
    if (!path.isAbsolute(result.command)) fail('MCP executable must be an absolute path.');
    result.args=input.args ?? existing?.args ?? [];
    if (!Array.isArray(result.args) || result.args.length > 64 || result.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) fail('MCP args must contain at most 64 strings of at most 8192 characters.');
    result.args=[...result.args];
    result.cwd=text(input.cwd ?? existing?.cwd,'MCP working directory',4096);
    if (!path.isAbsolute(result.cwd)) fail('MCP working directory must be an absolute path.');
    result.env=input.env ?? (existing?.transport === 'stdio' ? existing.env : undefined) ?? {};
    if (!record(result.env) || Object.keys(result.env).length > 64) fail('MCP env must be an object with at most 64 keys.');
    const env=Object.create(null);
    for (const [key,value] of Object.entries(result.env)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || ['__proto__','prototype','constructor'].includes(key)) fail('MCP environment variable name is invalid.');
      env[key]=text(value,'MCP environment value',16384,true);
    }
    result.env=env;
    const [commandStats,cwdStats] = await Promise.all([fs.stat(result.command),fs.stat(result.cwd)]).catch(() => fail('MCP executable or working directory is unavailable.'));
    validateMcpExecutable(result.command,commandStats,cwdStats);
  }
  checkedJSON(result);
  return result;
}
export function publicMcpConfig(config) {
  const {bearerToken,env,...visible}=config;
  return {...visible,hasToken:!!bearerToken,...(config.transport === 'stdio' ? {envKeys:Object.keys(env || {})} : {})};
}

function rpcResult(message,id) {
  if (!record(message) || message.jsonrpc !== '2.0' || message.id !== id) fail('MCP returned an invalid JSON-RPC response.');
  if (message.error) {
    const error = new Error(typeof message.error.message === 'string' ? message.error.message.slice(0,4096) : 'MCP request failed.');
    error.code=message.error.code; throw error;
  }
  if (!Object.hasOwn(message,'result')) fail('MCP response did not contain a result.');
  return message.result;
}
export function createMcpClient(input,options={}) {
  const snapshot=structuredClone(input);
  const timeout=options.timeout ?? 15000;
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 120000) fail('MCP timeout must be between 50 and 120000 ms.');
  let config, configPromise, initialized, initializationPromise, protocolVersion, sessionId, nextId=1;
  let child, closed=false, closePromise, windowsKillPromise, stdoutBuffer='', stdoutBytes=0, processReleased=false;
  const active=new Map(), stdioPending=new Map(), background=new Set();
  function track(promise) { background.add(promise); promise.finally(() => background.delete(promise)).catch(() => {}); return promise; }
  async function ready() { if (closed) fail('MCP client is closed.'); if (!configPromise) configPromise=validateMcpConfig(snapshot).then(value => config=value); const value=await configPromise; if (closed || options.signal?.aborted) fail('MCP client is closed.'); return value; }
  function releaseProcess() { if (child && !processReleased) { processReleased=true; processCount--; } }
  function rejectStdio(error) { for (const waiter of stdioPending.values()) waiter.reject(error); stdioPending.clear(); }
  function kill(signal) {
    if (!child?.pid) return Promise.resolve();
    if (process.platform !== 'win32') { try { process.kill(-child.pid,signal); } catch {} return Promise.resolve(); }
    if (windowsKillPromise) return windowsKillPromise;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    let invocation;
    try { invocation = windowsProcessTreeCommand(child.pid); } catch { try { child.kill(signal); } catch {} return Promise.resolve(); }
    windowsKillPromise = new Promise(resolve => {
      execFile(invocation.command,invocation.args,{shell:false,windowsHide:true,timeout:1000,maxBuffer:65536},error => {
        if (error && child.exitCode === null && child.signalCode === null) { try { child.kill(signal); } catch {} }
        resolve();
      });
    });
    return windowsKillPromise;
  }
  function stdioWrite(message) {
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('MCP process is unavailable.'));
    return new Promise((resolve,reject) => child.stdin.write(checkedJSON(message)+'\n',error => error ? reject(error) : resolve()));
  }
  async function onServerMessage(message) {
    if (!record(message) || message.jsonrpc !== '2.0') fail('MCP server sent malformed JSON-RPC.');
    if (Object.hasOwn(message,'id') && typeof message.method === 'string') {
      const response=message.method === 'ping' ? {jsonrpc:'2.0',id:message.id,result:{}} : {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client method not supported.'}};
      if (config.transport === 'stdio') await stdioWrite(response);
      else await httpExchange(response,{notification:true,limitTimeout:2000});
    }
  }
  async function startStdio() {
    if (closed || options.signal?.aborted) fail('MCP client is closed.');
    if (child) return;
    if (processCount >= 4) fail('At most four MCP processes can run at once.');
    if (typeof process.getuid === 'function' && process.getuid() === 0 && (!Number.isInteger(options.stdioUid) || options.stdioUid <= 0)) fail('Stdio MCP servers must run under the nonroot service account.');
    if (options.stdioUid !== undefined && (!Number.isInteger(options.stdioUid) || options.stdioUid <= 0)) fail('Invalid internal MCP subprocess UID.');
    const env={PATH:process.env.PATH || '/usr/local/bin:/usr/bin:/bin'};
    for (const key of ['HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','XDG_RUNTIME_DIR',...(process.platform === 'win32' ? ['SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'] : [])]) if (process.env[key]) env[key]=process.env[key];
    Object.assign(env,config.env);
    child=spawn(config.command,config.args,{cwd:config.cwd,env,shell:false,stdio:['pipe','pipe','pipe'],detached:process.platform !== 'win32',...(options.stdioUid !== undefined ? {uid:options.stdioUid,gid:options.stdioGid ?? options.stdioUid} : {})});
    processCount++;
    child.stdin.on('error',error => rejectStdio(new Error(`MCP input failed: ${error.code || 'I/O error'}.`)));
    child.on('error',error => { releaseProcess(); rejectStdio(new Error(`MCP process could not start: ${error.code || 'spawn error'}.`)); });
    child.on('exit',() => { releaseProcess(); rejectStdio(new Error('MCP process exited.')); });
    child.stderr.on('data',() => {}); // Never forward server stderr: it may contain credentials.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk => {
      stdoutBytes+=Buffer.byteLength(chunk); stdoutBuffer+=chunk;
      if (stdoutBytes > 32 * MAX_RESPONSE || Buffer.byteLength(stdoutBuffer) > MAX_RESPONSE) { rejectStdio(new Error('MCP process exceeded output limits.')); kill('SIGKILL'); return; }
      let index;
      while ((index=stdoutBuffer.indexOf('\n')) >= 0) {
        const line=stdoutBuffer.slice(0,index).trim(); stdoutBuffer=stdoutBuffer.slice(index+1);
        if (!line) continue;
        let message;
        try { message=JSON.parse(line); if (!record(message) || message.jsonrpc !== '2.0') throw new Error(); }
        catch { rejectStdio(new Error('MCP stdout must contain newline-delimited JSON-RPC only.')); kill('SIGKILL'); return; }
        const waiter=stdioPending.get(message.id);
        if (waiter && typeof message.method !== 'string') { stdioPending.delete(message.id); waiter.resolve(message); }
        else track(onServerMessage(message).catch(() => {}));
      }
    });
  }
  async function httpResponse(method,message,signal,{resumeId}={}) {
    const {url,addresses}=await validateMcpTarget(config.url);
    if (closed && method !== 'DELETE' && message?.method !== 'notifications/cancelled') fail('MCP client is closed.');
    if (signal?.aborted) throw signal.reason || new Error('MCP request cancelled.');
    const serialized=message === undefined ? undefined : checkedJSON(message);
    const headers={Accept:'application/json, text/event-stream'};
    if (serialized !== undefined) { headers['Content-Type']='application/json'; headers['Content-Length']=Buffer.byteLength(serialized); }
    if (config.bearerToken) headers.Authorization=`Bearer ${config.bearerToken}`;
    if (protocolVersion) headers['MCP-Protocol-Version']=protocolVersion;
    if (sessionId) headers['MCP-Session-Id']=sessionId;
    if (resumeId) headers['Last-Event-ID']=resumeId;
    const address=addresses[0];
    return new Promise((resolve,reject) => {
      const request=(url.protocol === 'https:' ? https : http).request({protocol:url.protocol,hostname:url.hostname.replace(/^\[|\]$/g,''),port:url.port || undefined,path:url.pathname,method,headers,signal,lookup:(_hostname,opts,callback) => opts.all ? callback(null,addresses) : callback(null,address.address,address.family)},response => resolve(response));
      request.setTimeout(timeout,() => request.destroy(new Error('MCP transport timed out.')));
      request.on('error',reject); request.end(serialized);
    });
  }
  async function readBytes(response) {
    const chunks=[]; let size=0;
    for await (const chunk of response) { size+=chunk.length; if (size > MAX_RESPONSE) { response.destroy(); fail('MCP response exceeded the allowed size.'); } chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function readSSE(response,id) {
    let buffer='', data=[], total=0, lastId, retry=1000;
    const decoder=new TextDecoder();
    async function event() {
      if (!data.length) return;
      const encoded=data.join('\n'); data=[];
      if (!encoded.trim()) return;
      let message; try { message=JSON.parse(encoded); } catch { fail('MCP returned invalid SSE JSON.'); }
      if (message.id === id && typeof message.method !== 'string') return message;
      await onServerMessage(message);
    }
    for await (const chunk of response) {
      total+=chunk.length; if (total > MAX_RESPONSE) { response.destroy(); fail('MCP SSE response exceeded the allowed size.'); }
      buffer+=decoder.decode(chunk,{stream:true});
      for (;;) {
        const index=buffer.search(/[\r\n]/);
        if (index < 0 || buffer[index] === '\r' && index === buffer.length-1) break;
        const line=buffer.slice(0,index), width=buffer[index] === '\r' && buffer[index+1] === '\n' ? 2 : 1;
        buffer=buffer.slice(index+width);
        if (!line) { const message=await event(); if (message) { response.destroy(); return {message,lastId,retry}; } }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
        else if (line.startsWith('id:')) { const value=line.slice(3).replace(/^ /,''); if (value.length > 1024 || /[\0\r\n]/.test(value)) fail('MCP SSE event ID is invalid.'); lastId=value; }
        else if (line.startsWith('retry:')) { const value=line.slice(6).trim(); if (/^\d+$/.test(value)) retry=Math.min(Number(value),2000); }
      }
    }
    // A terminating event requires its blank delimiter; a truncated stream can only be resumed with an event ID.
    return {lastId,retry};
  }
  async function httpExchange(message,{signal,notification=false,limitTimeout=timeout,method='POST'}={}) {
    const controller=new AbortController();
    const abort=() => controller.abort(signal.reason || new Error('MCP request cancelled.'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(() => controller.abort(new Error('MCP request timed out.')),limitTimeout);
    try {
      let response=await httpResponse(method,message,controller.signal);
      if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); fail('MCP redirects are blocked. Use the direct endpoint.'); }
      if (method === 'DELETE') { response.destroy(); return; }
      if (response.statusCode === 404 && sessionId) { response.resume(); sessionId=undefined; initialized=undefined; initializationPromise=undefined; protocolVersion=undefined; fail('MCP session expired. Reconnect before making another tool call.'); }
      if (response.statusCode < 200 || response.statusCode > 299) { response.destroy(); fail(`MCP endpoint returned HTTP ${response.statusCode}.`); }
      if (notification) { if (response.statusCode !== 202) { response.destroy(); fail('MCP notification was not accepted with HTTP 202.'); } response.destroy(); return; }
      const assigned=response.headers['mcp-session-id'];
      if (message.method === 'initialize' && assigned !== undefined) {
        if (typeof assigned !== 'string' || assigned.length > 1024 || !/^[\x21-\x7e]+$/.test(assigned)) { response.destroy(); fail('MCP session ID is invalid.'); }
        sessionId=assigned;
      }
      for (let retries=0;;retries++) {
        const type=(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type === 'application/json') {
          let parsed; try { parsed=JSON.parse(await readBytes(response)); } catch (error) { if (error.message.includes('allowed size')) throw error; fail('MCP returned invalid JSON.'); }
          return parsed;
        }
        if (type !== 'text/event-stream') { response.destroy(); fail('MCP endpoint must return application/json or text/event-stream.'); }
        const stream=await readSSE(response,message.id);
        if (stream.message) return stream.message;
        if (!stream.lastId || retries >= 2) fail('MCP SSE stream ended before returning a response.');
        await new Promise((resolve,reject) => {
          const stop=() => { clearTimeout(wait); controller.signal.removeEventListener('abort',stop); reject(controller.signal.reason); };
          const wait=setTimeout(() => { controller.signal.removeEventListener('abort',stop); resolve(); },stream.retry);
          if (controller.signal.aborted) stop(); else controller.signal.addEventListener('abort',stop,{once:true});
        });
        response=await httpResponse('GET',undefined,controller.signal,{resumeId:stream.lastId});
        if (response.statusCode !== 200) { response.destroy(); fail(`MCP SSE resumption returned HTTP ${response.statusCode}.`); }
      }
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  async function notify(method,params) {
    if (closed && method === 'notifications/initialized') fail('MCP client is closed.');
    const message={jsonrpc:'2.0',method,...(params ? {params} : {})};
    if (config.transport === 'stdio') return stdioWrite(message);
    return httpExchange(message,{notification:true,limitTimeout:2000});
  }
  async function request(method,params) {
    await ready();
    if (closed || options.signal?.aborted) fail('MCP client is closed.');
    if (active.size >= 8) fail('Too many concurrent MCP requests.');
    const id=nextId++, controller=new AbortController(); active.set(id,controller);
    const message={jsonrpc:'2.0',id,method,params};
    const cancelled=() => { if (method !== 'initialize') track(notify('notifications/cancelled',{requestId:id,reason:'Client cancelled or timed out.'}).catch(() => {})); };
    controller.signal.addEventListener('abort',cancelled,{once:true});
    const timer=setTimeout(() => controller.abort(new Error('MCP request timed out.')),timeout);
    try {
      let response;
      if (config.transport === 'http') response=await httpExchange(message,{signal:controller.signal});
      else {
        await startStdio();
        response=await new Promise((resolve,reject) => {
          const abort=() => { stdioPending.delete(id); reject(controller.signal.reason); };
          stdioPending.set(id,{resolve:value => { controller.signal.removeEventListener('abort',abort); resolve(value); },reject:error => { controller.signal.removeEventListener('abort',abort); reject(error); }});
          controller.signal.addEventListener('abort',abort,{once:true});
          if (controller.signal.aborted) abort(); else stdioWrite(message).catch(error => { stdioPending.delete(id); controller.signal.removeEventListener('abort',abort); reject(error); });
        });
      }
      return rpcResult(response,id);
    } finally { clearTimeout(timer); active.delete(id); controller.signal.removeEventListener('abort',cancelled); }
  }
  async function initialize() {
    if (closed || options.signal?.aborted) fail('MCP client is closed.');
    if (initialized) return initialized;
    if (initializationPromise) return initializationPromise;
    initializationPromise=(async () => {
      const result=await request('initialize',{protocolVersion:MCP_PROTOCOL_VERSIONS[0],capabilities:{},clientInfo:{name:'spark-ollama-manager',version:'1.2.0'}});
      if (!record(result) || !MCP_PROTOCOL_VERSIONS.includes(result.protocolVersion) || !record(result.capabilities) || !record(result.serverInfo)) fail('MCP initialization returned an unsupported protocol or invalid capabilities.');
      protocolVersion=result.protocolVersion;
      await notify('notifications/initialized');
      if (closed || options.signal?.aborted) fail('MCP client is closed.');
      initialized=result;
      return result;
    })().catch(async error => { await close(); throw error; });
    return initializationPromise;
  }
  async function listTools() {
    const info=await initialize(); if (!info.capabilities.tools) return [];
    const tools=[], names=new Set(), cursors=new Set(); let cursor;
    for (let page=0;page<20;page++) {
      const result=await request('tools/list',cursor ? {cursor} : {});
      if (!record(result) || !Array.isArray(result.tools)) fail('MCP tools/list result is invalid.');
      for (const tool of result.tools) {
        if (!record(tool) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 128 || !record(tool.inputSchema) || tool.inputSchema.type !== 'object') fail('MCP tool definition is invalid.');
        if (names.has(tool.name)) fail('MCP tools/list returned duplicate tool names.');
        names.add(tool.name); tools.push(tool); if (tools.length > MAX_TOOLS) fail('MCP tool catalog exceeds 500 tools.');
      }
      checkedJSON(tools,MAX_RESPONSE);
      if (result.nextCursor === undefined || result.nextCursor === '') return tools;
      cursor=text(result.nextCursor,'MCP pagination cursor',2048);
      if (cursors.has(cursor)) fail('MCP tools/list pagination cursor repeated.'); cursors.add(cursor);
    }
    fail('MCP tool catalog exceeds 20 pages.');
  }
  async function callTool(name,args={}) {
    text(name,'MCP tool name',128); if (!record(args)) fail('MCP tool arguments must be an object.'); checkedJSON(args);
    const info=await initialize(); if (!info.capabilities.tools) fail('This MCP server does not expose tools.');
    const result=await request('tools/call',{name,arguments:args});
    if (!record(result) || !Array.isArray(result.content) || result.content.length > 100) fail('MCP tools/call result is invalid.');
    return result;
  }
  async function close() {
    if (closePromise) return closePromise;
    closed=true;
    closePromise=(async () => {
      options.signal?.removeEventListener('abort',onAbort);
      for (const controller of active.values()) controller.abort(new Error('MCP client closed.'));
      await Promise.allSettled([...background]);
      if (config?.transport === 'http' && sessionId) await httpExchange(undefined,{method:'DELETE',limitTimeout:1500}).catch(() => {});
      sessionId=undefined;
      if (child) {
        // Windows has no process groups: terminate the tree while its parent PID still exists.
        if (process.platform === 'win32') await kill('SIGKILL');
        if (!child.stdin.destroyed) child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise(resolve => {
            const terminate=setTimeout(() => kill('SIGTERM'),250);
            const force=setTimeout(() => { kill('SIGKILL'); resolve(); },1000);
            child.once('exit',() => { clearTimeout(terminate); clearTimeout(force); resolve(); });
          });
        }
        await kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); releaseProcess();
      }
    })();
    return closePromise;
  }
  const onAbort=() => { void close(); };
  if (options.signal?.aborted) closed=true; else options.signal?.addEventListener('abort',onAbort,{once:true});
  return {initialize,listTools,callTool,close};
}
