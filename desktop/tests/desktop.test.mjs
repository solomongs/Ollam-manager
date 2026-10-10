import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {sameOrigin, permittedRequest, permittedExternalURL, parseSmokeArguments, configureWindow, configureSession, WEB_PREFERENCES} from '../security.mjs';
import {startRuntime, readInitialPassword, getJSON} from '../runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('renderer origin guard rejects alternate hosts, credentials and active protocols', () => {
  const origin = 'http://127.0.0.1:42010';
  assert.equal(sameOrigin(`${origin}/#settings`, origin), true);
  for (const url of ['http://localhost:42010/', 'http://127.0.0.1:42011/', 'https://127.0.0.1:42010/', 'http://secret@127.0.0.1:42010/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://example.com/']) assert.equal(sameOrigin(url, origin), false, url);
  assert.equal(permittedRequest('data:image/png;base64,AA==', origin, 'image'), true);
  assert.equal(permittedRequest('data:text/html,<script/>', origin, 'mainFrame'), false);
  assert.equal(permittedRequest(`blob:${origin}/123`, origin, 'image'), true);
  assert.equal(permittedRequest('blob:https://example.com/123', origin, 'image'), false);
});

test('session and window deny navigation, popups, permissions and remote requests', () => {
  const handlers = {};
  const contents = {setWindowOpenHandler(fn) { handlers.popup=fn; }, on(name, fn) { handlers[name]=fn; }};
  configureWindow({webContents:contents}, 'http://127.0.0.1:5');
  assert.deepEqual(handlers.popup({url:'https://example.com'}), {action:'deny'});
  let prevented = false;
  handlers['will-navigate']({preventDefault() { prevented=true; }}, 'https://example.com');
  assert.equal(prevented, true);
  const session = {setPermissionRequestHandler(fn) { handlers.permission=fn; }, setPermissionCheckHandler(fn) { handlers.check=fn; }, on(name, fn) { handlers[name]=fn; }, webRequest:{onBeforeRequest(fn) { handlers.request=fn; }}};
  configureSession(session, 'http://127.0.0.1:5');
  handlers.permission(null, 'camera', value => assert.equal(value, false));
  assert.equal(handlers.check(), false);
  const trusted = {isDestroyed:() => false, isFocused:() => true, getURL:() => 'http://127.0.0.1:5/#settings'};
  const details = {isMainFrame:true, requestingUrl:'http://127.0.0.1:5/'};
  assert.equal(handlers.check(trusted, 'clipboard-sanitized-write', 'http://127.0.0.1:5', details), true);
  assert.equal(handlers.check(trusted, 'clipboard-read', 'http://127.0.0.1:5', details), false);
  assert.equal(handlers.check(trusted, 'clipboard-sanitized-write', 'https://evil.com', {...details, requestingUrl:'https://evil.com'}), false);
  assert.equal(handlers.check(trusted, 'clipboard-sanitized-write', 'http://127.0.0.1:5', {...details, isMainFrame:false}), false);
  handlers.request({url:'https://example.com/', resourceType:'script'}, value => assert.equal(value.cancel, true));
  assert.equal(WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(WEB_PREFERENCES.contextIsolation, true);
  assert.equal(WEB_PREFERENCES.sandbox, true);
});

test('external browser links are limited to official repository releases and Ollama pages', () => {
  assert.equal(permittedExternalURL('https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe'), 'https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe');
  assert.equal(permittedExternalURL('https://ollama.com/library/llama3'), 'https://ollama.com/library/llama3');
  for (const url of ['https://github.com/solomongs/Ollam-manager/releases-evil', 'https://github.com/other/repo', 'https://github.com/solomongs/Ollam-manager/releases?redirect=https://evil.com', 'https://ollama.com/library-evil', 'https://evil.com', 'https://ollama.com:444/library', 'file:///C:/Windows/cmd.exe', 'https://token@ollama.com/library', 'https://github.com/solomongs/Ollam-manager/archive/%2e%2e/evil']) assert.equal(permittedExternalURL(url), null, url);
});

test('smoke paths require explicit smoke mode and absolute paths', () => {
  assert.deepEqual(parseSmokeArguments([]), {enabled:false});
  assert.throws(() => parseSmokeArguments(['--smoke-output=/tmp/x']), /requires/);
  assert.throws(() => parseSmokeArguments(['--desktop-smoke-test', '--smoke-output=relative', '--smoke-user-data=/tmp/test']), /absolute/);
  assert.throws(() => parseSmokeArguments(['--desktop-smoke-test']), /requires/);
  const temp = path.resolve(os.tmpdir(), 'spark-smoke');
  assert.deepEqual(parseSmokeArguments(['--desktop-smoke-test', `--smoke-output=${temp}.json`, `--smoke-user-data=${temp}`]), {enabled:true, output:`${temp}.json`, userData:temp});
});

test('desktop runtime uses real backend, private state, authenticated loopback and shuts down', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'spark-desktop-test-'));
  let runtime;
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = 'https://example.com';
  try {
    runtime = await startRuntime({sourceDir:root, userData:scratch});
    const health = await getJSON(runtime.origin, '/api/health');
    assert.equal(health.ok, true);
    const auth = await getJSON(runtime.origin, '/api/session');
    assert.equal(auth.authenticated, false);
    const password = await readInitialPassword(runtime.dataDir);
    assert.ok(password.length >= 12);
    const response = await fetch(`${runtime.origin}/api/state`, {headers:{Origin:runtime.origin}});
    assert.equal(response.status, 401);
    const login = await fetch(`${runtime.origin}/api/login`, {method:'POST', headers:{Origin:runtime.origin, 'Content-Type':'application/json'}, body:JSON.stringify({password})});
    assert.equal(login.status, 200);
    assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
    await runtime.manager.close();
    runtime = null;
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN=previous;
    await runtime?.manager.close();
    await fs.rm(scratch, {recursive:true, force:true});
  }
});

test('desktop restarts preserve the origin and fail clearly if its saved port is occupied', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'spark-desktop-port-'));
  let runtime;
  let occupied;
  try {
    runtime = await startRuntime({sourceDir:root, userData:scratch});
    const origin = runtime.origin;
    const port = new URL(origin).port;
    await runtime.manager.close();
    runtime = await startRuntime({sourceDir:root, userData:scratch});
    assert.equal(runtime.origin, origin);
    await runtime.manager.close();
    runtime = null;
    occupied = net.createServer();
    await new Promise((resolve,reject) => occupied.listen(Number(port), '127.0.0.1', resolve).once('error', reject));
    await assert.rejects(startRuntime({sourceDir:root, userData:scratch}), /saved desktop port.*in use/);
  } finally {
    await runtime?.manager.close();
    if (occupied?.listening) await new Promise(resolve => occupied.close(resolve));
    await fs.rm(scratch, {recursive:true, force:true});
  }
});

test('build configuration bundles only required runtime files and preserves per-user state', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'desktop/package.json'), 'utf8'));
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.buildUniversalInstaller, false);
  assert.equal(pkg.devDependencies['electron-builder'], '26.15.6');
  assert.equal(pkg.build.win.target, 'nsis');
  assert.equal(pkg.build.win.requestedExecutionLevel, 'asInvoker');
  assert.ok(pkg.build.extraResources[0].filter.includes('mcp-client.mjs'));
  assert.ok(!pkg.build.extraResources[0].filter.includes('**/*'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
});
