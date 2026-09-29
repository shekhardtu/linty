import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appDigest, cleanupPublishedArtifacts, fileDigest, preservePreviousBundle, releaseTargetDirectory } from '../scripts/release-artifacts.mjs';
import { prepareMacosDmg } from '../scripts/prepare-macos-dmg.mjs';

function fixture(t) {
  const storage = mkdtempSync(path.join(tmpdir(), 'linty-release-artifacts-'));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const write = (relative, content = relative) => {
    const file = path.join(storage, relative);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); return file;
  };
  return { storage, write };
}

test('release target excludes app builds from Spotlight and migrates the existing cache once', t => {
  const { storage, write } = fixture(t);
  write('cache/target/compiled-dependency', 'keep');
  const target = releaseTargetDirectory(storage);
  assert.equal(path.basename(target), 'target.noindex');
  assert.equal(readFileSync(path.join(target, 'compiled-dependency'), 'utf8'), 'keep');
  assert.ok(lstatSync(path.join(storage, 'cache/target')).isSymbolicLink());
  assert.equal(readFileSync(path.join(storage, 'cache/target/compiled-dependency'), 'utf8'), 'keep');
  assert.equal(releaseTargetDirectory(storage), target);
  rmSync(path.join(storage, 'cache/target'));
  write('cache/target/another-build');
  assert.throws(() => releaseTargetDirectory(storage), /Both old and excluded/);
  assert.ok(existsSync(path.join(target, 'compiled-dependency')));
});

test('release cache cannot be redirected to an unrelated directory', t => {
  const { storage, write } = fixture(t);
  const keep = write('unrelated/keep', 'customer data');
  mkdirSync(path.join(storage, 'cache'));
  symlinkSync(path.dirname(keep), path.join(storage, 'cache/target.noindex'));
  assert.throws(() => releaseTargetDirectory(storage), /redirected release cache/);
  assert.equal(readFileSync(keep, 'utf8'), 'customer data');
});

function publication(t) {
  const { storage, write } = fixture(t);
  const buildDir = path.join(storage, 'build-test');
  const prefix = 'src-tauri/target/release/bundle/';
  const files = [`${prefix}dmg/linty-1.2.3.dmg`, `${prefix}dmg/linty.dmg`, `${prefix}macos/Linty.app.tar.gz`, `${prefix}macos/Linty.app.tar.gz.sig`, 'latest.json'];
  const checksums = {};
  const release = { tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [] };
  for (const file of files) {
    const content = file.endsWith('.dmg') ? 'same signed installer' : file;
    write(`build-test/${file}`, content);
    const digest = createHash('sha256').update(content).digest('hex');
    checksums[file] = digest; release.assets.push({ name: path.basename(file), digest: `sha256:${digest}` });
  }
  const bundle = 'cache/target.noindex/universal-apple-darwin/release/bundle';
  const appFile = write(`${bundle}/macos/Linty.app/Contents/Info.plist`);
  const dmg = write(`${bundle}/dmg/Linty_1.2.3_universal.dmg`, 'same signed installer');
  write(`${bundle}/macos/Linty.app.tar.gz`, 'keep updater archive');
  write('cache/target.noindex/compiled-dependency', 'keep cache');
  write('build-test/release/release-source.bundle', 'keep source');
  write('build-test/release/build.json', JSON.stringify({ version: '1.2.3', checksums, appDigest: appDigest(path.dirname(path.dirname(appFile))) }));
  const installed = write('Applications/Linty.app/Contents/Info.plist', 'installed app');
  return { storage, write, buildDir, release, files, appFile, dmg, installed };
}

test('rebuilding preserves unknown prior bundle contents by renaming without copying', t => {
  const f = publication(t);
  const unknown = f.write('cache/target.noindex/universal-apple-darwin/release/bundle/customer-note.txt', 'keep');
  const inode = lstatSync(unknown).ino;
  const destination = preservePreviousBundle(f.buildDir);
  const retained = path.join(destination, 'customer-note.txt');
  assert.equal(readFileSync(retained, 'utf8'), 'keep');
  assert.equal(lstatSync(retained).ino, inode);
  assert.equal(existsSync(f.dmg), false);
  assert.ok(existsSync(path.join(destination, 'dmg/Linty_1.2.3_universal.dmg')));
  assert.equal(preservePreviousBundle(f.buildDir), undefined);
  assert.ok(existsSync(f.installed));
});

for (const failure of ['redirected-source', 'redirected-destination', 'existing-destination']) {
  test(`prior bundle preservation stops without deleting files on ${failure}`, t => {
    const f = publication(t);
    const bundle = path.dirname(path.dirname(f.dmg));
    if (failure === 'redirected-source') {
      rmSync(bundle, { recursive: true });
      symlinkSync(path.join(f.storage, 'Applications'), bundle);
    } else if (failure === 'redirected-destination') {
      rmSync(path.join(f.buildDir, 'release'), { recursive: true });
      symlinkSync(path.join(f.storage, 'Applications'), path.join(f.buildDir, 'release'));
    } else f.write('build-test/release/previous-bundle.noindex/keep', 'retained');
    assert.throws(() => preservePreviousBundle(f.buildDir), /redirected|already exists/);
    assert.ok(existsSync(f.installed));
    if (failure !== 'redirected-source') assert.ok(existsSync(f.dmg));
    if (failure === 'existing-destination') assert.equal(readFileSync(path.join(f.buildDir, 'release/previous-bundle.noindex/keep'), 'utf8'), 'retained');
  });
}

