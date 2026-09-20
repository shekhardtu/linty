import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertMainMatches, parseArgs, publishBuiltRelease, synchronizeMain, updaterManifest } from '../scripts/release-local.mjs';

function repo(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'linty-local-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const peer = path.join(root, 'peer');
  const gitAt = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const git = args => gitAt(local, args);
  const peerGit = args => gitAt(peer, args);
  const identity = cwd => {
    gitAt(cwd, ['config', 'user.name', 'Release Test']);
    gitAt(cwd, ['config', 'user.email', 'release@example.com']);
  };
  const commit = (cwd, file, text) => {
    writeFileSync(path.join(cwd, file), text);
    gitAt(cwd, ['add', file]);
    gitAt(cwd, ['commit', '-qm', `Change ${file}`]);
    return gitAt(cwd, ['rev-parse', 'HEAD']);
  };
  gitAt(root, ['init', '--bare', '-b', 'main', remote]);
  gitAt(root, ['clone', remote, local]);
  identity(local);
  commit(local, 'RELEASE_NOTES.md', '- Publish tested improvements from the maintainer Mac.\n');
  git(['tag', 'v0.0.1']);
  git(['push', 'origin', 'main', '--tags']);
  gitAt(root, ['clone', remote, peer]);
  identity(peer);
  return { root, remote, local, peer, git, peerGit, gitAt, identity, commit };
}

test('local release defaults to a non-publishing check and rejects conflicting modes', () => {
  assert.equal(parseArgs([]).mode, '--check');
  assert.deepEqual(parseArgs(['--publish', '--force-update']), { mode: '--publish', forceUpdate: true, help: false });
  assert.equal(parseArgs(['--build-only']).mode, '--build-only');
  assert.throws(() => parseArgs(['--build-only', '--publish']));
  assert.throws(() => parseArgs(['--skip-tests']));
});

test('fast-forwards local main when the remote has new commits', t => {
  const r = repo(t);
  const latest = r.commit(r.peer, 'remote.txt', 'remote improvement');
  r.peerGit(['push', 'origin', 'main']);
  assert.equal(synchronizeMain(r.git), latest);
  assertMainMatches(r.git, latest);
});

test('pushes unpublished local main commits before selecting the build source', t => {
  const r = repo(t);
  const local = r.commit(r.local, 'local.txt', 'local improvement');
  assert.equal(synchronizeMain(r.git), local);
  assert.equal(r.gitAt(r.remote, ['rev-parse', 'main']), local);
});

test('reconciles divergent main branches without replacing remote commits', t => {
  const r = repo(t);
  r.commit(r.local, 'local.txt', 'local improvement');
  const remote = r.commit(r.peer, 'remote.txt', 'remote improvement');
  r.peerGit(['push', 'origin', 'main']);
  const sha = synchronizeMain(r.git);
  assert.equal(r.gitAt(r.remote, ['rev-parse', 'main']), sha);
  assert.equal(r.git(['rev-parse', 'HEAD^']), remote);
  assert.equal(readFileSync(path.join(r.local, 'remote.txt'), 'utf8'), 'remote improvement');
  assert.equal(readFileSync(path.join(r.local, 'local.txt'), 'utf8'), 'local improvement');
});

test('conflicts restore the original local commit and prevent publication', t => {
  const r = repo(t);
  const before = r.commit(r.local, 'RELEASE_NOTES.md', '- Local change to the same line.\n');
  const remote = r.commit(r.peer, 'RELEASE_NOTES.md', '- Remote change to the same line.\n');
  r.peerGit(['push', 'origin', 'main']);
  assert.throws(() => synchronizeMain(r.git), /conflicts/);
  assert.equal(r.git(['rev-parse', 'HEAD']), before);
  assert.equal(r.git(['status', '--porcelain']), '');
  assert.equal(r.gitAt(r.remote, ['rev-parse', 'main']), remote);
});

test('uncommitted changes and feature branches cannot be deployed', t => {
  const r = repo(t);
  writeFileSync(path.join(r.local, 'unfinished.txt'), 'work in progress');
  assert.throws(() => synchronizeMain(r.git), /Commit or move changes/);
  assert.equal(readFileSync(path.join(r.local, 'unfinished.txt'), 'utf8'), 'work in progress');
  rmSync(path.join(r.local, 'unfinished.txt'));
  r.git(['switch', '-c', 'feature']);
  assert.throws(() => synchronizeMain(r.git), /main worktree/);
});

