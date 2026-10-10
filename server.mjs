#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateMcpConfig, publicMcpConfig, createMcpClient } from './mcp-client.mjs';

const scrypt = promisify(scryptCallback);
const execFile = promisify(execFileCallback);
export const VERSION = '1.2.0';
export const DEVELOPER = 'Solomon';
const BASE = path.dirname(fileURLToPath(import.meta.url));
const MAX_JSON = 1024 * 1024;
const MAX_CHAT = 32 * 1024 * 1024;
const MAX_UPSTREAM_JSON = 24 * 1024 * 1024;
const SESSION_AGE = 12 * 60 * 60 * 1000;
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:\-]{0,255}$/;
const STOPPED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function reject(status, message) { throw new HttpError(status, message); }
function object(value, label = 'Request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(400, `${label} must be an object.`);
  return value;
}
function fields(value, allowed) {
  object(value);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reject(400, `Unsupported field: ${key}.`);
}
function string(value, label, max = 256, { optional = false, empty = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /\0/.test(value)) reject(400, `${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  return value;
}
function model(value, label = 'Model') {
  string(value, label, 256);
  if (!MODEL_RE.test(value) || value.includes('..') || value.includes('//') || value.startsWith('/')) reject(400, `${label} contains invalid characters.`);
  return value;
}
function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) reject(400, `${label} must be between ${min} and ${max}.`);
  return value;
}
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function isPrivateAddress(address) {
  let ip = address.toLowerCase().split('%')[0];
  if (net.isIP(ip) === 6) { try { ip = new URL(`http://[${ip}]`).hostname.slice(1,-1); } catch { return false; } }
  if (ip === '100.100.100.200' || ip === 'fd00:ec2::254') return false;
  if (ip.startsWith('::ffff:')) {
    const suffix = ip.slice(7);
    if (net.isIP(suffix) === 4) return isPrivateAddress(suffix);
    const parts = suffix.split(':');
    if (parts.length === 2 && parts.every(x => /^[0-9a-f]{1,4}$/.test(x))) {
      const a = parseInt(parts[0], 16), b = parseInt(parts[1], 16);
      return isPrivateAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    return false;
  }
  if (net.isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIP(ip) === 6) return ip === '::1' || ip === '0:0:0:0:0:0:0:1' || /^(fc|fd)[0-9a-f]{2}:/.test(ip);
  return false;
}
export async function validateTarget(value) {
  string(value, 'Server URL', 512);
  let url;
  try { url = new URL(value); } catch { reject(400, 'Server URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') reject(400, 'Use an http(s) server origin without credentials, paths, queries or fragments.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    if (net.isIP(hostname)) addresses = [{address:hostname,family:net.isIP(hostname)}];
    else {
      let timer;
      try { addresses = await Promise.race([lookup(hostname,{all:true}), new Promise((_resolve,rejectLookup) => { timer = setTimeout(() => rejectLookup(new Error('DNS lookup timed out.')),5000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  catch { reject(400, 'The server hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(({address}) => !isPrivateAddress(address))) reject(400, 'Only private, loopback and Tailscale addresses are allowed. Public and link-local targets are blocked.');
  return {url, addresses};
}
async function atomicJSON(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {mode:0o600});
    await fs.rename(temp, filename);
    await fs.chmod(filename, 0o600);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
async function loadJSON(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path.basename(filename)}: ${error.message}`); }
}
export async function setPassword(dataDir, password) {
  string(password, 'Password', 1024);
  if (password.length < 12) throw new Error('Use at least 12 characters for the administrator password.');
  await fs.mkdir(dataDir, {recursive:true, mode:0o700});
  const salt = randomBytes(32).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  await atomicJSON(path.join(dataDir, 'credentials.json'), {salt, hash});
}
async function parseBody(req, limit = MAX_JSON) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); reject(415, 'Content-Type must be application/json.'); }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) { req.resume(); reject(413,'Request body is too large.'); }
  return await new Promise((resolve,rejectPromise) => {
    let size = 0, settled = false;
    const chunks = [];
    const cleanup = () => { req.off('data',onData); req.off('end',onEnd); req.off('error',onError); req.off('aborted',onAborted); };
    const fail = error => { if (settled) return; settled = true; cleanup(); req.resume(); rejectPromise(error); };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) return fail(new HttpError(413,'Request body is too large.'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true; cleanup();
      try { resolve(object(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch (error) { rejectPromise(error instanceof HttpError ? error : new HttpError(400,'Request body contains invalid JSON.')); }
    };
    const onError = () => fail(new HttpError(400,'Request body could not be read.'));
    const onAborted = () => fail(new HttpError(400,'Request body was interrupted.'));
    req.on('data',onData); req.once('end',onEnd); req.once('error',onError); req.once('aborted',onAborted);
  });
}
function sendJSON(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}
async function boundedJSON(response, limit = MAX_UPSTREAM_JSON) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) { response.destroy(); throw new Error('Ollama response exceeded the allowed size.'); }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let result;
  try { result = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Ollama returned invalid JSON (HTTP ${response.statusCode}).`); }
  if (response.statusCode < 200 || response.statusCode > 299) throw new Error(typeof result.error === 'string' ? result.error : `Ollama returned HTTP ${response.statusCode}.`);
  if (result.error) throw new Error(String(result.error));
  return result;
}
async function* ndjson(response) {
  if (response.statusCode < 200 || response.statusCode > 299) { await boundedJSON(response); return; }
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of response) {
    pending += decoder.decode(chunk, {stream:true});
    if (pending.length > 4 * 1024 * 1024) { response.destroy(); throw new Error('Ollama stream contained an oversized line.'); }
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0,index).trim(); pending = pending.slice(index + 1);
      if (!line) continue;
      let data; try { data = JSON.parse(line); } catch { throw new Error('Ollama returned an invalid streaming response.'); }
      if (data.error) throw new Error(String(data.error));
      yield data;
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    let data; try { data = JSON.parse(pending); } catch { throw new Error('Ollama returned an incomplete streaming response.'); }
    if (data.error) throw new Error(String(data.error));
    yield data;
  }
}
async function ollamaRequest(server, endpoint, {method = 'GET', body, rawBody, contentLength, onUploadProgress, signal, timeout = 15000} = {}) {
  const {url, addresses} = await validateTarget(server.url);
  if (signal?.aborted) throw signal.reason || new Error('Cancelled.');
  const address = addresses.find(item => item.family === 4) || addresses[0];
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers = {Accept:'application/json'};
  if (serialized !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(serialized); }
  if (rawBody) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Length'] = contentLength; }
  return await new Promise((resolve,rejectPromise) => {
    const request = (url.protocol === 'https:' ? https : http).request({
      protocol:url.protocol, hostname:url.hostname.replace(/^\[|\]$/g,''), port:url.port || undefined,
      method, path:endpoint, headers, signal,autoSelectFamily:true,autoSelectFamilyAttemptTimeout:250,
      lookup: (_host, options, cb) => options.all ? cb(null,addresses) : cb(null,address.address,address.family),
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); rejectPromise(new Error('Ollama redirects are blocked. Use the direct private server address.')); }
      else resolve(response);
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Ollama request timed out.')));
    request.on('error', rejectPromise);
    if (rawBody) {
      rawBody.on('error', error => request.destroy(error));
      request.on('close', () => { if (!rawBody.readableEnded) rawBody.destroy(); });
      if (onUploadProgress) rawBody.on('data', onUploadProgress);
      rawBody.pipe(request);
    } else request.end(serialized);
  });
}
function publicJob(job) { const {input, _lastSaved, ...visible} = job; return visible; }
function titleFrom(message) { return message.replace(/\s+/g, ' ').trim().slice(0, 64) || 'New conversation'; }
async function systemStatus(importRoots, dataDir) {
  const system = {hostname:os.hostname(),platform:os.platform(),arch:os.arch(),uptime:os.uptime(),totalMemory:os.totalmem(),freeMemory:os.freemem(),load:os.loadavg(),disks:[],gpus:[]};
  const paths = [...new Set([dataDir, ...importRoots])];
  await Promise.all(paths.map(async root => {
    try { const stat = await fs.statfs(root); system.disks.push({path:root,total:Number(stat.blocks) * Number(stat.bsize),free:Number(stat.bavail) * Number(stat.bsize)}); } catch {}
  }));
  try {
    const {stdout} = await execFile('nvidia-smi', ['--query-gpu=name,uuid,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw', '--format=csv,noheader,nounits'], {timeout:4000,maxBuffer:65536,windowsHide:true});
    system.gpus = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name,uuid,temp,util,used,total,power] = line.split(',').map(x => x.trim());
      const finite = value => /^\d+(?:\.\d+)?$/.test(value || '') ? Number(value) : null;
      const memoryTotal = finite(total), memoryUsed = finite(used);
      return {name,uuid,temperature:finite(temp),utilization:finite(util),memoryUsed:memoryUsed === null ? null : memoryUsed * 1024 * 1024,memoryTotal:memoryTotal === null ? null : memoryTotal * 1024 * 1024,power:finite(power),unifiedMemory:memoryTotal === null};
    });
  } catch { system.gpuNote = 'GPU telemetry unavailable; NVIDIA tools may be missing or this GPU may not expose every metric.'; }
  return system;
}

function redactMcpSecrets(text, configurations) {
  let result = String(text ?? '');
  for (const config of Array.isArray(configurations) ? configurations : [configurations]) {
    const secrets = [config?.bearerToken,...Object.values(config?.env || {})].filter(value => typeof value === 'string' && value.length >= 4).sort((a,b) => b.length - a.length);
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
  }
  return result;
}
function sanitizeMcpValue(value, configurations) {
  if (typeof value === 'string') return redactMcpSecrets(value,configurations);
  if (Array.isArray(value)) return value.map(item => sanitizeMcpValue(item,configurations));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [redactMcpSecrets(key,configurations),sanitizeMcpValue(item,configurations)]));
  return value;
}
function formatToolResult(result, configuration) {
  result = sanitizeMcpValue(result,configuration);
  const content = Array.isArray(result?.content) ? result.content.map(block => {
    if (typeof block?.text === 'string') return block.text;
    if (block?.type === 'resource' && typeof block.resource?.text === 'string') return block.resource.text;
    if (block?.type === 'image') return `[Image result: ${block.mimeType || 'image'}]`;
    if (block?.type === 'audio') return `[Audio result: ${block.mimeType || 'audio'}]`;
    return JSON.stringify(block);
  }).join('\n') : '';
  const structured = result?.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent);
  return redactMcpSecrets([content,structured].filter(Boolean).join('\n') || 'Tool returned no content.',configuration).slice(0,262144);
}

const OFFICIAL_REPOSITORY = 'https://github.com/solomongs/Ollam-manager';
const OFFICIAL_RELEASE_API = 'https://api.github.com/repos/solomongs/Ollam-manager/releases/latest';
const INSTALLATION_MODES = new Set(['desktop','deb','dgx','service','source','container']);
function publicReleaseAddress(address) {
  let ip = address.toLowerCase().split('%')[0];
  if (net.isIP(ip) === 6) { try { ip = new URL(`http://[${ip}]`).hostname.slice(1,-1); } catch { return false; } }
  if (net.isIP(ip) === 4) {
    const [a,b,c] = ip.split('.').map(Number);
    return !isPrivateAddress(ip) && a !== 0 && a < 224 && !(a === 169 && b === 254) && !(a === 192 && b === 0 && [0,2].includes(c)) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113) && ip !== '168.63.129.16';
  }
  return net.isIP(ip) === 6 && /^[23][0-9a-f]{3}:/.test(ip) && !ip.startsWith('2001:db8:') && !ip.startsWith('2002:');
}
async function requestOfficialRelease(_fixedUrl,{signal} = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('Release check cancelled.'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort',onAbort,{once:true});
  const timer = setTimeout(() => controller.abort(new Error('Release check timed out.')),5000);
  try {
    const addresses = await Promise.race([
      lookup('api.github.com',{all:true}),
      new Promise((_resolve,rejectPromise) => controller.signal.addEventListener('abort',() => rejectPromise(new Error('Release check timed out.')),{once:true})),
    ]);
    if (!addresses.length || addresses.some(item => !publicReleaseAddress(item.address))) throw new Error('Official release host resolved to an unsafe address.');
    if (controller.signal.aborted) throw new Error('Release check timed out.');
    const response = await new Promise((resolve,rejectPromise) => {
      const request = https.request({hostname:'api.github.com',port:443,path:'/repos/solomongs/Ollam-manager/releases/latest',method:'GET',signal:controller.signal,autoSelectFamily:true,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':`Spark-Ollama-Manager/${VERSION}`},lookup:(_hostname,opts,callback) => opts.all ? callback(null,addresses) : callback(null,addresses[0].address,addresses[0].family)},resolve);
      request.on('error',rejectPromise); request.end();
    });
    if (response.statusCode === 404) { response.resume(); throw new Error('An official GitHub release has not been published yet.'); }
    if (response.statusCode >= 300 && response.statusCode <= 399) { response.resume(); throw new Error('Release API redirects are blocked.'); }
    if (response.statusCode !== 200) { response.resume(); throw new Error(`Official release API returned HTTP ${response.statusCode}.`); }
    return await boundedJSON(response,512 * 1024);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',onAbort); controller.abort(); }
}
function releaseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const component = '(?:0|[1-9][0-9]{0,5})';
  const match = tag.match(new RegExp(`^v?(${component}\\.${component}\\.${component})$`));
  return match ? match[1] : null;
}
function newerVersion(left,right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
function updateMetadata(installationMode, latest) {
  const version = latest.status === 'available' ? latest.version : VERSION;
  const prefix = `${OFFICIAL_REPOSITORY}/releases/download/v${version}`;
  const windowsX64 = `${prefix}/Spark-Ollama-Manager-${version}-windows-x64-setup.exe`;
  const windowsArm64 = `${prefix}/Spark-Ollama-Manager-${version}-windows-arm64-setup.exe`;
  const armDesktop = installationMode === 'desktop' && process.platform === 'win32' && process.arch === 'arm64';
  const sourceUpdateCommand = 'node scripts/update.mjs --check\nnode scripts/update.mjs';
  let command = '', instructions;
  if (installationMode === 'desktop') instructions = 'Download the matching Windows installer from the official Releases page, close the manager, and run the new installer. Your settings and conversations stay in your user profile.';
  else if (installationMode === 'deb') { command = `sudo apt install ./spark-ollama-manager_${version}_arm64.deb`; instructions = 'Download the official DGX ARM64 package, run the command from its download folder, and reopen the manager. The package keeps settings and model files separate from application code.'; }
  else if (installationMode === 'dgx' || installationMode === 'service') { command = `${sourceUpdateCommand}\nsudo bash install.sh`; instructions = 'Run these commands from your clean Git source checkout on the DGX. The updater verifies the official origin and fast-forwards main; the installer deploys the reviewed code and preserves manager data.'; }
  else if (installationMode === 'container') instructions = 'Pull the newer official image from ghcr.io/solomongs/ollam-manager (or rebuild the source), then recreate the container with its existing deployment configuration and the same persistent data volume.';
  else { command = sourceUpdateCommand; instructions = 'Run these commands in your clean official Git source checkout. Stop active chats and downloads, then restart the manager after updating. For a source ZIP installation, download and extract the new source separately while retaining your data folder.'; }
  return {installedVersion:VERSION,platform:process.platform,arch:process.arch,installationMode,repositoryUrl:OFFICIAL_REPOSITORY,sourceUrl:`${OFFICIAL_REPOSITORY}/archive/refs/heads/main.zip`,releasesUrl:`${OFFICIAL_REPOSITORY}/releases`,releaseApiUrl:OFFICIAL_RELEASE_API,
    packages:{windows:{url:armDesktop ? windowsArm64 : windowsX64,label:armDesktop ? 'Windows installer (ARM64)' : 'Windows installer (x64)',x64Url:windowsX64,x64Label:'Windows installer (x64)',arm64Url:windowsArm64,arm64Label:'Windows installer (ARM64)'},dgx:{url:`${prefix}/spark-ollama-manager_${version}_arm64.deb`,label:'DGX Spark package (ARM64)'},source:{url:`${OFFICIAL_REPOSITORY}/archive/refs/tags/v${version}.zip`,label:`Source archive (${version})`}},
    update:{command,gitCommand:sourceUpdateCommand,instructions},latest};
}

export async function createManager(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(BASE, 'data'));
  const publicDir = path.resolve(options.publicDir || path.join(BASE, 'public'));
  const host = options.host || process.env.HOST || '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT || 42010);
  const originSetting = Object.hasOwn(options,'publicOrigin') && options.publicOrigin !== undefined ? options.publicOrigin : process.env.PUBLIC_ORIGIN;
  let publicOrigin;
  if (originSetting) {
    const parsed = new URL(originSetting);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== originSetting.replace(/\/$/, '') || parsed.username || parsed.password) throw new Error('PUBLIC_ORIGIN must be one exact http(s) origin.');
    publicOrigin = parsed.origin;
  }
  const installationMode = options.installationMode || process.env.SPARK_INSTALLATION_MODE || 'source';
  if (!INSTALLATION_MODES.has(installationMode)) throw new Error('SPARK_INSTALLATION_MODE is invalid.');
  let latestRelease = {status:'not-checked'}, releaseCheckPromise;
  const releaseFetcher = options.releaseFetcher || requestOfficialRelease;
  const releaseTimeout = options.releaseCheckTimeoutMs ?? 5000;
  if (typeof releaseFetcher !== 'function' || !Number.isInteger(releaseTimeout) || releaseTimeout < 50 || releaseTimeout > 30000) throw new Error('Release-check options are invalid.');
  async function checkRelease() {
    if (latestRelease.checkedAt && Date.now() - Date.parse(latestRelease.checkedAt) < 5 * 60 * 1000) return latestRelease;
    if (releaseCheckPromise) return releaseCheckPromise;
    releaseCheckPromise = (async () => {
      const checkedAt = new Date().toISOString(), controller = new AbortController();
      controllers.set('update-check',controller);
      let timer;
      try {
        const stopped = new Promise((_resolve,rejectPromise) => {
          controller.signal.addEventListener('abort',() => rejectPromise(new Error('Release check timed out or was cancelled.')),{once:true});
          timer = setTimeout(() => controller.abort(),releaseTimeout);
        });
        const release = await Promise.race([releaseFetcher(OFFICIAL_RELEASE_API,{signal:controller.signal}),stopped]);
        const version = releaseVersion(release?.tag_name);
        if (!version || release.draft || release.prerelease) throw new Error('Official release metadata did not contain a stable version.');
        latestRelease = {status:newerVersion(version,VERSION) ? 'available' : 'current',version,checkedAt};
      } catch (error) { latestRelease = {status:'unavailable',checkedAt,error:String(error.message || 'Official releases could not be checked.').slice(0,512)}; }
      finally { clearTimeout(timer); controller.abort(); controllers.delete('update-check'); }
      return latestRelease;
    })().finally(() => { releaseCheckPromise = null; });
    return releaseCheckPromise;
  }
  const suppliedRoots = options.importRoots || (process.env.IMPORT_ROOTS || path.join(os.homedir(), 'Models')).split(path.delimiter);
  const importRoots = [];
  for (const root of suppliedRoots.filter(Boolean)) {
    const absolute = path.resolve(root);
    try { const real = await fs.realpath(absolute); if ((await fs.stat(real)).isDirectory()) importRoots.push(real); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(dataDir, {recursive:true,mode:0o700});
  await fs.chmod(dataDir, 0o700);
  const credentialsFile = path.join(dataDir, 'credentials.json');
  if (!await loadJSON(credentialsFile, null)) {
    const password = options.initialPassword || randomBytes(24).toString('base64url');
    await setPassword(dataDir, password);
    await fs.writeFile(path.join(dataDir, 'first-login.txt'), `${password}\n`, {mode:0o600,flag:'wx'}).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  const startupCredentials = await loadJSON(credentialsFile,null);
  if (!/^[a-f0-9]{64}$/.test(startupCredentials?.salt || '') || !/^[a-f0-9]{128}$/.test(startupCredentials?.hash || '')) throw new Error('Credentials file is invalid. Reset the administrator password with scripts/password.mjs.');
  await fs.chmod(credentialsFile,0o600);
  const stateFile = path.join(dataDir, 'state.json');
  const defaultUrl = options.ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  await validateTarget(defaultUrl);
  const initialServerName = string(options.initialServerName || (installationMode === 'desktop' ? 'Local Ollama' : 'DGX Spark'),'Initial server name',80);
  const state = await loadJSON(stateFile, {
    version:1,settings:{title:'Spark Ollama Manager',subtitle:'Your private AI workspace'},
    servers:[{id:'local',name:initialServerName,url:new URL(defaultUrl).origin}],activeServerId:'local',jobs:[],chats:{},mcpServers:[],
  });
  if (!state.settings || !Array.isArray(state.servers) || !Array.isArray(state.jobs) || !state.chats || typeof state.chats !== 'object') throw new Error('Saved state has an invalid structure.');
  state.mcpServers ??= [];
  if (!Array.isArray(state.mcpServers)) throw new Error('Saved MCP configuration is invalid.');
  for (const savedChat of Object.values(state.chats)) {
    for (const event of savedChat.toolEvents || []) if (['pending','running'].includes(event.status)) {
      event.status = 'cancelled'; event.content = 'Tool call cancelled by service restart.'; event.isError = true; event.completedAt = new Date().toISOString();
      savedChat.messages.push({role:'tool',tool_name:event.functionName || event.name,content:event.content});
      savedChat.updatedAt = event.completedAt;
    }
  }
  for (const job of state.jobs) if (['queued','running'].includes(job.status)) { job.status = 'interrupted'; job.message = 'Interrupted by service restart. Retry to continue.'; job.updatedAt = new Date().toISOString(); }
  let writeChain = Promise.resolve();
  function persist() {
    const snapshot = structuredClone(state);
    const write = writeChain.then(() => atomicJSON(stateFile, snapshot));
    writeChain = write.catch(() => {});
    return write;
  }
  await persist();
  const sessions = new Map();
  const loginAttempts = new Map();
  const controllers = new Map();
  const activeChats = new Map();
  const activeChatSessions = new Map();
  const activeMcpSelections = new Map();
  const pendingApprovals = new Map();
  const approvalTimeout = options.approvalTimeoutMs ?? 5 * 60 * 1000;
  const mcpFactory = options.mcpClientFactory || createMcpClient;
  let pumping = false, stopping = false;
  function selected(id = state.activeServerId) {
    string(id, 'Server ID', 64);
    const server = state.servers.find(item => item.id === id);
    if (!server) reject(404, 'Server not found.');
    return server;
  }
  async function jsonCall(server, endpoint, options) { return boundedJSON(await ollamaRequest(server, endpoint, options)); }
  function sessionFor(req) {
    const cookies = (req.headers.cookie || '').split(';').map(x => x.trim());
    const token = cookies.find(x => x.startsWith('spark_session='))?.slice('spark_session='.length);
    const record = token ? sessions.get(token) : undefined;
    if (!record || record.expiresAt <= Date.now()) { if (token) sessions.delete(token); return null; }
    return {token,...record};
  }
  function expectedOrigin(req) {
    if (publicOrigin) return publicOrigin;
    const value = req.headers.host;
    if (!value || /[\s\/\\@]/.test(value)) reject(400, 'Invalid Host header.');
    const parsed = new URL(`http://${value}`);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!isPrivateAddress(hostname) && hostname !== 'localhost' && hostname !== os.hostname() && hostname !== host) reject(403, 'This hostname requires PUBLIC_ORIGIN configuration.');
    return parsed.origin;
  }
  function checkOrigin(req, {required = true} = {}) {
    const expected = expectedOrigin(req);
    if (publicOrigin && req.headers.host !== new URL(publicOrigin).host) {
      let incoming; try { incoming = new URL(`http://${req.headers.host}`); } catch { reject(403,'Host does not match PUBLIC_ORIGIN.'); }
      const hostname = incoming.hostname.replace(/^\[|\]$/g, '');
      if (!['127.0.0.1','::1','localhost'].includes(hostname) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) reject(403, 'Host does not match PUBLIC_ORIGIN.');
    }
    const origin = req.headers.origin;
    if ((required && !origin) || (origin && origin !== expected) || req.headers['sec-fetch-site'] === 'cross-site') reject(403, 'Request origin is not allowed.');
  }
  function authorize(req, mutating) {
    const session = sessionFor(req);
    if (!session) reject(401, 'Sign in to continue.');
    checkOrigin(req, {required:mutating});
    if (mutating && !sameSecret(req.headers['x-csrf-token'], session.csrf)) reject(403, 'Invalid CSRF token.');
    return session;
  }
  function validateParameters(value) {
    if (value === undefined) return undefined;
    object(value, 'Parameters');
    const result = {};
    const allowed = {temperature:[0,2],num_ctx:[256,1048576],num_predict:[-1,131072],top_k:[0,1000],top_p:[0,1],min_p:[0,1],repeat_penalty:[0,5],repeat_last_n:[-1,1048576],seed:[-1,2147483647]};
    for (const [key,val] of Object.entries(value)) {
      if (key === 'stop') {
        if (!(typeof val === 'string' && val.length <= 4096) && !(Array.isArray(val) && val.length <= 16 && val.every(x => typeof x === 'string' && x.length <= 4096))) reject(400, 'Stop must be a string or an array of at most 16 strings.');
        result.stop = val; continue;
      }
      if (!allowed[key]) reject(400, `Unsupported model parameter: ${key}.`);
      result[key] = number(val, key, ...allowed[key]);
      if (['num_ctx','num_predict','top_k','repeat_last_n','seed'].includes(key) && !Number.isInteger(val)) reject(400, `${key} must be an integer.`);
    }
    return result;
  }
  async function importFile(filename) {
    string(filename, 'Import path', 4096);
    if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.gguf') reject(400, 'Choose an absolute .gguf path inside an import root.');
    let real, stats;
    try { real = await fs.realpath(filename); stats = await fs.stat(real); } catch { reject(400, 'The import file is unavailable.'); }
    if (!importRoots.some(root => real.startsWith(root + path.sep)) || !stats.isFile()) reject(400, 'The file must be inside a configured import root.');
    return {path:real,size:stats.size,mtimeMs:stats.mtimeMs};
  }
  async function listImportFiles() {
    const files = [];
    async function walk(directory, depth = 0) {
      if (depth > 8 || files.length >= 2000) return;
      let entries; try { entries = await fs.readdir(directory,{withFileTypes:true}); } catch { return; }
      for (const entry of entries) {
        if (files.length >= 2000) break;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(directory,entry.name);
        if (entry.isDirectory()) await walk(full,depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
          try { const file = await importFile(full); files.push({path:file.path,name:entry.name,size:file.size}); } catch {}
        }
      }
    }
    for (const root of importRoots) await walk(root);
    return {roots:importRoots,files:files.sort((a,b) => a.name.localeCompare(b.name))};
  }
  async function validateJob(input) {
    fields(input,['serverId','type','model','from','system','parameters','template','quantize','path','prompt']);
    selected(input.serverId);
    if (!['pull','create','import','benchmark'].includes(input.type)) reject(400, 'Unknown job type.');
    const valid = {serverId:input.serverId || state.activeServerId,type:input.type,model:model(input.model)};
    if (input.type === 'create') valid.from = model(input.from, 'Base model');
    if (input.type === 'create' || input.type === 'import') {
      if (input.system !== undefined) valid.system = string(input.system,'System prompt',32768,{empty:true});
      if (input.template !== undefined) valid.template = string(input.template,'Template',32768,{empty:true});
      if (input.parameters !== undefined) valid.parameters = validateParameters(input.parameters);
      if (input.quantize !== undefined) {
        if (!['q4_K_M','q4_K_S','q5_K_M','q5_K_S','q8_0','q4_0','q4_1','q5_0','q5_1','q6_K','f16','bf16'].includes(input.quantize)) reject(400, 'Unsupported quantization.');
        valid.quantize = input.quantize;
      }
    }
    if (input.type === 'import') valid.path = (await importFile(input.path)).path;
    if (input.type === 'benchmark') valid.prompt = input.prompt === undefined ? 'Explain in one paragraph how unified memory helps an AI workstation.' : string(input.prompt, 'Benchmark prompt',8192);
    return valid;
  }
  async function progress(job, update, final = false) {
    Object.assign(job,update,{updatedAt:new Date().toISOString()});
    if (final || !job._lastSaved || Date.now() - job._lastSaved > 750) {
      job._lastSaved = Date.now();
      await persist();
    }
  }
  async function streamJob(job, endpoint, body, signal) {
    const response = await ollamaRequest(selected(job.serverId),endpoint,{method:'POST',body,signal,timeout:10 * 60 * 1000});
    let last;
    for await (const item of ndjson(response)) {
      if (signal.aborted) throw new Error('Cancelled.');
      last = item;
      const update = {message:typeof item.status === 'string' ? item.status.slice(0,512) : 'Working…'};
      if (Number.isFinite(item.completed) && item.completed >= 0) update.completed = item.completed;
      if (Number.isFinite(item.total) && item.total >= 0) update.total = item.total;
      await progress(job, update);
    }
    if (!last || last.status !== 'success') throw new Error('Ollama stream ended before confirming success.');
    return last;
  }
  async function runImport(job, signal) {
    const before = await importFile(job.input.path);
    const handle = await fs.open(before.path,fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const initial = await handle.stat();
      const realNow = process.platform === 'linux' ? await fs.realpath(`/proc/self/fd/${handle.fd}`) : await fs.realpath(before.path);
      if (!importRoots.some(root => realNow.startsWith(root + path.sep)) || initial.size !== before.size || initial.mtimeMs !== before.mtimeMs) throw new Error('Import file changed before reading.');
      const magic = Buffer.alloc(4);
      await handle.read(magic,0,4,0);
      if (magic.toString('ascii') !== 'GGUF') throw new Error('The selected file is not a GGUF model.');
      const hash = createHash('sha256');
      let completed = 0;
      for await (const chunk of handle.createReadStream({start:0,autoClose:false})) {
        if (signal.aborted) throw new Error('Cancelled.');
        hash.update(chunk); completed += chunk.length;
        await progress(job,{message:'Hashing GGUF file',completed,total:initial.size});
      }
      const after = await handle.stat();
      if (after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) throw new Error('Import file changed while hashing.');
      const digest = `sha256:${hash.digest('hex')}`;
      const endpoint = `/api/blobs/${digest}`;
      const server = selected(job.serverId);
      const head = await ollamaRequest(server,endpoint,{method:'HEAD',signal});
      head.resume();
      if (head.statusCode !== 200) {
        if (head.statusCode !== 404) throw new Error(`Ollama blob check returned HTTP ${head.statusCode}.`);
        await progress(job,{message:'Uploading GGUF blob',completed:0,total:initial.size});
        const raw = handle.createReadStream({start:0,autoClose:false});
        let uploaded = 0;
        const upload = await ollamaRequest(server,endpoint,{method:'POST',rawBody:raw,contentLength:initial.size,signal,timeout:10 * 60 * 1000,onUploadProgress:chunk => { uploaded += chunk.length; job.completed = uploaded; job.updatedAt = new Date().toISOString(); }});
        await boundedJSON(upload);
        const final = await handle.stat();
        if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) throw new Error('Import file changed during upload.');
      }
      const {model:target,system,parameters,template,quantize} = job.input;
      return await streamJob(job,'/api/create',{model:target,files:{[path.basename(before.path)]:digest},system,parameters,template,quantize,stream:true},signal);
    } finally { await handle.close(); }
  }
  async function executeJob(job, signal) {
    const input = job.input;
    if (job.type === 'pull') return streamJob(job,'/api/pull',{model:job.model,stream:true},signal);
    if (job.type === 'create') return streamJob(job,'/api/create',{model:job.model,from:input.from,system:input.system,parameters:input.parameters,template:input.template,quantize:input.quantize,stream:true},signal);
    if (job.type === 'import') return runImport(job,signal);
    if (job.type === 'benchmark') {
      await progress(job,{message:'Running model benchmark'});
      const started = performance.now();
      const result = await jsonCall(selected(job.serverId),'/api/generate',{method:'POST',body:{model:job.model,prompt:input.prompt,stream:false,options:{num_predict:128,temperature:0}},signal,timeout:10 * 60 * 1000});
      if (!result.done) throw new Error('Ollama did not complete the benchmark.');
      return {wallTimeMs:Math.round(performance.now() - started),evalCount:result.eval_count || 0,evalDuration:result.eval_duration || 0,promptEvalCount:result.prompt_eval_count || 0,promptEvalDuration:result.prompt_eval_duration || 0,loadDuration:result.load_duration || 0,totalDuration:result.total_duration || 0,tokensPerSecond:result.eval_duration > 0 ? Math.round((result.eval_count || 0) / (result.eval_duration / 1e9) * 100) / 100 : null,response:result.response || ''};
    }
  }
  async function pump() {
    if (pumping || stopping) return;
    pumping = true;
    try {
      while (!stopping) {
        const job = state.jobs.find(item => item.status === 'queued');
        if (!job) break;
        const controller = new AbortController(); controllers.set(job.id,controller);
        await progress(job,{status:'running',message:'Starting…'},true);
        try {
          const result = await executeJob(job,controller.signal);
          if (controller.signal.aborted || job.status === 'cancelled') await progress(job,{status:'cancelled',message:'Cancelled. Partial model blobs are retained by Ollama.'},true);
          else await progress(job,{status:'completed',message:'Completed',result},true);
        } catch (error) {
          if (stopping) await progress(job,{status:'interrupted',message:'Interrupted by service shutdown. Retry to continue.'},true);
          else if (controller.signal.aborted || job.status === 'cancelled') await progress(job,{status:'cancelled',message:'Cancelled. Partial model blobs are retained by Ollama.'},true);
          else await progress(job,{status:'failed',message:'Failed',error:error.message},true);
        } finally { controllers.delete(job.id); delete job._lastSaved; }
      }
    } catch (error) { console.error('Job queue failed:',error.message); }
    finally { pumping = false; }
  }
  async function enqueue(input) {
    const valid = await validateJob(input);
    const now = new Date().toISOString();
    const job = {id:randomUUID(),type:valid.type,model:valid.model,serverId:valid.serverId,status:'queued',message:'Queued',createdAt:now,updatedAt:now,input:valid};
    if (state.jobs.length >= 500) {
      const old = state.jobs.findIndex(item => STOPPED.has(item.status));
      if (old < 0) reject(429,'The job queue is full.');
      state.jobs.splice(old,1);
    }
    state.jobs.push(job); await persist();
    queueMicrotask(() => void pump());
    return publicJob(job);
  }
  function validChatOptions(input) {
    if (input === undefined) return undefined;
    fields(input,['temperature','num_ctx']);
    return validateParameters(input);
  }
  async function chat(req,res,input,session) {
    fields(input,['chatId','serverId','model','message','images','system','options','keep_alive','mcpServerIds']);
    const server = selected(input.serverId), target = model(input.model);
    const message = string(input.message,'Message',65536);
    const system = input.system === undefined ? undefined : string(input.system,'System prompt',32768,{empty:true});
    const chatOptions = validChatOptions(input.options);
    let keepAlive;
    if (input.keep_alive !== undefined) {
      if (typeof input.keep_alive === 'number') keepAlive = number(input.keep_alive,'Keep alive',0,86400);
      else if (typeof input.keep_alive === 'string' && /^\d{1,5}(s|m|h)$/.test(input.keep_alive)) {
        const seconds = parseInt(input.keep_alive,10) * ({s:1,m:60,h:3600}[input.keep_alive.at(-1)]);
        if (seconds > 86400) reject(400,'Keep alive cannot exceed 24 hours.');
        keepAlive = input.keep_alive;
      }
      else reject(400,'Keep alive must be nonnegative seconds or a duration such as 5m.');
    }
    let images;
    if (input.images !== undefined) {
      if (!Array.isArray(input.images) || input.images.length > 4) reject(400,'Attach at most four images.');
      images = input.images.map(image => {
        if (typeof image !== 'string' || image.length > 8 * 1024 * 1024 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(image) || image.length % 4 !== 0) reject(400,'Images must be base64 without a data URL prefix (maximum 6 MB each).');
        return image;
      });
    }
    const chatId = input.chatId === undefined ? randomUUID() : string(input.chatId,'Chat ID',64);
    const previous = state.chats[chatId];
    if (input.chatId && !/^[a-f0-9-]{36}$/.test(chatId)) reject(400,'Chat ID is invalid.');
    if (input.chatId && !previous) reject(404,'Conversation not found.');
    if (previous && (previous.serverId !== server.id || previous.model !== target)) reject(400,'A conversation must use the same server and model. Start a new conversation to switch.');
    if (activeChats.has(chatId)) reject(409,'This conversation already has a running response.');
    if (activeChats.size >= 4) reject(429,'At most four chat streams can run at once.');
    if ((previous?.messages.length || 0) >= 200) reject(400,'This conversation has reached 200 messages. Start a new conversation.');
    if (!previous && Object.keys(state.chats).length >= 1000) reject(400,'Conversation storage is full. Delete old conversations to continue.');
    const history = previous ? structuredClone(previous.messages) : [];
    if (system !== undefined) {
      if (history[0]?.role === 'system') history[0].content = system;
      else history.unshift({role:'system',content:system});
    }
    const userMessage = {role:'user',content:message,...(images?.length ? {images} : {})};
    history.push(userMessage);
    let mcpIds = input.mcpServerIds ?? [];
    if (!Array.isArray(mcpIds) || mcpIds.length > 8 || mcpIds.some(id => typeof id !== 'string' || id.length > 64) || new Set(mcpIds).size !== mcpIds.length) reject(400,'Select at most eight distinct MCP connections.');
    const mcpConfigs = mcpIds.map(id => {
      const configuration = state.mcpServers.find(item => item.id === id);
      if (!configuration) reject(404,'Selected MCP connection not found.');
      if (!configuration.enabled) reject(400,'Selected MCP connection is disabled.');
      return structuredClone(configuration);
    });
    let assistantMessage = {role:'assistant',content:''};
    const toolEvents = previous?.toolEvents ? structuredClone(previous.toolEvents) : [];
    const controller = new AbortController();
    activeChats.set(chatId,server.id); activeChatSessions.set(chatId,session.token); activeMcpSelections.set(chatId,new Set(mcpIds)); controllers.set(`chat:${chatId}`,controller);
    const onClose = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected.')); };
    res.on('close',onClose);
    let started = false, complete = false, saved = false, chunkBytes = 0, totalCalls = 0;
    const clients = new Map(), toolsByAlias = new Map();
    async function write(value) {
      if (res.destroyed || controller.signal.aborted) return;
      if (!res.write(JSON.stringify(value) + '\n')) await new Promise(resolve => {
        const finish = () => { res.off('drain',finish); res.off('close',finish); resolve(); };
        res.once('drain',finish); res.once('close',finish);
      });
    }
    async function checkpoint(partial, final = false) {
      if (final && saved) return;
      const now = new Date().toISOString();
      state.chats[chatId] = {id:chatId,title:previous?.title || titleFrom(message),serverId:server.id,model:target,
        messages:[...history,...(assistantMessage.content || assistantMessage.thinking || assistantMessage.tool_calls?.length || complete ? [{...assistantMessage,...(partial ? {interrupted:true} : {})}] : [])],
        ...(mcpIds.length || toolEvents.length ? {mcpServerIds:mcpIds,toolEvents:structuredClone(toolEvents)} : {}),updatedAt:now};
      await persist();
      if (final) saved = true;
    }
    async function askApproval(event) {
      if (controller.signal.aborted) throw new Error('Tool call cancelled.');
      let resolveDecision, rejectDecision;
      const decision = new Promise((resolve,rejectPromise) => { resolveDecision = resolve; rejectDecision = rejectPromise; });
      // The promise rejection is consumed before a disconnected stream can trigger an unhandled rejection.
      decision.catch(() => {});
      const onAbort = () => rejectDecision(new Error('Tool call cancelled.'));
      const timer = setTimeout(() => resolveDecision(false),approvalTimeout);
      controller.signal.addEventListener('abort',onAbort,{once:true});
      pendingApprovals.set(event.id,{chatId,sessionToken:session.token,resolve:resolveDecision});
      try {
        await checkpoint(true);
        await write({toolCall:{id:event.id,serverId:event.serverId,serverName:event.serverName,name:event.name,arguments:event.arguments,status:'pending'}});
        return await decision;
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort',onAbort); pendingApprovals.delete(event.id);
      }
    }
    try {
      for (const configuration of mcpConfigs) {
        const client = mcpFactory(configuration,{signal:controller.signal,timeout:30000});
        clients.set(configuration.id,client);
        await client.initialize();
        const listed = await client.listTools();
        for (const tool of listed) {
          if (toolsByAlias.size >= 128) throw new Error('Selected MCP servers expose more than 128 tools. Choose fewer connections.');
          if (!tool || typeof tool.name !== 'string' || tool.name.length > 128 || !tool.name) throw new Error('MCP server advertised an invalid tool name.');
          const alias = `mcp_${createHash('sha256').update(configuration.id + '\0' + tool.name).digest('hex').slice(0,12)}_${redactMcpSecrets(tool.name,configuration).replace(/[^a-zA-Z0-9_]/g,'_').slice(0,40)}`;
          toolsByAlias.set(alias,{tool,configuration,client});
        }
      }
      const advertisedTools = [...toolsByAlias].map(([alias,{tool}]) => ({type:'function',function:{name:alias,description:typeof tool.description === 'string' ? redactMcpSecrets(tool.description,mcpConfigs).slice(0,8192) : '',parameters:sanitizeMcpValue(tool.inputSchema || {type:'object',properties:{}},mcpConfigs)}}));
      if (JSON.stringify(advertisedTools).length > MAX_JSON) throw new Error('MCP tool definitions exceed the allowed size.');
      for (let round = 0; round < 8; round++) {
        if (controller.signal.aborted) throw new Error('Chat cancelled.');
        complete = false;
        const response = await ollamaRequest(server,'/api/chat',{method:'POST',body:{model:target,messages:history,stream:true,options:chatOptions,keep_alive:keepAlive,...(advertisedTools.length ? {tools:advertisedTools} : {})},signal:controller.signal,timeout:10 * 60 * 1000});
        if (response.statusCode < 200 || response.statusCode > 299) await boundedJSON(response);
        if (!started) {
          res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
          started = true; await write({chatId});
        }
        const streamedCalls = new Map();
        let nextCallIndex = 0;
        for await (const chunk of ndjson(response)) {
          if (controller.signal.aborted) break;
          const upstreamMessage = chunk.message || {};
          const outgoing = {message:{role:'assistant'}};
          for (const field of ['content','thinking']) if (typeof upstreamMessage[field] === 'string') {
            chunkBytes += Buffer.byteLength(upstreamMessage[field]);
            if (chunkBytes > 4 * 1024 * 1024) throw new Error('Response exceeded the conversation limit.');
            assistantMessage[field] = (assistantMessage[field] || '') + upstreamMessage[field]; outgoing.message[field] = upstreamMessage[field];
          }
          if (mcpIds.length && upstreamMessage.tool_calls !== undefined) {
            if (!Array.isArray(upstreamMessage.tool_calls) || upstreamMessage.tool_calls.length > 8) throw new Error('Model requested too many tools at once.');
            for (const raw of upstreamMessage.tool_calls) {
              if (!raw || typeof raw.function !== 'object' || !raw.function) throw new Error('Model returned a malformed tool call.');
              const index = raw.function.index ?? raw.index ?? nextCallIndex++;
              if (!Number.isInteger(index) || index < 0 || index >= 8) throw new Error('Model returned an invalid tool-call index.');
              const pending = streamedCalls.get(index) || {name:'',arguments:undefined};
              if (raw.function.name !== undefined) {
                if (typeof raw.function.name !== 'string') throw new Error('Model returned an invalid tool-call name.');
                pending.name = pending.name === raw.function.name ? pending.name : pending.name + raw.function.name;
              }
              if (raw.function.arguments !== undefined) {
                const args = raw.function.arguments;
                if (typeof args === 'string') pending.arguments = (typeof pending.arguments === 'string' ? pending.arguments : '') + args;
                else if (args && typeof args === 'object' && !Array.isArray(args)) pending.arguments = {...(typeof pending.arguments === 'object' ? pending.arguments : {}),...args};
                else throw new Error('Model returned invalid tool arguments.');
              }
              if (pending.name.length > 128 || JSON.stringify(pending.arguments ?? {}).length > 65536) throw new Error('Model tool call exceeds the allowed size.');
              streamedCalls.set(index,pending);
            }
          }
          for (const field of ['done','eval_count','eval_duration','prompt_eval_count','prompt_eval_duration','total_duration','load_duration']) if (chunk[field] !== undefined) outgoing[field] = chunk[field];
          if (chunk.done === true) complete = true;
          await write(outgoing);
        }
        if (!complete && !controller.signal.aborted) throw new Error('Ollama stream ended before completing the response.');
        if (controller.signal.aborted) throw new Error('Chat cancelled.');
        if (!streamedCalls.size) break;
        if (totalCalls + streamedCalls.size > 16) throw new Error('This response reached the limit of 16 MCP tool calls.');
        const calls = [...streamedCalls.values()].map(call => {
          const entry = toolsByAlias.get(call.name);
          if (!entry) throw new Error('Model requested an unavailable MCP tool.');
          let args = call.arguments ?? {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw new Error('Model returned invalid JSON tool arguments.'); } }
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP tool arguments must be an object.');
          return {alias:call.name,args,entry};
        });
        assistantMessage.tool_calls = calls.map(({alias,args}) => ({function:{name:alias,arguments:args}}));
        history.push(structuredClone(assistantMessage)); assistantMessage = {role:'assistant',content:''}; complete = false;
        const batchEvents = calls.map(({alias,args,entry}) => ({id:randomUUID(),serverId:entry.configuration.id,serverName:entry.configuration.name,name:redactMcpSecrets(entry.tool.name,entry.configuration),functionName:alias,arguments:args,status:'pending',createdAt:new Date().toISOString()}));
        toolEvents.push(...batchEvents);
        await checkpoint(true);
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
          const {alias,args,entry} = calls[callIndex], event = batchEvents[callIndex];
          totalCalls++;
          try {
            const approved = await askApproval(event);
            if (controller.signal.aborted) throw new Error('Tool call cancelled.');
            if (!approved) { event.status = 'denied'; event.content = 'The user denied this tool call or the approval request expired.'; event.isError = true; }
            else {
              event.status = 'running'; await checkpoint(true);
              try {
                const result = await entry.client.callTool(entry.tool.name,args);
                if (controller.signal.aborted) throw new Error('Tool call cancelled.');
                event.status = result.isError ? 'failed' : 'completed'; event.isError = !!result.isError;
                event.content = formatToolResult(result,entry.configuration);
              } catch (error) {
                if (controller.signal.aborted) throw error;
                event.status = 'failed'; event.isError = true; event.content = redactMcpSecrets(error.message,entry.configuration).slice(0,262144);
              }
            }
          } catch (error) {
            event.status = 'cancelled'; event.content = 'Tool call cancelled.'; event.isError = true;
            history.push({role:'tool',tool_name:alias,content:event.content}); event.completedAt = new Date().toISOString();
            throw error;
          }
          event.completedAt = new Date().toISOString();
          history.push({role:'tool',tool_name:alias,content:event.content});
          await checkpoint(true);
          await write({toolResult:{id:event.id,name:event.name,status:event.status,content:event.content,isError:event.isError}});
        }
        if (round === 7) throw new Error('This response reached the limit of eight MCP tool rounds.');
      }
      await checkpoint(!complete,true);
      if (!controller.signal.aborted) await write({saved:true,chatId});
    } catch (error) {
      for (const event of toolEvents) if (['pending','running'].includes(event.status)) {
        event.status = 'cancelled'; event.content = 'Tool call cancelled.'; event.isError = true; event.completedAt = new Date().toISOString();
        history.push({role:'tool',tool_name:event.functionName || event.name,content:event.content});
      }
      if (controller.signal.aborted) { await checkpoint(!complete,true); }
      else if (started) {
        let storageError;
        try { await checkpoint(!complete,true); } catch (failure) { storageError = failure; }
        await write({error:redactMcpSecrets(storageError ? `Conversation could not be saved: ${storageError.message}` : error.message,mcpConfigs),chatId,saved});
      } else sendJSON(res,502,{error:redactMcpSecrets(error.message,mcpConfigs)});
    } finally {
      controller.abort(); res.off('close',onClose); activeChats.delete(chatId); activeChatSessions.delete(chatId); activeMcpSelections.delete(chatId); controllers.delete(`chat:${chatId}`);
      await Promise.allSettled([...clients.values()].map(client => client.close()));
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  async function route(req,res) {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    let url; try { url = new URL(req.url,'http://localhost'); } catch { reject(400,'Invalid request URL.'); }
    const pathname = url.pathname, method = req.method;
    if (method === 'GET' && pathname === '/api/health') return sendJSON(res,200,{ok:true,version:VERSION,developedBy:DEVELOPER});
    if (method === 'GET' && pathname === '/api/session') {
      checkOrigin(req,{required:false});
      const session = sessionFor(req);
      return sendJSON(res,200,{authenticated:!!session,...(session ? {csrf:session.csrf} : {}),branding:{...state.settings,developedBy:DEVELOPER}});
    }
    if (method === 'POST' && pathname === '/api/login') {
      checkOrigin(req);
      const key = req.socket.remoteAddress || 'unknown';
      const recent = loginAttempts.get(key) || {count:0,since:Date.now()};
      if (Date.now() - recent.since > 15 * 60 * 1000) { recent.count = 0; recent.since = Date.now(); }
      if (recent.count >= 8) reject(429,'Too many login attempts. Try again in 15 minutes.');
      const input = await parseBody(req); fields(input,['password']); string(input.password,'Password',1024);
      recent.count++; loginAttempts.set(key,recent);
      const credentials = await loadJSON(credentialsFile,null);
      const actual = (await scrypt(input.password,credentials.salt,64)).toString('hex');
      if (!sameSecret(actual,credentials.hash)) reject(401,'Incorrect password.');
      loginAttempts.delete(key);
      const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
      const secure = (publicOrigin || expectedOrigin(req)).startsWith('https:');
      if (sessions.size > 1000) for (const [id,item] of sessions) if (item.expiresAt < Date.now()) sessions.delete(id);
      sessions.set(token,{csrf,expiresAt:Date.now() + SESSION_AGE});
      res.setHeader('Set-Cookie',`spark_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE / 1000}${secure ? '; Secure' : ''}`);
      return sendJSON(res,200,{authenticated:true,csrf});
    }
    if (pathname.startsWith('/api/')) {
      const mutating = !['GET','HEAD'].includes(method);
      const session = authorize(req,mutating);
      if (method === 'POST' && pathname === '/api/logout') {
        sessions.delete(session.token);
        for (const [chatId,owner] of activeChatSessions) if (owner === session.token) controllers.get(`chat:${chatId}`)?.abort(new Error('Signed out.'));
        res.setHeader('Set-Cookie','spark_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return sendJSON(res,200,{ok:true});
      }
      if (method === 'GET' && pathname === '/api/state') return sendJSON(res,200,{settings:state.settings,servers:state.servers,activeServerId:state.activeServerId,mcpServers:state.mcpServers.map(publicMcpConfig),jobs:state.jobs.map(publicJob).reverse(),chats:Object.values(state.chats).map(({id,title,serverId,model,updatedAt}) => ({id,title,serverId,model,updatedAt})).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))});
      if (method === 'GET' && pathname === '/api/updates') {
        for (const key of url.searchParams.keys()) if (key !== 'check') reject(400,'Unsupported update query parameter.');
        const check = url.searchParams.get('check');
        if (url.searchParams.getAll('check').length > 1 || (check !== null && check !== '1')) reject(400,'Use check=1 to check official releases.');
        if (check === '1') await checkRelease();
        return sendJSON(res,200,updateMetadata(installationMode,latestRelease));
      }
      if (method === 'GET' && pathname === '/api/mcp/servers') return sendJSON(res,200,state.mcpServers.map(publicMcpConfig));
      if (method === 'POST' && pathname === '/api/mcp/servers') {
        const input = await parseBody(req);
        fields(input,['id','name','transport','enabled','url','bearerToken','command','args','env','cwd']);
        const id = input.id === undefined ? randomUUID() : string(input.id,'MCP connection ID',64);
        const existing = state.mcpServers.find(item => item.id === id);
        if (input.id && !existing) reject(404,'MCP connection not found.');
        if (existing && [...activeMcpSelections.values()].some(ids => ids.has(id))) reject(409,'Stop chats using this MCP connection before changing it.');
        const defaultCwd = path.join(dataDir,'mcp-workspaces');
        const useDefaultCwd = (input.transport ?? existing?.transport) === 'stdio' && input.cwd === undefined && !existing?.cwd;
        if (useDefaultCwd) await fs.mkdir(defaultCwd,{recursive:true,mode:0o700});
        let configuration;
        try { configuration = await validateMcpConfig({...input,id,...(useDefaultCwd ? {cwd:defaultCwd} : {})},existing); } catch (error) { reject(400,redactMcpSecrets(error.message,existing)); }
        if (existing) state.mcpServers[state.mcpServers.indexOf(existing)] = configuration; else { if (state.mcpServers.length >= 32) reject(400,'At most 32 MCP connections can be configured.'); state.mcpServers.push(configuration); }
        await persist(); return sendJSON(res,200,publicMcpConfig(configuration));
      }
      const mcpMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)(?:\/(test|tools))?$/);
      if (mcpMatch) {
        const configuration = state.mcpServers.find(item => item.id === decodeURIComponent(mcpMatch[1]));
        if (!configuration) reject(404,'MCP connection not found.');
        if (method === 'DELETE' && !mcpMatch[2]) {
          if ([...activeMcpSelections.values()].some(ids => ids.has(configuration.id))) reject(409,'Stop chats using this MCP connection before deleting it.');
          state.mcpServers = state.mcpServers.filter(item => item.id !== configuration.id); await persist(); return sendJSON(res,200,{ok:true});
        }
        if ((method === 'POST' && mcpMatch[2] === 'test') || (method === 'GET' && mcpMatch[2] === 'tools')) {
          const controller = new AbortController(), client = mcpFactory(configuration,{signal:controller.signal,timeout:15000});
          const probeId = `mcp-probe:${randomUUID()}`; controllers.set(probeId,controller);
          const onClose = () => { if (!res.writableEnded) controller.abort(); };
          res.on('close',onClose);
          try {
            const init = await client.initialize(), tools = await client.listTools();
            return sendJSON(res,200,mcpMatch[2] === 'test' ? sanitizeMcpValue({ok:true,serverInfo:init.serverInfo,protocolVersion:init.protocolVersion,tools},configuration) : sanitizeMcpValue({tools},configuration));
          } catch (error) { reject(502,redactMcpSecrets(error.message,configuration)); }
          finally { res.off('close',onClose); controllers.delete(probeId); await client.close(); }
        }
      }
      const decisionMatch = pathname.match(/^\/api\/chat\/([^/]+)\/tool-decision$/);
      if (method === 'POST' && decisionMatch) {
        const input = await parseBody(req); fields(input,['callId','approved']);
        const callId = string(input.callId,'Tool call ID',64);
        if (typeof input.approved !== 'boolean') reject(400,'Tool approval must be true or false.');
        const pending = pendingApprovals.get(callId);
        if (!pending || pending.chatId !== decodeURIComponent(decisionMatch[1])) reject(404,'Tool approval is no longer pending.');
        if (pending.sessionToken !== session.token) reject(403,'Only the session that started this chat can approve its tools.');
        pendingApprovals.delete(callId); pending.resolve(input.approved);
        return sendJSON(res,200,{ok:true});
      }
      if (method === 'POST' && pathname === '/api/settings') {
        const input = await parseBody(req); fields(input,['title','subtitle']);
        state.settings = {title:string(input.title,'Title',80),subtitle:string(input.subtitle,'Subtitle',160,{empty:true})};
        await persist(); return sendJSON(res,200,state.settings);
      }
      if (method === 'POST' && pathname === '/api/servers') {
        const input = await parseBody(req); fields(input,['id','name','url']);
        const name = string(input.name,'Server name',80), validated = await validateTarget(input.url);
        const id = input.id === undefined ? randomUUID() : string(input.id,'Server ID',64);
        const existing = state.servers.find(item => item.id === id);
        if (input.id && !existing) reject(404,'Server not found.');
        if (existing && (state.jobs.some(item => item.serverId === id && ['queued','running'].includes(item.status)) || [...activeChats.values()].includes(id))) reject(409,'Wait for jobs and chats on this server to finish before changing its target.');
        const server = {id,name,url:validated.url.origin};
        if (existing) Object.assign(existing,server); else { if (state.servers.length >= 32) reject(400,'At most 32 servers can be configured.'); state.servers.push(server); }
        await persist(); return sendJSON(res,200,server);
      }
      const serverMatch = pathname.match(/^\/api\/servers\/([^/]+)$/);
      if (method === 'DELETE' && serverMatch) {
        const server = selected(decodeURIComponent(serverMatch[1]));
        if (server.id === 'local') reject(400,'The default server cannot be deleted.');
        if (state.jobs.some(item => item.serverId === server.id && ['queued','running'].includes(item.status)) || [...activeChats.values()].includes(server.id)) reject(409,'Cancel pending jobs and stop chats before deleting this server.');
        state.servers = state.servers.filter(item => item.id !== server.id);
        if (state.activeServerId === server.id) state.activeServerId = 'local';
        await persist(); return sendJSON(res,200,{ok:true});
      }
      if (method === 'POST' && pathname === '/api/active-server') {
        const input = await parseBody(req); fields(input,['id']); state.activeServerId = selected(input.id).id;
        await persist(); return sendJSON(res,200,{ok:true});
      }
      if (method === 'GET' && pathname === '/api/status') {
        const server = selected(url.searchParams.get('serverId') || undefined);
        const systemPromise = systemStatus(importRoots,dataDir);
        let online = true, version, models = [], running = [], error;
        try {
          const results = await Promise.all(['/api/version','/api/tags','/api/ps'].map(endpoint => jsonCall(server,endpoint)));
          version = results[0].version; models = results[1].models || []; running = results[2].models || [];
        } catch (failure) { online = false; error = failure.message; }
        return sendJSON(res,200,{online,version,models,running,error,system:await systemPromise});
      }
      if (method === 'POST' && ['/api/show','/api/copy','/api/delete','/api/unload'].includes(pathname)) {
        const input = await parseBody(req);
        fields(input,pathname === '/api/copy' ? ['serverId','source','destination'] : ['serverId','model']);
        const server = selected(input.serverId);
        let result;
        if (pathname === '/api/copy') result = await jsonCall(server,'/api/copy',{method:'POST',body:{source:model(input.source,'Source model'),destination:model(input.destination,'Destination model')}});
        else if (pathname === '/api/show') result = await jsonCall(server,'/api/show',{method:'POST',body:{model:model(input.model)}});
        else if (pathname === '/api/delete') result = await jsonCall(server,'/api/delete',{method:'DELETE',body:{model:model(input.model)}});
        else result = await jsonCall(server,'/api/generate',{method:'POST',body:{model:model(input.model),keep_alive:0,stream:false}});
        return sendJSON(res,200,pathname === '/api/show' ? result : {ok:true});
      }
      if (method === 'GET' && pathname === '/api/jobs') return sendJSON(res,200,state.jobs.map(publicJob).reverse());
      if (method === 'POST' && pathname === '/api/jobs') return sendJSON(res,202,await enqueue(await parseBody(req)));
      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(cancel|retry)$/);
      if (method === 'POST' && jobMatch) {
        const job = state.jobs.find(item => item.id === decodeURIComponent(jobMatch[1]));
        if (!job) reject(404,'Job not found.');
        if (jobMatch[2] === 'retry') {
          if (!STOPPED.has(job.status)) reject(409,'This job is still pending.');
          return sendJSON(res,202,await enqueue(job.input));
        }
        if (STOPPED.has(job.status)) return sendJSON(res,200,publicJob(job));
        controllers.get(job.id)?.abort(new Error('Cancelled by administrator.'));
        await progress(job,{status:'cancelled',message:'Cancelled. Partial model blobs are retained by Ollama.'},true);
        return sendJSON(res,200,publicJob(job));
      }
      if (method === 'GET' && pathname === '/api/import-files') return sendJSON(res,200,await listImportFiles());
      const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);
      if (chatMatch) {
        const chatId = decodeURIComponent(chatMatch[1]), savedChat = state.chats[chatId];
        if (!savedChat) reject(404,'Conversation not found.');
        if (method === 'GET') return sendJSON(res,200,savedChat);
        if (method === 'DELETE') {
          if (activeChats.has(chatId)) reject(409,'Stop this response before deleting the conversation.');
          delete state.chats[chatId]; await persist(); return sendJSON(res,200,{ok:true});
        }
      }
      if (method === 'POST' && pathname === '/api/chat') return chat(req,res,await parseBody(req,MAX_CHAT),session);
      reject(404,'API endpoint not found.');
    }
    if ((method === 'GET' || method === 'HEAD') && STATIC.has(pathname)) {
      const [filename,mime] = STATIC.get(pathname);
      let bytes; try { bytes = await fs.readFile(path.join(publicDir,filename)); } catch { reject(404,'File not found.'); }
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':filename === 'sw.js' ? 'no-cache' : 'no-cache'});
      res.end(method === 'HEAD' ? undefined : bytes); return;
    }
    reject(404,'Page not found.');
  }
  const server = http.createServer((req,res) => {
    route(req,res).catch(error => {
      req.resume();
      if (res.headersSent) { if (!res.destroyed && !res.writableEnded) res.end(); return; }
      const status = error.status || 502;
      sendJSON(res,status,{error:error.message || 'Request failed.'});
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 64;
  server.on('clientError',(_error,socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return {
    server,dataDir,importRoots,
    async start() { await new Promise((resolve,rejectPromise) => { server.once('error',rejectPromise); server.listen(port,host,() => { server.off('error',rejectPromise); resolve(); }); }); return server.address(); },
    async close() {
      stopping = true;
      for (const controller of controllers.values()) controller.abort(new Error('Service shutting down.'));
      for (const job of state.jobs) if (['queued','running'].includes(job.status)) { job.status = 'interrupted'; job.message = 'Interrupted by service shutdown. Retry to continue.'; job.updatedAt = new Date().toISOString(); }
      await persist();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      await writeChain;
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manager = await createManager();
  const address = await manager.start();
  console.log(`Spark Ollama Manager ${VERSION} listening on http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`);
  console.log(`Initial administrator password: ${path.join(manager.dataDir,'first-login.txt')}`);
  let exiting = false;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,async () => { if (exiting) return; exiting = true; await manager.close(); process.exit(0); });
}
