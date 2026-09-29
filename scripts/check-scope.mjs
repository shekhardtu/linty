import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Expensive suites opt in through their inputs. Website/docs are lightweight by
// default; add a watch here when an application build gains a new input location.
const fullWatch = [
  /^\.github\/(?:workflows|actions)\//,
  /^(?:package\.json|yarn\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?)$/,
  /^(?:scripts\/check-scope\.mjs|tests\/check-scope\.test\.mjs)$/,
  /^scripts\/(?:run-tasks|run-ui-checks)\.mjs$/,
  /^scripts\/(?:build-mac|prepare-release|publish-release|release-[^/]+|force-update|generate-icons)\.(?:mjs|sh)$/,
];
const appWatch = [
  /^(?:src|public)\//,
  /^(?:index|capsule)\.html$/,
  /^(?:vite\.config\.[^/]+|tsconfig[^/]*\.json)$/,
  /^tests\/(?:ui\.|previews\/)/,
];
const nativeWatch = [
  /^src-tauri\//,
  /^scripts\/(?:check-rust[^/]*|third-party-notices)\.(?:py|sh)$/,
  /^scripts\/benchmarks\//,
  /^tests\/(?:supervisor\.test|public_corpus_test)\.py$/,
];
const nodeWatch = [/^(?:scripts|tests)\//];
const matches = (file, paths) => paths.some(pattern => pattern.test(file));

export const fullSuiteJobs = ['public-corpus-tests', 'native-checks', 'node-tests', 'ui-tests'];
const selectedJobs = {
  website: ['website-tests'],
  node: ['node-tests'],
  app: ['node-tests', 'ui-tests'],
  native: ['node-tests', 'native-checks', 'public-corpus-tests'],
  full: fullSuiteJobs,
};
const full = reason => ({ scope: 'full', reason });

export function classifyChanges(files) {
  if (!Array.isArray(files) || files.length === 0) return full('No changed files could be classified.');
  let app = false;
  let native = false;
  let node = false;
  for (const file of files) {
    if (typeof file !== 'string' || file.split('/').some(part => ['', '.', '..'].includes(part))) {
      return full('Invalid changed-file path.');
    }
    if (matches(file, fullWatch)) return full('Dependency, release/build tooling, or CI inputs changed.');
    app ||= matches(file, appWatch);
    native ||= matches(file, nativeWatch);
    node ||= matches(file, nodeWatch);
  }
  if (app && native) return full('Both app/UI and native inputs changed.');
  if (native) return { scope: 'native', reason: 'Native inputs changed; run source/security, corpus and Node checks.' };
  if (app) return { scope: 'app', reason: 'App/UI inputs changed; run Node and browser-app checks.' };
  if (node) return { scope: 'node', reason: 'JavaScript/Python tooling or tests changed; run Node checks and app build.' };
  return { scope: 'website', reason: 'No application, native, dependency, or build inputs changed; run lightweight website/docs checks.' };
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
  if (needs?.changes?.result !== 'success' || !Object.hasOwn(selectedJobs, scope ?? '')) return false;
  const expected = Object.fromEntries(['website-tests', ...fullSuiteJobs].map(job =>
    [job, selectedJobs[scope].includes(job) ? 'success' : 'skipped']));
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
