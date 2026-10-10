#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_URL = 'https://github.com/solomongs/Ollam-manager.git';
export const SOURCE_BRANCH = 'main';
const defaultDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function isTrustedOrigin(value) {
  return /^(?:https:\/\/github\.com\/solomongs\/Ollam-manager(?:\.git)?|git@github\.com:solomongs\/Ollam-manager(?:\.git)?|ssh:\/\/git@github\.com\/solomongs\/Ollam-manager(?:\.git)?)$/i.test(value);
}

export function runGit(args, { directory, hooksDirectory, git = 'git' }) {
  const fixed = ['-c', `core.hooksPath=${hooksDirectory}`, '-c', 'credential.helper=',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', ...args];
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  return new Promise((resolveResult, reject) => {
    const child = spawn(git, fixed, { cwd: directory, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Git operation timed out. No forced reset was performed.')); }, 120000);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { child.kill(); reject(new Error('Git returned unexpectedly large output.')); return; }
        if (name === 'stdout') stdout += chunk; else stderr += chunk;
      });
    }
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Cannot start Git: ${error.code || 'unknown error'}. Install Git and ensure its executable is on PATH.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`Git ${args[0]} failed (exit ${code}). ${stderr.trim().slice(0, 1200)}`));
    });
  });
}

/** Manual checkout update only. Never elevates, installs, stashes, resets or starts a shell. */
export async function updateCheckout({ directory = defaultDirectory, check = false, runner = runGit, git = 'git', hooksDirectory } = {}) {
  directory = resolve(directory);
  let ownedHooks;
  if (!hooksDirectory) hooksDirectory = ownedHooks = await mkdtemp(join(tmpdir(), 'spark-git-no-hooks-'));
  const run = args => runner(args, { directory, hooksDirectory, git });
  try {
    const top = await run(['rev-parse', '--show-toplevel']);
    if (resolve(top) !== directory) throw new Error('Run the updater from the project checkout root, or pass --repo with that root. Packaged installations must use their released installer.');
    const origins = (await run(['config', '--get-all', 'remote.origin.url'])).split(/\r?\n/);
    if (origins.length !== 1 || !isTrustedOrigin(origins[0])) throw new Error(`The checkout origin must be ${SOURCE_URL}. Nothing was fetched.`);
    const branch = await run(['symbolic-ref', '--short', 'HEAD']);
    if (branch !== SOURCE_BRANCH) throw new Error('Update requires the main branch. Switch branches yourself; the updater will not discard work.');
    const clean = async () => {
      if (await run(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('The checkout has local or untracked changes. Commit or move them before updating; nothing will be discarded.');
    };
    await clean();
    // URL rewriting would invalidate the fixed source boundary, even with a trusted origin field.
    const config = await run(['config', '--null', '--list']);
    for (const item of config.split('\0')) {
      const separator = item.indexOf('\n');
      if (separator === -1) continue;
      const key = item.slice(0, separator), value = item.slice(separator + 1);
      if (/^url\..*\.insteadof$/i.test(key) && value && SOURCE_URL.startsWith(value)) throw new Error('Git URL rewriting affects the fixed source repository. Remove that rewrite before updating.');
    }
    const currentCommit = await run(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/i.test(currentCommit)) throw new Error('Git returned an invalid checkout commit.');
    if (check) {
      const result = await run(['ls-remote', '--exit-code', SOURCE_URL, 'refs/heads/main']);
      const match = result.match(/^([a-f0-9]{40,64})\s+refs\/heads\/main$/i);
      if (!match) throw new Error('The fixed repository did not return one main branch.');
      return { directory, branch, source: SOURCE_URL, currentCommit, targetCommit: match[1], updateAvailable: currentCommit !== match[1], changed: false };
    }
    await run(['fetch', '--no-tags', '--no-recurse-submodules', SOURCE_URL, 'refs/heads/main']);
    const targetCommit = await run(['rev-parse', 'FETCH_HEAD']);
    if (!/^[a-f0-9]{40,64}$/i.test(targetCommit)) throw new Error('Git returned an invalid fetched commit.');
    await clean();
    // Refuse divergent/local commits before allowing a fast-forward.
    await run(['merge-base', '--is-ancestor', currentCommit, targetCommit]);
    await run(['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', targetCommit]);
    return { directory, branch, source: SOURCE_URL, currentCommit, targetCommit, updateAvailable: false, changed: currentCommit !== targetCommit };
  } finally { if (ownedHooks) await rm(ownedHooks, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  let json = false;
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--check') options.check = true;
      else if (arg === '--json') json = true;
      else if ((arg === '--repo' || arg === '--git') && args[index + 1]) options[arg === '--repo' ? 'directory' : 'git'] = args[++index];
      else if (arg === '--help' || arg === '-h') {
        console.log('Usage: node scripts/update.mjs [--check] [--repo CHECKOUT_ROOT] [--git EXECUTABLE] [--json]\nUpdates only a clean main-branch checkout of solomongs/Ollam-manager, using HTTPS and fast-forward only.\nWindows/Linux source users restart their running app manually. DGX source service users then run: sudo bash install.sh\nPackaged Windows/Linux/DGX installations use the next released installer/package instead.');
        process.exit(0);
      } else throw new Error(`Unsupported argument: ${arg}`);
    }
    const result = await updateCheckout(options);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.changed ? `Checkout updated to ${result.targetCommit}.` : result.updateAvailable ? `Update available: ${result.targetCommit}. Run this command without --check to fetch and fast-forward.` : 'Checkout is up to date.');
      console.log('This command does not replace a running desktop app or service. Restart a source app manually; on a DGX source installation run sudo bash install.sh.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
