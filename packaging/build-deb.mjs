#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, chmodSync, lstatSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateSource, stageSource } from '../deploy/deployment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtime = Object.freeze(JSON.parse(readFileSync(new URL('./node-runtime.json', import.meta.url), 'utf8')));

export function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, { encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${commandName} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

export async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyArchive(file, expected = runtime) {
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('The pinned runtime checksum is invalid.');
  if (await checksum(file) !== expected.sha256) throw new Error('Node runtime SHA256 mismatch. The archive will not be extracted or packaged.');
}

export function verifyArm64Elf(file) {
  const fd = readFileSync(file);
  if (fd.length < 64 || !fd.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || fd[4] !== 2 || fd[5] !== 1 || fd.readUInt16LE(18) !== 183) {
    throw new Error('Bundled Node is not a 64-bit little-endian Linux AArch64 ELF executable.');
  }
}

export function controlFile(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version.');
  return `Package: spark-ollama-manager\nVersion: ${version}\nArchitecture: arm64\nSection: utils\nPriority: optional\nMaintainer: Solomon\nDepends: bash, libc6 (>= 2.28), libstdc++6 (>= 8), libgcc-s1, ca-certificates, curl, passwd, util-linux, iproute2, systemd\nRecommends: xdg-utils\nHomepage: https://github.com/solomongs/Ollam-manager\nDescription: Private Ollama and MCP web manager for NVIDIA DGX Spark\n A browser manager with a bundled checksum-verified ARM64 Node runtime.\n Runs as a dedicated user, keeps Ollama and GPU drivers unchanged,\n and preserves model files and application state during updates/removal.\n`;
}

function fixPermissions(directory) {
  chmodSync(directory, 0o755);
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Symlinks are not accepted in the packaged application.');
    if (item.isDirectory()) fixPermissions(path); else chmodSync(path, 0o644);
  }
}

async function downloadArchive(destination) {
  console.log(`Downloading pinned Node ${runtime.version} ARM64 from nodejs.org.`);
  const response = await fetch(runtime.url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Node download failed (${response.status}).`);
  let bytes = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > 128 * 1024 * 1024 ? new Error('Runtime archive exceeded the download limit.') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

export async function buildDeb({ source = root, outputDirectory = join(root, 'dist'), nodeArchive, check = false } = {}) {
  if (process.platform !== 'linux') throw new Error('Build the ARM64 Debian package on Linux; an x86 Linux build host is supported.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('The package builder requires Node.js >=22.');
  const version = validateSource(source);
  command('dpkg-deb', ['--version']);
  command('tar', ['--version']);
  if (check) return { version, architecture: 'arm64', nodeVersion: runtime.version, output: resolve(outputDirectory, `spark-ollama-manager_${version}_arm64.deb`), changed: false };
  const workspace = mkdtempSync(join(tmpdir(), 'spark-deb-build-'));
  try {
    const archive = nodeArchive ? resolve(nodeArchive) : join(workspace, runtime.filename);
    if (!nodeArchive) await downloadArchive(archive);
    await verifyArchive(archive);
    const extracted = join(workspace, 'node'); mkdirSync(extracted);
    command('tar', ['--extract', '--xz', '--file', archive, '--directory', extracted, '--no-same-owner', '--no-same-permissions']);
    const nodeRoot = join(extracted, `node-v${runtime.version}-linux-arm64`);
    const nodeBinary = join(nodeRoot, 'bin', 'node');
    const nodeLicense = join(nodeRoot, 'LICENSE');
    if (!lstatSync(nodeBinary).isFile() || lstatSync(nodeBinary).isSymbolicLink() || !lstatSync(nodeLicense).isFile()) throw new Error('Pinned Node archive did not contain the expected executable and license.');
    verifyArm64Elf(nodeBinary);
    const tree = join(workspace, 'package'); mkdirSync(tree);
    const bundle = join(tree, 'usr/lib/spark-ollama-manager-bundle');
    const application = join(bundle, 'app'); mkdirSync(application, { recursive: true });
    stageSource(source, application);
    fixPermissions(application);
    chmodSync(join(application, 'install.sh'), 0o755);
    chmodSync(join(application, 'uninstall.sh'), 0o755);
    mkdirSync(join(bundle, 'runtime'));
    copyFileSync(nodeBinary, join(bundle, 'runtime/node')); chmodSync(join(bundle, 'runtime/node'), 0o755);
    copyFileSync(nodeLicense, join(bundle, 'runtime/LICENSE.node'));
    copyFileSync(join(source, 'packaging/open-manager.mjs'), join(bundle, 'open-manager.mjs'));
    const bin = join(tree, 'usr/bin'); mkdirSync(bin, { recursive: true });
    copyFileSync(join(source, 'packaging/spark-ollama-manager-open'), join(bin, 'spark-ollama-manager-open')); chmodSync(join(bin, 'spark-ollama-manager-open'), 0o755);
    const applications = join(tree, 'usr/share/applications'); mkdirSync(applications, { recursive: true });
    copyFileSync(join(source, 'packaging/spark-ollama-manager.desktop'), join(applications, 'spark-ollama-manager.desktop'));
    const icons = join(tree, 'usr/share/icons/hicolor/scalable/apps'); mkdirSync(icons, { recursive: true });
    copyFileSync(join(source, 'public/icon.svg'), join(icons, 'spark-ollama-manager.svg'));
    const documentation = join(tree, 'usr/share/doc/spark-ollama-manager'); mkdirSync(documentation, { recursive: true });
    copyFileSync(join(source, 'LICENSE'), join(documentation, 'copyright'));
    copyFileSync(nodeLicense, join(documentation, 'LICENSE.node'));
    const metadata = join(tree, 'DEBIAN'); mkdirSync(metadata);
    writeFileSync(join(metadata, 'control'), controlFile(version));
    for (const script of ['postinst', 'prerm', 'postrm']) {
      copyFileSync(join(source, `packaging/${script}`), join(metadata, script)); chmodSync(join(metadata, script), 0o755);
      command('bash', ['-n', join(metadata, script)]);
    }
    const output = resolve(outputDirectory, `spark-ollama-manager_${version}_arm64.deb`);
    mkdirSync(dirname(output), { recursive: true });
    command('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', tree, output]);
    const sha256 = await checksum(output);
    writeFileSync(`${output}.sha256`, `${sha256}  ${output.split('/').at(-1)}\n`);
    const provenance = { version, architecture: 'arm64', node: runtime, debSha256: sha256, source: 'https://github.com/solomongs/Ollam-manager', buildHost: `${process.platform}/${process.arch}`, arm64ExecutionTested: false };
    writeFileSync(`${output}.provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
    return { version, architecture: 'arm64', nodeVersion: runtime.version, output, sha256, changed: true };
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  try {
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--check') options.check = true;
      else if (['--output-dir', '--node-archive', '--source'].includes(arg) && args[index + 1]) options[{ '--output-dir': 'outputDirectory', '--node-archive': 'nodeArchive', '--source': 'source' }[arg]] = resolve(args[++index]);
      else if (arg === '--help' || arg === '-h') {
        console.log('Usage: node packaging/build-deb.mjs [--check] [--output-dir dist] [--node-archive OFFICIAL_ARCHIVE] [--source PROJECT_ROOT]\nBuilds a Linux ARM64 .deb with pinned, checksum-verified Node runtime. An x86 Linux build host is supported.');
        process.exit(0);
      } else throw new Error(`Unknown argument: ${arg}`);
    }
    console.log(JSON.stringify(await buildDeb(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
