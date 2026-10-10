import { readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const allowedConfigKeys = new Set(['TCP', 'Web', 'AllowFunnel', 'Foreground']);

export const requiredSourceFiles = Object.freeze([
  'package.json', 'server.mjs', 'mcp-client.mjs', 'install.sh', 'uninstall.sh',
  'public/index.html', 'public/app.js', 'public/style.css', 'public/icon.svg',
  'public/manifest.webmanifest', 'public/sw.js',
  'deploy/deployment.mjs', 'deploy/spark-ollama-manager.service', 'scripts/password.mjs',
]);

export const installedSourceItems = Object.freeze([
  'server.mjs', 'mcp-client.mjs', 'package.json', 'API-CONTRACT.md', 'PROJECT-STUDY.md',
  'LICENSE', 'README.md', 'VERIFICATION.md', 'install.sh', 'uninstall.sh',
  'lib', 'public', 'scripts', 'deploy', 'docs',
]);

/** A release cannot omit a module or accidentally replace mutable state. */
export function validateSource(directory) {
  const root = realpathSync(directory);
  for (const item of requiredSourceFiles) {
    const path = join(root, item);
    let stat;
    try { stat = lstatSync(path); } catch { throw new Error(`Source is incomplete: ${item}.`); }
    if (!stat.isFile() || stat.isSymbolicLink() || !realpathSync(path).startsWith(root + sep)) {
      throw new Error(`Required source file is unsafe: ${item}.`);
    }
    if (!installedSourceItems.some(parent => item === parent || item.startsWith(parent + '/'))) {
      throw new Error(`Required source file would not be installed: ${item}.`);
    }
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'spark-ollama-manager' || !/^\d+\.\d+\.\d+$/.test(manifest.version || '')) throw new Error('Invalid application release manifest.');
  const [major, minor] = manifest.version.split('.').map(Number);
  if (major < 1 || (major === 1 && minor < 1)) throw new Error('This installer requires Spark Ollama Manager 1.1.0 or newer.');
  return manifest.version;
}

export function stageSource(directory, destination) {
  const version = validateSource(directory);
  const source = realpathSync(directory);
  const target = realpathSync(destination);
  if (source === target || target.startsWith(source + sep) || readdirSync(target).length) {
    throw new Error('Application staging requires a separate empty directory.');
  }
  for (const item of installedSourceItems) {
    const path = join(source, item);
    if (existsSync(path)) cpSync(path, join(target, item), { recursive: true, force: false, errorOnExist: true, dereference: false });
  }
  return version;
}

export function verifyHealth(payload, expectedVersion) {
  if (!record(payload) || payload.ok !== true || payload.version !== expectedVersion) {
    throw new Error('Manager health check or release version did not match the installed package.');
  }
  return true;
}

/** Fail closed if Tailscale returns an unfamiliar configuration shape. */
export function inspectServeConfig(config, port, target) {
  if (!record(config)) throw new Error('Invalid Tailscale serve configuration.');
  port = String(port);
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error('HTTPS port must be between 1024 and 65535.');
  }
  if (Object.keys(config).some(key => !allowedConfigKeys.has(key))) {
    throw new Error('Unrecognized Tailscale serve configuration; leave it unchanged.');
  }
  for (const key of ['TCP', 'Web', 'AllowFunnel', 'Foreground']) {
    if (config[key] !== undefined && !record(config[key])) {
      throw new Error(`Invalid Tailscale ${key} configuration.`);
    }
  }
  const web = Object.entries(config.Web || {});
  if (Object.keys(config.TCP || {}).some(key => !/^\d+$/.test(key) || Number(key) < 1 || Number(key) > 65535)) {
    throw new Error('Unrecognized Tailscale TCP port format.');
  }
  if (Object.entries(config.AllowFunnel || {}).some(([key, value]) => !/^.+:\d+$/.test(key) || typeof value !== 'boolean')) {
    throw new Error('Unrecognized Tailscale Funnel configuration.');
  }
  if (web.some(([key, value]) => !/^.+:\d+$/.test(key) || !record(value))) {
    throw new Error('Unrecognized Tailscale web route format.');
  }
  const routes = web.filter(([key]) => key.endsWith(`:${port}`));
  const tcp = config.TCP?.[port];
  const funnel = Object.entries(config.AllowFunnel || {}).some(([key, value]) => key.endsWith(`:${port}`) && value === true);
  let foregroundBusy = false;
  for (const value of Object.values(config.Foreground || {})) {
    if (inspectServeConfig(value, port, target).busy) foregroundBusy = true;
  }
  const busy = tcp !== undefined || routes.length > 0 || funnel || foregroundBusy;
  let matchesTarget = false;
  if (!foregroundBusy && !funnel && record(tcp) && tcp.HTTPS === true && routes.length === 1) {
    const handlers = routes[0][1].Handlers;
    matchesTarget = record(handlers) && Object.keys(handlers).length === 1 &&
      record(handlers['/']) && handlers['/'].Proxy === target;
  }
  return { busy, matchesTarget, hostname: matchesTarget ? routes[0][0].slice(0, -(port.length + 1)) : null };
}

