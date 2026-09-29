import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

export function fileDigest(file, buffer = Buffer.allocUnsafe(64 * 1024)) {
  const hash = createHash('sha256');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error('Artifact must be a regular file of at most 2 GiB.');
    let remaining = stat.size;
    while (remaining > 0) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!length) throw new Error('Artifact changed during verification.');
      hash.update(buffer.subarray(0, length));
      remaining -= length;
    }
    if (readSync(fd, buffer, 0, 1, null)) throw new Error('Artifact changed during verification.');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

// Fingerprint only this generated app; do not follow symlinks or scan the disk.
// Extra/changed files make cleanup fail closed instead of deleting unknown data.
export function appDigest(app) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let entries = 0;
  let bytes = 0;
  const visit = (relative, depth = 0) => {
    if (++entries > 10000 || depth > 32) throw new Error('Generated app exceeds cleanup traversal limits.');
    const file = path.join(app, relative);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) hash.update(JSON.stringify([relative, 'link', readlinkSync(file)]));
    else if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, 'directory']));
      const directory = opendirSync(file);
      const names = [];
      try {
        let entry;
        while ((entry = directory.readSync())) {
          if (names.length + entries >= 10000) throw new Error('Generated app exceeds cleanup traversal limits.');
          names.push(entry.name);
        }
      } finally { directory.closeSync(); }
      for (const name of names.sort()) visit(path.join(relative, name), depth + 1);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 1024 * 1024 * 1024) throw new Error('Generated app exceeds the 1 GiB cleanup verification limit.');
      hash.update(JSON.stringify([relative, 'file', fileDigest(file, buffer)]));
    }
    else throw new Error('Unexpected file type in generated app; refusing cleanup.');
  };
  visit('');
  return hash.digest('hex');
}

export function releaseTargetDirectory(storage) {
  storage = realpathSync(storage);
  const cache = path.join(storage, 'cache');
  const previous = path.join(cache, 'target');
  const target = path.join(cache, 'target.noindex');
  for (const directory of [cache, target]) {
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Refusing a redirected release cache.');
  }
  mkdirSync(cache, { recursive: true });
  // The release lock is already held. Preserve the existing compilation cache.
  if (existsSync(previous) && !existsSync(target)) {
    if (lstatSync(previous).isSymbolicLink()) throw new Error('Unexpected target cache symlink.');
    renameSync(previous, target);
  }
  mkdirSync(target, { recursive: true });
  if (existsSync(previous)) {
    if (!lstatSync(previous).isSymbolicLink() || realpathSync(previous) !== realpathSync(target)) throw new Error('Both old and excluded target caches exist; preserve and reconcile them before releasing.');
  } else {
    // Cargo build-script metadata retains absolute paths. Keep those paths
    // valid while all real files and new output live in the excluded directory.
    symlinkSync('target.noindex', previous, 'dir');
  }
  return target;
}

export function cleanupPublishedArtifacts({ buildDir, release, unregister = () => {} }) {
  buildDir = realpathSync(buildDir);
  const record = JSON.parse(readFileSync(path.join(buildDir, 'release/build.json'), 'utf8'));
  const { version, checksums } = record;
  if (!/^\d+\.\d+\.\d+$/.test(version) || release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false) {
    throw new Error('Cleanup requires this exact, published release.');
  }
  const staged = path.join(buildDir, 'src-tauri/target/release/bundle');
  const bundle = path.join(path.dirname(buildDir), 'cache/target.noindex/universal-apple-darwin/release/bundle');
  const files = [
    [`dmg/linty-${version}.dmg`, `src-tauri/target/release/bundle/dmg/linty-${version}.dmg`],
    ['dmg/linty.dmg', 'src-tauri/target/release/bundle/dmg/linty.dmg'],
    ['macos/Linty.app.tar.gz', 'src-tauri/target/release/bundle/macos/Linty.app.tar.gz'],
    ['macos/Linty.app.tar.gz.sig', 'src-tauri/target/release/bundle/macos/Linty.app.tar.gz.sig'],
  ];
  const assertOwned = file => {
    if (lstatSync(file).isSymbolicLink() || realpathSync(file) !== path.resolve(file)) throw new Error('Refusing cleanup through a symlink.');
  };
  // Validate every uploaded artifact before deleting any local installer.
  for (const [relative, key] of [...files, ['latest.json', 'latest.json']]) {
    const file = key === 'latest.json' ? path.join(buildDir, key) : path.join(staged, relative);
    assertOwned(file);
    const expected = checksums[key];
    const asset = release.assets?.find(item => item.name === path.basename(file));
    if (!expected || asset?.digest !== `sha256:${expected}` || fileDigest(file) !== expected) throw new Error(`Published artifact verification failed: ${path.basename(file)}`);
  }
  const cachedDmg = path.join(bundle, 'dmg', `Linty_${version}_universal.dmg`);
  assertOwned(cachedDmg);
  if (fileDigest(cachedDmg) !== checksums[files[0][1]]) throw new Error('Cached installer differs from the published artifact.');
  const app = path.join(bundle, 'macos/Linty.app');
  assertOwned(app);
  if (!record.appDigest || appDigest(app) !== record.appDigest) throw new Error('Generated app contains unverified or changed files; refusing cleanup.');
  unregister(app);
  const removed = [path.join(staged, files[0][0]), path.join(staged, files[1][0]), cachedDmg, app];
  for (const file of removed) rmSync(file, { recursive: file === app });
  return removed;
}
