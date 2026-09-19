import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateReleaseNotes(text) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const bullets = lines.filter(line => line.startsWith('- '));
  if (!bullets.length || lines.some(line => !line.startsWith('#') && !line.startsWith('- '))) {
    throw new Error('RELEASE_NOTES.md must contain customer-facing bullet points (one improvement per line).');
  }
  if (bullets.some(line => line.length < 20 || /\b(TODO|TBD|placeholder)\b/i.test(line)
    || /^- (?:Linty )?v?\d+\.\d+\.\d+\s*$/i.test(line))) {
    throw new Error('Replace placeholder release notes with specific improvements customers can understand.');
  }
  return lines.join('\n');
}

export function latestReleaseTag(tags) {
  return tags.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag)).sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number);
    const pb = b.slice(1).split('.').map(Number);
    return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
  })[0];
}

/** Release commits live on tags, so compare against the last release, not main. */
export async function checkReleaseNotes(tags) {
  const notes = validateReleaseNotes(await readFile('RELEASE_NOTES.md', 'utf8'));
  const tag = latestReleaseTag(tags);
  if (tag) {
    const path = execFileSync('git', ['ls-tree', '--name-only', tag, '--', 'RELEASE_NOTES.md'], { encoding: 'utf8' }).trim();
    // Releases before this requirement have no notes file.
    if (path) {
      const previous = execFileSync('git', ['show', `${tag}:RELEASE_NOTES.md`], { encoding: 'utf8' });
      if (notes === validateReleaseNotes(previous)) {
        throw new Error(`Update RELEASE_NOTES.md for this release; it still contains the notes from ${tag}.`);
      }
    }
  }
  return notes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n');
  await checkReleaseNotes(tags);
  console.log('Customer-facing release notes are ready.');
}