test('a protected-branch push rejection leaves local commits intact and stops the release', t => {
  const r = repo(t);
  const remote = r.gitAt(r.remote, ['rev-parse', 'main']);
  const local = r.commit(r.local, 'local.txt', 'requires a PR');
  writeFileSync(path.join(r.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.throws(() => synchronizeMain(r.git), /checked PR/);
  assert.equal(r.git(['rev-parse', 'HEAD']), local);
  assert.equal(r.gitAt(r.remote, ['rev-parse', 'main']), remote);
});

test('a remote update during synchronization cannot become an unverified build source', t => {
  const r = repo(t);
  let fetches = 0;
  const git = args => {
    if (args[0] === 'fetch' && ++fetches === 2) {
      r.commit(r.peer, 'remote.txt', 'arrived during synchronization');
      r.peerGit(['push', 'origin', 'main']);
    }
    return r.git(args);
  };
  assert.throws(() => synchronizeMain(git), /must match/);
});

test('the updater manifest preserves required updates unless explicitly raised', () => {
  const input = { version: '0.0.3', notes: '- Faster updates.', signature: 'signed\n', archive: 'Linty.app.tar.gz', previous: { minimum_version: '0.0.2' } };
  const result = updaterManifest(input);
  assert.equal(result.minimum_version, '0.0.2');
  assert.equal(result.platforms['darwin-aarch64'].signature, 'signed');
  assert.match(result.platforms['darwin-aarch64'].url, /\/v0\.0\.3\/Linty\.app\.tar\.gz$/);
  assert.equal(updaterManifest({ ...input, forceUpdate: true }).minimum_version, '0.0.3');
  assert.equal(Object.hasOwn(updaterManifest({ ...input, previous: {} }), 'minimum_version'), false);
  assert.throws(() => updaterManifest({ ...input, previous: { minimum_version: '0.0.4' } }));
  assert.throws(() => updaterManifest({ ...input, signature: '' }));
  assert.throws(() => updaterManifest({ ...input, archive: '../wrong.tar.gz' }));
});

function builtRelease(t) {
  const r = repo(t);
  const sourceSha = synchronizeMain(r.git);
  const buildDir = path.join(r.root, 'build');
  r.git(['worktree', 'add', '--detach', buildDir, sourceSha]);
  const builtSha = r.commit(buildDir, 'version.txt', '0.0.2');
  const calls = [];
  const input = { git: r.git, sourceSha, builtSha, version: '0.0.2', buildDir,
    requireLocalPublisher: () => calls.push('verify local publisher'),
    gh: args => {
      assert.equal(r.gitAt(r.remote, ['rev-parse', 'refs/tags/v0.0.2']), builtSha);
      assert.ok(args.includes('--verify-tag'));
      assert.ok(args.includes('--draft'));
      calls.push('create draft');
    },
    upload: tag => { assert.equal(tag, 'v0.0.2'); calls.push('upload and publish'); },
  };
  return { ...r, input, calls };
}

test('publishes the exact built version commit while keeping both main branches identical', t => {
  const r = builtRelease(t);
  publishBuiltRelease(r.input);
  assert.deepEqual(r.calls, ['verify local publisher', 'create draft', 'upload and publish']);
  assert.equal(r.git(['rev-parse', 'main']), r.input.sourceSha);
  assert.equal(r.gitAt(r.remote, ['rev-parse', 'main']), r.input.sourceSha);
  assert.equal(r.gitAt(r.remote, ['rev-parse', 'v0.0.2']), r.input.builtSha);
});

test('main moving during compilation prevents release creation and uploads', t => {
  const r = builtRelease(t);
  r.commit(r.peer, 'remote.txt', 'new main');
  r.peerGit(['push', 'origin', 'main']);
  assert.throws(() => publishBuiltRelease(r.input), /must match/);
  assert.deepEqual(r.calls, ['verify local publisher']);
  assert.equal(r.git(['tag', '--list', 'v0.0.2']), '');
});

test('a competing release version prevents tag replacement and uploads', t => {
  const r = builtRelease(t);
  r.peerGit(['tag', 'v0.0.2']);
  r.peerGit(['push', 'origin', 'v0.0.2']);
  assert.throws(() => publishBuiltRelease(r.input), /tags changed/);
  assert.deepEqual(r.calls, ['verify local publisher']);
  assert.notEqual(r.gitAt(r.remote, ['rev-parse', 'v0.0.2']), r.input.builtSha);
});

test('enabling remote releases prevents local publication', t => {
  const r = builtRelease(t);
  r.input.requireLocalPublisher = () => { throw new Error('remote release enabled'); };
  assert.throws(() => publishBuiltRelease(r.input), /remote release enabled/);
  assert.deepEqual(r.calls, []);
  assert.equal(r.git(['tag', '--list', 'v0.0.2']), '');
});

test('a failed draft creation never uploads or publishes assets', t => {
  const r = builtRelease(t);
  r.input.gh = () => { throw new Error('draft creation failed'); };
  assert.throws(() => publishBuiltRelease(r.input), /draft creation failed/);
  assert.deepEqual(r.calls, ['verify local publisher']);
});

test('the local command refuses to run inside GitHub Actions', () => {
  const result = spawnSync(process.execPath, ['scripts/release-local.mjs', '--publish'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot run in GitHub Actions/);
});