export function tailscaleHostname(status) {
  if (!record(status) || status.BackendState !== 'Running') throw new Error('Tailscale is not connected.');
  const name = status.Self?.DNSName;
  if (typeof name !== 'string') throw new Error('Tailscale did not return a device DNS name.');
  const host = name.replace(/\.$/, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(host)) {
    throw new Error('Invalid Tailscale device DNS name.');
  }
  return host;
}

export function environmentFile(existing = '', origin = '') {
  if (origin && !/^https:\/\/[a-z0-9.-]+\.ts\.net:\d+$/.test(origin)) throw new Error('Invalid public origin.');
  const replaced = new Set(['HOST', 'PORT', 'DATA_DIR', 'PUBLIC_ORIGIN']);
  const lines = existing.split(/\r?\n/).filter(line => !replaced.has(line.match(/^\s*([A-Z_]+)\s*=/)?.[1]));
  const has = name => lines.some(line => new RegExp(`^\\s*${name}\\s*=`).test(line));
  const defaults = [];
  if (!has('OLLAMA_URL')) defaults.push('OLLAMA_URL=http://127.0.0.1:11434');
  if (!has('IMPORT_ROOTS')) defaults.push('IMPORT_ROOTS=/var/lib/spark-ollama-manager/imports');
  return [...lines.filter((line, index) => line || index < lines.length - 1),
    ...defaults, 'HOST=127.0.0.1', 'PORT=42010', 'DATA_DIR=/var/lib/spark-ollama-manager',
    ...(origin ? [`PUBLIC_ORIGIN=${origin}`] : [])].join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === 'source-check') console.log(validateSource(args[0]));
    else if (mode === 'install-items') console.log(installedSourceItems.join('\n'));
    else if (mode === 'stage-source') console.log(stageSource(args[0], args[1]));
    else if (mode === 'health-check') verifyHealth(JSON.parse(readFileSync(args[1] || 0, 'utf8')), args[0]);
    else if (mode === 'dns') console.log(tailscaleHostname(JSON.parse(readFileSync(args[0], 'utf8'))));
    else if (mode === 'serve-status') {
      const result = inspectServeConfig(JSON.parse(readFileSync(args[0], 'utf8')), args[1], args[2]);
      console.log(!result.busy ? 'free' : result.matchesTarget && result.hostname === args[3] ? 'matching' : 'busy');
    } else if (mode === 'marker-match') {
      const marker = JSON.parse(readFileSync(args[0], 'utf8'));
      process.exitCode = marker.hostname === args[1] && marker.port === Number(args[2]) && marker.target === args[3] ? 0 : 1;
    } else if (mode === 'marker-write') {
      writeFileSync(args[0], JSON.stringify({ hostname: args[1], port: Number(args[2]), target: args[3] }) + '\n', { mode: 0o600 });
    } else if (mode === 'marker-port') {
      const marker = JSON.parse(readFileSync(args[0], 'utf8'));
      if (!Number.isInteger(marker.port) || marker.port < 1024 || marker.port > 65535 || marker.target !== 'http://127.0.0.1:42010' || !/^[a-z0-9.-]+\.ts\.net$/.test(marker.hostname)) throw new Error('Invalid root-owned manager Tailscale marker.');
      console.log(marker.port);
    } else if (mode === 'env-write') {
      const existing = args[0] === '-' ? '' : readFileSync(args[0], 'utf8');
      writeFileSync(args[1], environmentFile(existing, args[2] || ''), { mode: 0o600 });
    } else if (mode === 'env-origin') {
      const text = readFileSync(args[0], 'utf8');
      const value = text.split(/\r?\n/).map(line => line.match(/^PUBLIC_ORIGIN=(.*)$/)?.[1]).filter(value => value !== undefined).at(-1) || '';
      if (value && !/^https:\/\/[a-z0-9.-]+\.ts\.net:\d+$/.test(value)) throw new Error('Existing PUBLIC_ORIGIN is unsupported; inspect /etc/spark-ollama-manager.env.');
      console.log(value);
    } else throw new Error('Unknown deployment helper command.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
