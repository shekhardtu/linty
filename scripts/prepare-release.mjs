import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkReleaseNotes, validateReleaseNotes } from './release-notes.mjs';

// A release gets its own version commit/tag; CI never pushes around main's
// required checks. Include existing tags so retries cannot reuse a version.
export function nextVersion(current, tags, bump = 'patch') {
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error('Version bump must be patch, minor, or major');
  const versions = [current, ...tags].filter(v => /^v?\d+\.\d+\.\d+$/.test(v))
    .map(v => v.replace(/^v/, '').split('.').map(Number));
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error('Invalid package version');
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const [major, minor, patch] = versions[0];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function initialVersion(current, tags) {
  if (current !== '0.0.1' || tags.some(tag => /^v?\d+\.\d+\.\d+$/.test(tag))) {
    throw new Error('An initial release requires source version 0.0.1 and no existing version tags.');
  }
  return current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n');
  if (process.argv.includes('--build-only')) {
    // A timing/validation build does not publish. It can rebuild the current
    // notes, while ordinary releases still require new customer-facing notes.
    validateReleaseNotes(await readFile('RELEASE_NOTES.md', 'utf8'));
  } else {
    await checkReleaseNotes(tags);
  }
  const bumpIndex = process.argv.indexOf('--bump');
  if (bumpIndex !== -1 && !process.argv[bumpIndex + 1]) throw new Error('--bump requires patch, minor, or major');
  const initial = process.argv.includes('--initial-release');
  if (initial && bumpIndex !== -1) throw new Error('--initial-release cannot be combined with --bump');
  const version = initial ? initialVersion(pkg.version, tags)
    : nextVersion(pkg.version, tags, bumpIndex === -1 ? 'patch' : process.argv[bumpIndex + 1]);
  if (initial) {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
      const text = await readFile(file, 'utf8');
      if (!text.includes('name = "linty"\nversion = "0.0.1"')) throw new Error(`Initial version mismatch in ${file}`);
    }
    if (config.version !== version) throw new Error('Initial version mismatch in tauri.conf.json');
    console.log(version);
    process.exit(0);
  }
  for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.version = version;
    await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  }
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const text = await readFile(file, 'utf8');
    const updated = text.replace(/(\[\[?package\]?\]\nname = "linty"\nversion = ")[^"]+/, `$1${version}`);
    if (text === updated) throw new Error(`Could not update the Linty version in ${file}`);
    await writeFile(file, updated);
  }
  console.log(version);
}
