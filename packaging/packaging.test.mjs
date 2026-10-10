import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checksum, verifyArchive, verifyArm64Elf, controlFile, runtime, buildDeb } from './build-deb.mjs';
import { allowedManagerUrl, managerUrl } from './open-manager.mjs';
import { environmentFile } from '../deploy/deployment.mjs';

test('runtime archive is pinned to an official release and rejected on checksum mismatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-runtime-sha-'));
  try {
    const archive = join(root, 'archive'); writeFileSync(archive, 'fixture archive');
    await assert.rejects(verifyArchive(archive), /SHA256 mismatch/);
    await verifyArchive(archive, { sha256: await checksum(archive) });
    assert.equal(runtime.version, '22.23.3');
    assert.equal(new URL(runtime.url).hostname, 'nodejs.org');
    assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ELF validation rejects x86 or non-executable files without running them', () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-runtime-elf-'));
  try {
    const file = join(root, 'node');
    const header = Buffer.alloc(64); header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); header.writeUInt16LE(183, 18);
    writeFileSync(file, header); verifyArm64Elf(file);
    header.writeUInt16LE(62, 18); writeFileSync(file, header); assert.throws(() => verifyArm64Elf(file), /AArch64 ELF/);
    writeFileSync(file, 'not executable'); assert.throws(() => verifyArm64Elf(file), /AArch64 ELF/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Debian metadata selects ARM64 and system prerequisites without Ollama or driver packages', () => {
  const metadata = controlFile('1.2.0');
  assert.match(metadata, /^Architecture: arm64$/m);
  assert.match(metadata, /^Depends: .*systemd/m);
  assert.doesNotMatch(metadata.split('\n').find(line => line.startsWith('Depends:')), /ollama|nvidia|nodejs/);
  assert.throws(() => controlFile('1.2.0\nDepends: evil'), /Invalid package version/);
});

test('desktop launcher accepts only the local manager or validated private tailnet HTTPS URLs', () => {
  assert.equal(allowedManagerUrl('http://127.0.0.1:42010'), true);
  assert.equal(allowedManagerUrl('https://spark.tail1234.ts.net:9443'), true);
  for (const value of ['file:///etc/passwd', 'https://example.com:9443', 'http://127.0.0.1:11434', 'https://user:pass@spark.tail1234.ts.net:9443', 'https://spark.tail1234.ts.net:9443?x=1', 'https://spark.tail1234.ts.net:9443\n--option']) assert.equal(allowedManagerUrl(value), false);
  const root = mkdtempSync(join(tmpdir(), 'spark-launch-url-'));
  try {
    const file = join(root, 'url'); writeFileSync(file, 'https://spark.tail1234.ts.net:9443\n');
    assert.equal(managerUrl(file), 'https://spark.tail1234.ts.net:9443');
    writeFileSync(file, 'https://evil.example'); assert.throws(() => managerUrl(file), /invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Debian mode is explicit and cannot inject environment configuration', () => {
  assert.match(environmentFile('SPARK_INSTALLATION_MODE=dgx\n', '', 'deb'), /^SPARK_INSTALLATION_MODE=deb$/m);
  assert.equal((environmentFile('SPARK_INSTALLATION_MODE=dgx\n', '', 'deb').match(/SPARK_INSTALLATION_MODE=/g) || []).length, 1);
  assert.throws(() => environmentFile('', '', 'deb\nHOST=0.0.0.0'), /Unsupported installation/);
});

test('package maintainer scripts parse and upgrades/removal preserve application state', { skip: process.platform !== 'linux' }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync('bash', ['-n', 'packaging/postinst', 'packaging/prerm', 'packaging/postrm', 'install.sh', 'uninstall.sh'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const script of ['postinst', 'prerm', 'postrm']) {
    assert.doesNotMatch(readFileSync(join(root, 'packaging', script), 'utf8'), /rm\s+[^\n]*\/var\/lib/);
  }
});

test('builder check validates prerequisites without creating a package', { skip: process.platform !== 'linux' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-deb-check-'));
  try {
    const result = await buildDeb({ outputDirectory: root, check: true });
    assert.equal(result.changed, false);
    assert.equal(result.architecture, 'arm64');
    assert.match(result.output, /_arm64\.deb$/);
    assert.throws(() => readFileSync(result.output), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
