#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setPassword } from '../server.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/password.mjs [--data-dir DIRECTORY] [--generate]\nWithout --generate, reads a password from standard input. Restart the service to invalidate all existing sessions.');
  process.exit(0);
}
let dataDir = process.env.DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
let generate = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--data-dir' && args[index + 1]) dataDir = path.resolve(args[++index]);
  else if (args[index] === '--generate') generate = true;
  else throw new Error(`Unknown or incomplete option: ${args[index]}`);
}
let password;
if (generate) password = randomBytes(24).toString('base64url');
else if (process.stdin.isTTY && process.stdin.setRawMode) {
  process.stderr.write('New administrator password (at least 12 characters): ');
  password = await new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error) => { process.stdin.off('data',onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); error ? reject(error) : resolve(buffer); };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Password change cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') buffer = buffer.slice(0,-1);
        else if (character >= ' ' && buffer.length < 1024) buffer += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data',onData);
  });
}
else {
  const reader = createInterface({input:process.stdin,output:process.stdout,terminal:false});
  for await (const line of reader) { password = line; break; }
  reader.close();
}
await setPassword(dataDir, password);
const initialFile = path.join(dataDir,'first-login.txt');
if (generate) { await fs.writeFile(initialFile,`${password}\n`,{mode:0o600}); await fs.chmod(initialFile,0o600); }
else await fs.unlink(initialFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
console.log(`Administrator password updated.${generate ? ` Read ${initialFile} locally to sign in.` : ''} Restart the service to expire existing sessions.`);
