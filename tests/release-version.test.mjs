import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from '../scripts/prepare-release.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('release versions advance past source versions and previously used tags', () => {
  assert.equal(nextVersion('0.0.52', []), '0.0.53');
  assert.equal(nextVersion('0.0.52', ['v0.0.53', 'v0.0.99', 'v0.0.9']), '0.0.100');
  assert.equal(nextVersion('0.1.0', ['v0.0.99', 'unrelated', 'v9.0.0-beta']), '0.1.1');
  assert.throws(() => nextVersion('dev', []), /Invalid package version/);
});

test('minor and major bumps require an explicit choice and reset lower version parts', () => {
  assert.equal(nextVersion('0.0.52', ['v0.0.99']), '0.0.100');
  assert.equal(nextVersion('0.0.52', ['v0.0.99'], 'minor'), '0.1.0');
  assert.equal(nextVersion('0.0.52', ['v1.4.9'], 'minor'), '1.5.0');
  assert.equal(nextVersion('0.0.52', ['v1.4.9'], 'major'), '2.0.0');
  assert.throws(() => nextVersion('0.0.52', [], 'automatic'), /Version bump/);
});

test('build-only candidates retain the publish notes gate and transfer their exact source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linty-build-only-test-'));
  const source = join(directory, 'source');
  const publisher = join(directory, 'publisher');
  const prepare = resolve('scripts/prepare-release.mjs');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = cwd => {
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Release Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'version');
    return git(cwd, 'rev-parse', 'HEAD');
  };
  try {
    await mkdir(join(source, 'src-tauri'), { recursive: true });
    await mkdir(publisher);
    await writeFile(join(source, 'RELEASE_NOTES.md'), '- See what improved after Linty updates and restarts.\n');
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      await writeFile(join(source, file), '{"name":"linty","version":"0.0.52"}\n');
    }
    await writeFile(join(source, 'src-tauri/Cargo.toml'), '[package]\nname = "linty"\nversion = "0.0.52"\n');
    await writeFile(join(source, 'src-tauri/Cargo.lock'), '[[package]]\nname = "linty"\nversion = "0.0.52"\n');
    git(source, 'init', '-q');
    const base = commit(source);
    git(source, 'tag', 'v0.0.52');
    const normal = spawnSync(process.execPath, [prepare], { cwd: source, encoding: 'utf8' });
    assert.notEqual(normal.status, 0, 'publishing still requires changed release notes');
    assert.match(normal.stderr, /still contains the notes/);
    const version = execFileSync(process.execPath, [prepare, '--build-only'], { cwd: source, encoding: 'utf8' }).trim();
    assert.equal(version, '0.0.53');
    assert.equal(git(source, 'tag'), 'v0.0.52', 'a build-only candidate creates no release tag');
    const built = commit(source);
    const bundle = join(directory, 'release-source.bundle');
    git(source, 'bundle', 'create', bundle, 'HEAD', `^${base}`);

    git(publisher, 'init', '-q');
    git(publisher, 'fetch', source, base);
    git(publisher, 'checkout', '--detach', base);
    git(publisher, 'bundle', 'verify', bundle);
    git(publisher, 'fetch', bundle, 'HEAD');
    assert.equal(git(publisher, 'rev-parse', 'FETCH_HEAD'), built);
    assert.equal(git(publisher, 'rev-parse', `${built}^`), base);
    git(publisher, 'checkout', '--detach', built);
    assert.equal(JSON.parse(await readFile(join(publisher, 'package.json'), 'utf8')).version, version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release preparation changes only the app version in all four manifests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linty-release-test-'));
  try {
    await mkdir(join(directory, 'src-tauri'));
    await writeFile(join(directory, 'RELEASE_NOTES.md'), '- See what improved after Linty updates and restarts.\n');
    await writeFile(join(directory, 'package.json'), '{"name":"linty","version":"0.0.52"}\n');
    await writeFile(join(directory, 'src-tauri/tauri.conf.json'), '{"version":"0.0.52"}\n');
    await writeFile(join(directory, 'src-tauri/Cargo.toml'), '[package]\nname = "linty"\nversion = "0.0.52"\n');
    await writeFile(join(directory, 'src-tauri/Cargo.lock'), '[[package]]\nname = "linty"\nversion = "0.0.52"\n\n[[package]]\nname = "other"\nversion = "1.2.3"\n');
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const version = execFileSync(process.execPath, [resolve('scripts/prepare-release.mjs')], { cwd: directory, encoding: 'utf8' }).trim();
    assert.equal(version, '0.0.53');
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      assert.equal(JSON.parse(await readFile(join(directory, file), 'utf8')).version, version);
    }
    assert.match(await readFile(join(directory, 'src-tauri/Cargo.toml'), 'utf8'), /version = "0\.0\.53"/);
    const lock = await readFile(join(directory, 'src-tauri/Cargo.lock'), 'utf8');
    assert.match(lock, /name = "linty"\nversion = "0\.0\.53"/);
    assert.match(lock, /name = "other"\nversion = "1\.2\.3"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
