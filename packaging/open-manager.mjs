import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function allowedManagerUrl(value) {
  if (typeof value !== 'string' || value.length > 500 || value.includes('\n')) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '42010') return true;
    return url.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(url.hostname) && Number(url.port) >= 1024 && Number(url.port) <= 65535;
  } catch { return false; }
}

export function managerUrl(file = '/etc/spark-ollama-manager.url') {
  let value = 'http://127.0.0.1:42010';
  try { value = readFileSync(file, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!allowedManagerUrl(value)) throw new Error('The configured manager URL is invalid. Reinstall or inspect /etc/spark-ollama-manager.url.');
  return value;
}

async function open(url) {
  for (const [command, args] of [['xdg-open', [url]], ['gio', ['open', url]]]) {
    const result = await new Promise(resolveResult => {
      const child = spawn(command, args, { shell: false, stdio: 'inherit' });
      child.once('error', () => resolveResult(false));
      child.once('close', code => resolveResult(code === 0));
    });
    if (result) return;
  }
  throw new Error(`No desktop browser launcher succeeded. Open ${url} manually.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && args[0] !== '--print-url')) throw new Error('Usage: spark-ollama-manager-open [--print-url]');
    const url = managerUrl();
    if (args[0] === '--print-url') console.log(url); else await open(url);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
