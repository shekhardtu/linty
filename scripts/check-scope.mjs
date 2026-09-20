import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const websiteSupport = new Set([
  'scripts/capture-website.mjs',
  'scripts/website-preview.html',
  'scripts/website-preview-data.mjs',
  'scripts/update-download-count.mjs',
  'tests/website-demo.test.mjs',
  'tests/website-platform.test.mjs',
  'tests/website-product.test.mjs',
  'tests/website-download-count.test.mjs',
]);
export const fullSuiteJobs = ['public-corpus-tests', 'rust-logging', 'node-tests', 'native-tests', 'ui-tests'];
const full = reason => ({ scope: 'full', reason });

export function classifyChanges(files) {
  if (!Array.isArray(files) || files.length === 0) return full('No changed files could be classified.');
  let website = false;
  for (const file of files) {
    if (typeof file !== 'string' || file.split('/').some(part => ['', '.', '..'].includes(part))) {
      return full('Invalid changed-file path.');
    }
    // Every PR updates release notes. Notes alone still affect the desktop app.
    if (file === 'RELEASE_NOTES.md') continue;
    if (!file.startsWith('website/') && !websiteSupport.has(file)) {
      return full('Application, shared tooling, or other files changed.');
    }
    website = true;
  }
  return website ? { scope: 'website', reason: 'Only the website and its capture/test files changed.' }
    : full('Release notes changed without website changes.');
}

export function changedFiles({ base, head, cwd }) {
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) throw new Error('Missing commit identity.');
  // Diff the actual tested merge against its base. No API pagination/path limit;
  // disabling rename detection keeps an application's old path in the decision.
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
}

export function checkScope({ eventName, forceFull = false, readFiles }) {
  if (forceFull || eventName !== 'pull_request') return full('Release and non-PR runs require the full suite.');
  try { return classifyChanges(readFiles()); }
  catch { return full('Changed files could not be verified; running the full suite.'); }
}

export function requiredChecksPassed(needs) {
  const scope = needs?.changes?.outputs?.scope;
  if (needs?.changes?.result !== 'success' || !['full', 'website'].includes(scope)) return false;
  const expected = Object.fromEntries(fullSuiteJobs.map(job => [job, scope === 'full' ? 'success' : 'skipped']));
  expected['website-tests'] = scope === 'website' ? 'success' : 'skipped';
  return Object.entries(expected).every(([job, result]) => needs[job]?.result === result)
    && Object.keys(needs).every(job => job === 'changes' || Object.hasOwn(expected, job));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--verify-results')) {
    if (!requiredChecksPassed(JSON.parse(process.env.RESULTS ?? '{}'))) {
      throw new Error('Required checks did not complete successfully for the selected scope.');
    }
    console.log('Every required check for this scope passed.');
  } else {
    const result = checkScope({
      eventName: process.env.GITHUB_EVENT_NAME,
      forceFull: process.env.FORCE_FULL === 'true',
      readFiles: () => changedFiles({ base: process.env.BASE_SHA, head: process.env.GITHUB_SHA }),
    });
    console.log(`${result.scope}: ${result.reason}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${result.scope}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.scope}: ${result.reason}\n`);
  }
}
