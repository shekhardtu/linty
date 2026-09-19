import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkReleaseNotes } from './release-notes.mjs';

// A release gets its own version commit/tag; CI never pushes around main's
// required checks. Include existing tags so retries cannot reuse a version.
export function nextVersion(current, tags) {
  const versions = [current, ...tags].filter(v => /^v?\d+\.\d+\.\d+$/.test(v))
    .map(v => v.replace(/^v/, '').split('.').map(Number));
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error('Invalid package version');
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const [major, minor, patch] = versions[0];
  return `${major}.${minor}.${patch + 1}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n');
  await checkReleaseNotes(tags);
  const version = nextVersion(pkg.version, tags);
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
