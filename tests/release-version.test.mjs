import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from '../scripts/prepare-release.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('release versions advance past source versions and previously used tags', () => {
  assert.equal(nextVersion('0.0.52', []), '0.0.53');
  assert.equal(nextVersion('0.0.52', ['v0.0.53', 'v0.0.99', 'v0.0.9']), '0.0.100');
  assert.equal(nextVersion('0.1.0', ['v0.0.99', 'unrelated', 'v9.0.0-beta']), '0.1.1');
  assert.throws(() => nextVersion('dev', []), /Invalid package version/);
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
