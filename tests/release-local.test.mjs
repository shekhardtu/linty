import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertMainMatches, localUiSuites, parseArgs, publishBuiltRelease, readPreviousManifest, runBrowserChecks, selectReleaseType, synchronizeMain, updaterManifest } from '../scripts/release-local.mjs';

test('browser validation is reused only with verified evidence; otherwise both complete suites run', () => {
  for (const evidence of [undefined, {}, { reused: false }, { reused: 'true' }]) {
    const calls = [];
    runBrowserChecks((command, args, options) => calls.push({ command, args, options }), {}, evidence);
    assert.deepEqual(calls[0].args, ['playwright', 'install', 'chromium', 'webkit']);
    for (const browser of ['chromium', 'webkit']) {
      assert.deepEqual(calls.filter(call => call.options?.env.UI_BROWSER === browser).map(call => call.args[0]), localUiSuites.map(suite => `test:${suite}`));
    }
  }
  runBrowserChecks(() => assert.fail('verified browser checks should not be repeated'), {}, { reused: true });
});

test('local releases include every browser suite required by the PR workflow', () => {
  const workflow = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  const uiJob = workflow.split('\n  ui-tests:\n')[1].split('\n  required-checks:\n')[0];
  const required = [...uiJob.matchAll(/run: yarn test:([a-z-]+)/g)].map(match => match[1]);
  assert.ok(required.length > 0);
  assert.deepEqual([...localUiSuites].sort(), required.sort());
});

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
  assert.deepEqual(parseArgs(['--publish', '--release-type', 'required']), { mode: '--publish', releaseType: 'required', bump: 'patch', help: false });
  assert.equal(parseArgs(['--publish', '--release-type', 'optional', '--bump', 'minor']).bump, 'minor');
  assert.equal(parseArgs(['--build-only']).mode, '--build-only');
  assert.throws(() => parseArgs(['--build-only', '--publish']));
  assert.throws(() => parseArgs(['--skip-tests']));
  assert.throws(() => parseArgs(['--release-type']));
  assert.throws(() => parseArgs(['--release-type', 'recommended']));
  assert.throws(() => parseArgs(['--bump', 'automatic']));
  assert.throws(() => parseArgs(['--bump', 'minor', '--bump', 'major']));
  assert.equal(parseArgs(['--publish', '--initial-release']).initialRelease, true);
  assert.throws(() => parseArgs(['--initial-release', '--bump', 'patch']));
});

test('an initial release needs a confirmed empty release history; API failures are fatal', () => {
  assert.deepEqual(readPreviousManifest({ initialRelease: true, gh: () => '[]' }), {});
  assert.throws(() => readPreviousManifest({ initialRelease: true, gh: () => '[{"tag_name":"v0.0.67"}]' }), /empty GitHub release history/);
  assert.throws(() => readPreviousManifest({ initialRelease: true, gh: () => { throw new Error('authentication failed'); } }), /authentication failed/);
});

test('every new publication asks required or optional without remembering a previous choice', async () => {
  let questions = 0;
  const ask = async () => { questions++; return 'Required'; };
  assert.equal(await selectReleaseType(parseArgs(['--publish']), ask), 'required');
  assert.equal(await selectReleaseType(parseArgs(['--publish']), ask), 'required');
  assert.equal(questions, 2);
  assert.equal(await selectReleaseType(parseArgs(['--publish', '--release-type', 'optional']), ask), 'optional');
  assert.equal(await selectReleaseType(parseArgs(['--build-only']), ask), 'optional');
  assert.equal(questions, 2, 'an explicit answer from the skill does not need a second terminal prompt');
  await assert.rejects(selectReleaseType(parseArgs(['--publish']), async () => ''), /no default/);
  await assert.rejects(selectReleaseType(parseArgs(['--publish']), async () => 'recommended'), /no default/);
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
  assert.deepEqual(Object.keys(result.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64']);
  assert.deepEqual(result.platforms['darwin-x86_64'], result.platforms['darwin-aarch64'],
    'both architectures must receive the same signed universal app');
  assert.equal(updaterManifest({ ...input, releaseType: 'required' }).minimum_version, '0.0.3');
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

test('initial publication tags the sole source commit without creating another commit', t => {
  const r = repo(t);
  r.git(['push', 'origin', ':refs/tags/v0.0.1']);
  r.git(['tag', '-d', 'v0.0.1']);
  const sourceSha = synchronizeMain(r.git);
  let published = false;
  const input = { git: r.git, gh: () => {}, sourceSha, builtSha: sourceSha, version: '0.0.1',
    buildDir: r.local, initialRelease: true, requireLocalPublisher: () => {}, upload: () => { published = true; } };
  assert.throws(() => publishBuiltRelease({ ...input, builtSha: 'different' }), /initial commit unchanged/);
  publishBuiltRelease(input);
  assert.equal(published, true);
  assert.equal(r.gitAt(r.remote, ['rev-parse', 'v0.0.1']), sourceSha);
  assert.equal(r.gitAt(r.remote, ['rev-list', '--all', '--count']), '1');
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
