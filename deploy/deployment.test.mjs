import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectServeConfig, tailscaleHostname, environmentFile, validateSource, stageSource, verifyHealth, requiredSourceFiles } from './deployment.mjs';

const target = 'http://127.0.0.1:42010';
const host = 'spark.example.ts.net';
const route = { TCP: { '9443': { HTTPS: true } }, Web: { [`${host}:9443`]: { Handlers: { '/': { Proxy: target } } } } };

test('empty config is free; another HTTPS route stays free and untouched', () => {
  assert.equal(inspectServeConfig({}, 9443, target).busy, false);
  const config = { TCP: { '443': { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  const before = JSON.stringify(config);
  assert.equal(inspectServeConfig(config, 9443, target).busy, false);
  assert.equal(JSON.stringify(config), before);
});

test('existing port matches only the sole manager root route', () => {
  assert.deepEqual(inspectServeConfig(route, 9443, target), { busy: true, matchesTarget: true, hostname: host });
  const different = structuredClone(route);
  different.Web[`${host}:9443`].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
  assert.equal(inspectServeConfig(different, 9443, target).matchesTarget, false);
  different.Web[`${host}:9443`].Handlers['/'].Proxy = target;
  different.Web[`${host}:9443`].Handlers['/another-app'] = { Proxy: 'http://127.0.0.1:3000' };
  assert.equal(inspectServeConfig(different, 9443, target).matchesTarget, false);
});

test('TCP-only, public funnel and foreground collisions cannot be taken over', () => {
  assert.equal(inspectServeConfig({ TCP: { '9443': { TCPForward: 'localhost:1234' } } }, 9443, target).busy, true);
  assert.equal(inspectServeConfig({ ...route, AllowFunnel: { [`${host}:9443`]: true } }, 9443, target).matchesTarget, false);
  assert.equal(inspectServeConfig({ Foreground: { session: route } }, 9443, target).busy, true);
  assert.equal(inspectServeConfig({ Foreground: { session: route } }, 9443, target).matchesTarget, false);
});

test('unknown, malformed or invalid port configuration fails closed', () => {
  for (const config of [null, [], { NewFutureFeature: {} }, { TCP: [] }, { TCP: { 'host:9443': {} } }, { AllowFunnel: { port: true } }, { Web: { unexpected: {} } }]) {
    assert.throws(() => inspectServeConfig(config, 9443, target));
  }
  assert.throws(() => inspectServeConfig({}, 443, target));
});

test('only a connected, validated actual tailnet hostname is accepted', () => {
  assert.equal(tailscaleHostname({ BackendState: 'Running', Self: { DNSName: 'Spark.Example.ts.net.' } }), host);
  for (const status of [{}, { BackendState: 'Stopped', Self: { DNSName: host } }, { BackendState: 'Running', Self: { DNSName: 'evil\nHOST=0.0.0.0' } }, { BackendState: 'Running', Self: { DNSName: 'example.com' } }]) {
    assert.throws(() => tailscaleHostname(status));
  }
});

test('environment updates preserve custom Ollama and imports without evaluating values', () => {
  const config = environmentFile('OLLAMA_URL=http://127.0.0.1:11435\nIMPORT_ROOTS=/srv/gguf\nHOST=0.0.0.0\nPORT=9999\nDATA_DIR=/tmp/test\nPUBLIC_ORIGIN=https://old.ts.net:9443\n# literal $(touch /tmp/unsafe)\n', `https://${host}:9443`);
  assert.match(config, /OLLAMA_URL=http:\/\/127.0.0.1:11435/);
  assert.match(config, /IMPORT_ROOTS=\/srv\/gguf/);
  assert.match(config, /HOST=127.0.0.1/);
  assert.doesNotMatch(config, /HOST=0.0.0.0|PORT=9999|DATA_DIR=\/tmp\/test/);
  assert.match(config, /# literal \$\(touch \/tmp\/unsafe\)/);
  assert.match(config, /PUBLIC_ORIGIN=https:\/\/spark.example.ts.net:9443/);
  assert.throws(() => environmentFile('', 'https://bad.ts.net:9443\nHOST=0.0.0.0'));
});

test('installer and removal scripts parse; --check leaves managed paths untouched', () => {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const parsed = spawnSync('bash', ['-n', 'install.sh', 'uninstall.sh'], { cwd: directory, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const paths = ['/opt/spark-ollama-manager', '/var/lib/spark-ollama-manager', '/etc/spark-ollama-manager.env', '/etc/systemd/system/spark-ollama-manager.service', '/etc/spark-ollama-manager-tailscale.json'];
  const snapshot = () => paths.map(path => {
    try { const st = lstatSync(path); return { path, ino: st.ino, size: st.size, mtime: st.mtimeMs, mode: st.mode }; }
    catch (error) { if (error.code === 'ENOENT') return { path, absent: true }; throw error; }
  });
  const before = snapshot();
  const checked = spawnSync('bash', ['install.sh', '--check'], { cwd: directory, encoding: 'utf8', timeout: 15000 });
  assert.equal(checked.error, undefined);
  assert.deepEqual(snapshot(), before);
  if (process.arch !== 'arm64') {
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /targets Linux ARM64/);
  } else {
    assert.match(checked.stdout + checked.stderr, /Nothing changed|Read-only check finished/);
  }
});

test('1.1 release validation rejects an omitted or unsafe MCP client', () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-release-check-'));
  try {
    for (const item of requiredSourceFiles) {
      if (item === 'mcp-client.mjs') continue;
      mkdirSync(dirname(join(root, item)), { recursive: true });
      writeFileSync(join(root, item), item === 'package.json' ? JSON.stringify({ name: 'spark-ollama-manager', version: '1.1.0' }) : '// fixture');
    }
    assert.throws(() => validateSource(root), /incomplete: mcp-client\.mjs/);
    const outside = join(tmpdir(), `spark-outside-client-${process.pid}.mjs`);
    writeFileSync(outside, '// outside fixture');
    try {
      symlinkSync(outside, join(root, 'mcp-client.mjs'));
      assert.throws(() => validateSource(root), /unsafe: mcp-client\.mjs/);
      unlinkSync(join(root, 'mcp-client.mjs'));
    } finally { rmSync(outside, { force: true }); }
    writeFileSync(join(root, 'mcp-client.mjs'), '// client fixture');
    assert.equal(validateSource(root), '1.1.0');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'spark-ollama-manager', version: '1.0.0' }));
    assert.throws(() => validateSource(root), /1\.1\.0 or newer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('upgrade staging includes the MCP module and leaves credentials/MCP state separate', () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-upgrade-stage-'));
  try {
    const source = join(root, 'release');
    const stage = join(root, 'stage');
    const existingState = join(root, 'protected-state');
    mkdirSync(source); mkdirSync(stage); mkdirSync(existingState);
    for (const item of requiredSourceFiles) {
      mkdirSync(dirname(join(source, item)), { recursive: true });
      writeFileSync(join(source, item), item === 'package.json' ? JSON.stringify({ name: 'spark-ollama-manager', version: '1.1.0' }) : `// ${item}`);
    }
    const credentials = '{"salt":"existing","hash":"existing"}\n';
    const mcpState = '{"mcpServers":[{"id":"existing","enabled":true}]}\n';
    writeFileSync(join(existingState, 'credentials.json'), credentials);
    writeFileSync(join(existingState, 'state.json'), mcpState);
    mkdirSync(join(source, 'data'));
    writeFileSync(join(source, 'data', 'credentials.json'), 'wrong download state');
    assert.equal(stageSource(source, stage), '1.1.0');
    assert.equal(readFileSync(join(stage, 'mcp-client.mjs'), 'utf8'), '// mcp-client.mjs');
    assert.equal(existsSync(join(stage, 'data')), false);
    assert.equal(readFileSync(join(existingState, 'credentials.json'), 'utf8'), credentials);
    assert.equal(readFileSync(join(existingState, 'state.json'), 'utf8'), mcpState);
    assert.throws(() => stageSource(source, stage), /separate empty directory/);
    assert.throws(() => stageSource(source, source), /separate empty directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployment health rejects the previous release or a partial startup response', () => {
  assert.equal(verifyHealth({ ok: true, version: '1.1.0' }, '1.1.0'), true);
  for (const payload of [null, {}, { ok: false, version: '1.1.0' }, { ok: true, version: '1.0.0' }]) {
    assert.throws(() => verifyHealth(payload, '1.1.0'), /health check or release version/);
  }
});