test('verified publication automatically removes only generated installers and expanded app', t => {
  const f = publication(t); const unregistered = [];
  const removed = cleanupPublishedArtifacts({ ...f, unregister: app => unregistered.push(app) });
  assert.equal(removed.length, 4);
  assert.ok(removed.every(file => !existsSync(file)));
  assert.deepEqual(unregistered, [removed.at(-1)]);
  for (const file of [f.installed, ...f.files.slice(2).map(p => path.join(f.buildDir, p)), path.join(f.buildDir, 'release/build.json'), path.join(f.buildDir, 'release/release-source.bundle'), path.join(f.storage, 'cache/target.noindex/compiled-dependency')]) assert.ok(existsSync(file), file);
});

for (const failure of ['draft', 'wrong-tag', 'remote-hash', 'local-hash', 'cache-hash', 'extra-app-file', 'changed-app-file', 'symlink', 'unregister']) {
  test(`cleanup preserves all files on ${failure} verification failure`, t => {
    const f = publication(t);
    if (failure === 'draft') f.release.draft = true;
    if (failure === 'wrong-tag') f.release.tag_name = 'v9.9.9';
    if (failure === 'remote-hash') f.release.assets[0].digest = 'sha256:wrong';
    if (failure === 'local-hash') writeFileSync(path.join(f.buildDir, f.files[2]), 'changed');
    if (failure === 'cache-hash') writeFileSync(f.dmg, 'newer build');
    if (failure === 'extra-app-file') writeFileSync(path.join(path.dirname(f.appFile), 'customer-note.txt'), 'not generated by this build');
    if (failure === 'changed-app-file') writeFileSync(f.appFile, 'modified');
    if (failure === 'symlink') {
      rmSync(path.dirname(path.dirname(f.appFile)), { recursive: true });
      symlinkSync(path.dirname(path.dirname(f.installed)), path.dirname(path.dirname(f.appFile)));
    }
    assert.throws(() => cleanupPublishedArtifacts({ ...f, unregister: () => { if (failure === 'unregister') throw new Error('unregister failed'); } }));
    assert.ok(existsSync(f.dmg)); assert.ok(existsSync(f.installed));
    assert.ok(f.files.every(file => existsSync(path.join(f.buildDir, file))));
  });
}

test('artifact hashes read large files in bounded chunks and app hashes never follow external links', t => {
  const { storage, write } = fixture(t);
  const bytes = Buffer.alloc(1024 * 1024 + 23, 91);
  const file = write('large-archive', bytes);
  assert.equal(fileDigest(file), createHash('sha256').update(bytes).digest('hex'));
  write('App.app/Contents/generated', 'owned');
  const outside = write('outside/customer.txt', 'keep');
  const app = path.join(storage, 'App.app');
  symlinkSync(path.dirname(outside), path.join(app, 'Contents/linked-folder'));
  const before = appDigest(app);
  writeFileSync(outside, 'still untouched');
  assert.equal(appDigest(app), before, 'linked customer files are neither read nor fingerprinted');
});

test('unexpectedly deep app contents stop verification without deleting files', t => {
  const { storage, write } = fixture(t);
  const file = write(`App.app/${'nested/'.repeat(34)}keep.txt`, 'keep');
  assert.throws(() => appDigest(path.join(storage, 'App.app')), /traversal limits/);
  assert.equal(readFileSync(file, 'utf8'), 'keep');
});

test('artifact verification rejects oversized files, directories and redirected files', t => {
  const { storage, write } = fixture(t);
  const file = write('oversized', '');
  truncateSync(file, 2 * 1024 ** 3 + 1); // Sparse file: no large allocation or disk write.
  assert.throws(() => fileDigest(file), /at most 2 GiB/);
  assert.throws(() => fileDigest(storage), /regular file/);
  const original = write('customer.txt', 'keep');
  const link = path.join(storage, 'redirected'); symlinkSync(original, link);
  assert.throws(() => fileDigest(link));
  assert.equal(readFileSync(original, 'utf8'), 'keep');
});

test('DMG conversion failure preserves the original installer', t => {
  const { write } = fixture(t);
  const dmg = write('installer.dmg', 'original');
  assert.throws(() => prepareMacosDmg(dmg, { run: () => { throw new Error('convert failed'); } }), /convert failed/);
  assert.equal(readFileSync(dmg, 'utf8'), 'original');
});

test('DMG detach failure retains the mounted volume instead of deleting its files', t => {
  const { write } = fixture(t);
  const dmg = write('installer.dmg', 'original'); let mounted;
  assert.throws(() => prepareMacosDmg(dmg, { run: (_tool, args) => {
    if (args[0] === 'attach') { mounted = args.at(-1); writeFileSync(path.join(mounted, 'keep'), 'mounted data'); }
    if (args[0] === 'detach') throw new Error('busy volume');
  } }), /busy volume/);
  assert.equal(readFileSync(path.join(mounted, 'keep'), 'utf8'), 'mounted data');
  assert.equal(readFileSync(dmg, 'utf8'), 'original');
});
