import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

export async function startRuntime({sourceDir, userData, createManager}) {
  const dataDir = path.join(userData, 'data');
  const importsDir = path.join(userData, 'imports');
  await fs.mkdir(importsDir, {recursive:true, mode:0o700});
  const runtimeFile = path.join(userData, 'desktop-runtime.json');
  let savedPort = 0;
  try {
    const stat = await fs.lstat(runtimeFile);
    if (!stat.isFile() || stat.size > 1024) throw new Error('Desktop runtime settings are invalid.');
    const saved = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
    if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535) throw new Error('Desktop runtime settings contain an invalid port.');
    savedPort = saved.port;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const factory = createManager || (await import(pathToFileURL(path.join(sourceDir, 'server.mjs')).href)).createManager;
  const manager = await factory({
    dataDir,
    publicDir:path.join(sourceDir, 'public'),
    host:'127.0.0.1',
    port:savedPort,
    publicOrigin:null,
    installationMode:'desktop',
    importRoots:[importsDir],
    // Desktop settings are persisted through the UI rather than inherited shell service settings.
    ollamaUrl:'http://127.0.0.1:11434',
    initialServerName:'Local Ollama',
  });
  try {
    const address = await manager.start();
    if (!address || address.address !== '127.0.0.1' || !Number.isInteger(address.port) || address.port <= 0) throw new Error('Desktop backend did not bind to IPv4 loopback.');
    if (!savedPort) {
      await fs.writeFile(runtimeFile, `${JSON.stringify({version:1, port:address.port})}\n`, {mode:0o600, flag:'wx'});
    }
    return {manager, dataDir, importsDir, origin:`http://127.0.0.1:${address.port}`};
  } catch (error) {
    await manager.close().catch(() => {});
    if (error.code === 'EADDRINUSE' && savedPort) throw new Error(`The saved desktop port ${savedPort} is in use. Close the other program using that port and start Spark Ollama Manager again. If necessary, remove ${runtimeFile} to choose a new local port; browser bookmarks and assistant presets are tied to the old port.`);
    throw error;
  }
}

export async function readInitialPassword(dataDir) {
  const filename = path.join(dataDir, 'first-login.txt');
  const stat = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 4096) throw new Error('The initial password file is invalid.');
  return (await fs.readFile(filename, 'utf8')).trim();
}

export function getJSON(origin, endpoint) {
  return new Promise((resolve, reject) => {
    const request = http.get(new URL(endpoint, origin), {headers:{Origin:origin}}, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) response.destroy(new Error('Smoke response exceeded limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Smoke request failed: HTTP ${response.statusCode}.`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Smoke response was not JSON.')); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('Smoke request timed out.')));
    request.on('error', reject);
  });
}
