import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { SOURCE_URL, isTrustedOrigin, sameCheckoutDirectory, updateCheckout, runGit } from '../scripts/update.mjs';

const directory = resolve('/tmp/spark-checkout-fixture');
const current = 'a'.repeat(40), target = 'b'.repeat(40);
function fixture(overrides = {}) {
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, options });
    const key = args.join(' ');
    if (overrides[key] instanceof Error) throw overrides[key];
    if (key in overrides) return overrides[key];
    if (key === 'rev-parse --show-toplevel') return directory;
    if (key === 'config --get-all remote.origin.url') return SOURCE_URL;
    if (key === 'symbolic-ref --short HEAD') return 'main';
    if (key.startsWith('status ')) return '';
    if (key === 'config --null --list') return `remote.origin.url\n${SOURCE_URL}\0`;
    if (key === 'rev-parse HEAD') return current;
    if (key === 'rev-parse FETCH_HEAD') return target;
    if (key.startsWith('ls-remote ')) return `${target}\trefs/heads/main`;
    return '';
  };
  return { calls, runner };
}

test('only the fixed GitHub project origins are trusted', () => {
  for (const url of [SOURCE_URL, 'git@github.com:solomongs/Ollam-manager.git', 'ssh://git@github.com/solomongs/Ollam-manager.git']) assert.equal(isTrustedOrigin(url), true);
  for (const url of ['https://github.com/attacker/Ollam-manager.git', SOURCE_URL + '?extra=x', 'https://github.com.evil.test/solomongs/Ollam-manager.git', 'https://token@github.com/solomongs/Ollam-manager.git', 'file:///tmp/repo']) assert.equal(isTrustedOrigin(url), false);
});

test('checkout root identity accepts filesystem aliases and refuses a different directory', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'spark-git-root-'));
  try {
    const selected = join(workspace, 'repo'), other = join(workspace, 'other');
    mkdirSync(selected); mkdirSync(other);
    const alias = join(workspace, 'alias');
    symlinkSync(selected, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await sameCheckoutDirectory(selected, alias), true);
    assert.equal(await sameCheckoutDirectory(selected, other), false);
    assert.equal(await sameCheckoutDirectory(selected, join(workspace, 'missing')), false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('check only reads the remote branch and does not fetch or merge', async () => {
  const f = fixture();
  const result = await updateCheckout({ directory, runner: f.runner, hooksDirectory: '/tmp/empty-hooks', check: true });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.changed, false);
  assert.equal(f.calls.some(({ args }) => ['fetch', 'merge'].includes(args[0])), false);
  assert.deepEqual(f.calls.find(({ args }) => args[0] === 'ls-remote').args, ['ls-remote', '--exit-code', SOURCE_URL, 'refs/heads/main']);
});

test('dirty, foreign origin, branch, and rewritten source fail before fetch', async () => {
  for (const overrides of [
    { 'status --porcelain=v1 --untracked-files=all': ' M server.mjs' },
    { 'config --get-all remote.origin.url': 'https://github.com/another/repo.git' },
    { 'symbolic-ref --short HEAD': 'development' },
    { 'config --null --list': 'url.https://evil.test/.insteadof\nhttps://github.com/\0' },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(updateCheckout({ directory, runner: f.runner, hooksDirectory: '/tmp/empty-hooks' }));
    assert.equal(f.calls.some(({ args }) => args[0] === 'fetch'), false);
  }
});

test('update fetches the literal fixed source and only fast-forwards', async () => {
  const f = fixture();
  const result = await updateCheckout({ directory, runner: f.runner, hooksDirectory: '/tmp/empty-hooks' });
  assert.equal(result.changed, true);
  assert.deepEqual(f.calls.find(({ args }) => args[0] === 'fetch').args, ['fetch', '--no-tags', '--no-recurse-submodules', SOURCE_URL, 'refs/heads/main']);
  assert.deepEqual(f.calls.find(({ args }) => args[0] === 'merge').args, ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', target]);
  assert.equal(f.calls.some(({ args }) => ['reset', 'stash', 'checkout', 'clean', 'submodule'].includes(args[0])), false);
});

test('divergence does not merge, reset, stash or install', async () => {
  const f = fixture({ [`merge-base --is-ancestor ${current} ${target}`]: new Error('not ancestor') });
  await assert.rejects(updateCheckout({ directory, runner: f.runner, hooksDirectory: '/tmp/empty-hooks' }), /not ancestor/);
  assert.equal(f.calls.some(({ args }) => ['merge', 'reset', 'stash'].includes(args[0])), false);
});

test('real fast-forward refuses to overwrite ignored local credential state', { skip: spawnSync('git', ['--version']).status !== 0 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'spark-real-git-update-'));
  const directory = join(workspace, 'repo'); mkdirSync(directory);
  const hooksDirectory = join(workspace, 'hooks'); mkdirSync(hooksDirectory);
  const git = (...args) => {
    const result = spawnSync('git', ['-c', `core.hooksPath=${hooksDirectory}`, '-c', 'commit.gpgSign=false', ...args], { cwd: directory, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Update fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', SOURCE_URL);
    writeFileSync(join(directory, '.gitignore'), 'data/\n');
    writeFileSync(join(directory, 'README.md'), 'base fixture');
    git('add', '.'); git('commit', '-m', 'Base fixture');
    const before = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'incoming');
    mkdirSync(join(directory, 'data'));
    writeFileSync(join(directory, 'data/credentials.json'), 'remote fixture state');
    git('add', '-f', 'data/credentials.json'); git('commit', '-m', 'Incoming tracked state');
    const incoming = git('rev-parse', 'HEAD');
    git('checkout', 'main'); mkdirSync(join(directory, 'data'), { recursive: true });
    writeFileSync(join(directory, 'data/credentials.json'), 'local protected fixture state');
    assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');
    const runner = async (args, options) => {
      if (args[0] === 'fetch') { writeFileSync(join(directory, '.git/FETCH_HEAD'), `${incoming}\t\tfixture main\n`); return ''; }
      return runGit(args, options);
    };
    await assert.rejects(updateCheckout({ directory, hooksDirectory, runner }), /Git merge failed/);
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(directory, 'data/credentials.json'), 'utf8'), 'local protected fixture state');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
