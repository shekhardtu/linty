import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedFiles, checkScope, classifyChanges, fullSuiteJobs, requiredChecksPassed } from '../scripts/check-scope.mjs';

test('website and documentation changes use lightweight checks without an exclusion list', () => {
  for (const files of [
    ['website/index.html'],
    ['website/images/language-dark.png', 'website/styles.css', 'RELEASE_NOTES.md'],
    ['README.md', 'PRIVACY.md', 'TERMS.md', 'RELEASE_NOTES.md'],
    ['docs/runbooks/local-releases.md', 'docs/reviews/screenshot.png'],
    ['docs/new-guide.md', 'AGENTS.md', '.github/ISSUE_TEMPLATE/bug_report.yml'],
    ['a-new-document.md'],
  ]) assert.equal(classifyChanges(files).scope, 'website');
});

test('src, public assets, app entry points, and browser tests watch app checks without macOS jobs', () => {
  for (const file of ['src/App.tsx', 'src/content/legal.json', 'src/new-feature/file.ts',
    'public/icon.png', 'index.html', 'capsule.html', 'vite.config.ts', 'tsconfig.json',
    'tests/ui.smoke.mjs', 'tests/previews/pill-motion-preview.html']) {
    assert.equal(classifyChanges(['website/index.html', 'README.md', file]).scope, 'app', file);
  }
});

test('src-tauri and native validation inputs watch native checks without browser-app jobs', () => {
  for (const file of ['src-tauri/src/lib.rs', 'src-tauri/swift/Package.swift',
    'src-tauri/tauri.conf.json', 'src-tauri/Cargo.lock', 'src-tauri/new-feature.rs',
    'scripts/check-rust-logging.sh', 'scripts/check-rust-advisories.py',
    'scripts/third-party-notices.py', 'scripts/benchmarks/public_corpus.py',
    'tests/supervisor.test.py', 'tests/public_corpus_test.py']) {
    assert.equal(classifyChanges(['website/index.html', file]).scope, 'native', file);
    assert.equal(classifyChanges(['src/App.tsx', file]).scope, 'full', file);
    assert.equal(classifyChanges([file, 'src/App.tsx']).scope, 'full', file);
  }
});

test('tooling and unit tests run Node checks without native or browser-app builds', () => {
  for (const file of ['scripts/update-download-count.mjs', 'scripts/legal-docs.mjs',
    'scripts/capture-website.mjs', 'scripts/website-preview-data.mjs',
    'tests/privacy.test.mjs', 'tests/website-download-count.test.mjs', 'tests/usage.test.mjs']) {
    assert.equal(classifyChanges([file, 'website/index.html']).scope, 'node', file);
  }
});

test('dependencies, release/build tooling, and CI inputs always watch the full suite', () => {
  for (const file of ['package.json', 'yarn.lock', 'package-lock.json',
    '.github/workflows/checks.yml', '.github/actions/swift-bridge/action.yml',
    'scripts/check-scope.mjs', 'tests/check-scope.test.mjs', 'scripts/build-mac.sh',
    'scripts/prepare-release.mjs', 'scripts/prepare-macos-dmg.mjs', 'scripts/release-artifacts.mjs', 'scripts/publish-release.sh', 'scripts/release-local.mjs',
    'scripts/generate-icons.mjs', 'scripts/run-tasks.mjs', 'scripts/run-ui-checks.mjs']) {
    assert.equal(classifyChanges(['website/index.html', file]).scope, 'full', file);
  }
});

test('unknown or malformed file lists fail closed', () => {
  for (const files of [undefined, [], 'website/index.html', [null], [''],
    ['website/../src/App.tsx'], ['website//index.html'], ['/website/index.html']]) {
    assert.equal(classifyChanges(files).scope, 'full');
  }
});

test('classification examines every file even after hundreds of website assets', () => {
  const files = Array.from({ length: 500 }, (_, i) => `website/images/${i}.png`);
  assert.equal(classifyChanges(files).scope, 'website');
  files.push('src/App.tsx');
  assert.equal(classifyChanges(files).scope, 'app');
  files.push('src-tauri/src/lib.rs');
  assert.equal(classifyChanges(files).scope, 'full');
});

test('release calls and non-PR events always use full validation', () => {
  const readFiles = () => assert.fail('Must not classify a release run');
  for (const eventName of ['push', 'workflow_dispatch', 'workflow_call', undefined]) {
    assert.equal(checkScope({ eventName, readFiles }).scope, 'full');
  }
  assert.equal(checkScope({ eventName: 'pull_request', forceFull: true, readFiles }).scope, 'full');
});

test('PR detection selects website checks and falls back to full when the diff is unavailable', () => {
  assert.equal(checkScope({ eventName: 'pull_request', readFiles: () => ['website/main.js'] }).scope, 'website');
  assert.equal(checkScope({ eventName: 'pull_request', readFiles: () => { throw new Error('Missing base'); } }).scope, 'full');
  assert.throws(() => changedFiles({ base: '', head: 'a'.repeat(40) }), /Missing commit identity/);
});

test('git diff includes deleted app paths in renames and preserves unusual website filenames', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'linty-check-scope-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'Scope test');
  git('config', 'user.email', 'scope@example.invalid');
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'website'));
  writeFileSync(join(cwd, 'src/app.js'), 'export const app = true;\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const unusual = 'website/space and\nnewline-語.js';
  writeFileSync(join(cwd, unusual), 'export {};\n');
  git('add', '.');
  git('commit', '-m', 'website');
  assert.deepEqual(changedFiles({ base, head: git('rev-parse', 'HEAD'), cwd }), [unusual]);
  renameSync(join(cwd, 'src/app.js'), join(cwd, 'website/app.js'));
  git('add', '-A');
  git('commit', '-m', 'move application into website');
  const files = changedFiles({ base, head: git('rev-parse', 'HEAD'), cwd });
  assert.ok(files.includes('src/app.js'));
  assert.ok(files.includes('website/app.js'));
  assert.equal(classifyChanges(files).scope, 'app');
});

function results(scope) {
  const expectedJobs = {
    website: ['website-tests'],
    node: ['node-tests'],
    app: ['node-tests', 'ui-tests'],
    native: ['node-tests', 'native-checks', 'public-corpus-tests'],
    full: fullSuiteJobs,
  };
  return {
    changes: { result: 'success', outputs: { scope } },
    ...Object.fromEntries(['website-tests', ...fullSuiteJobs].map(job =>
      [job, { result: expectedJobs[scope]?.includes(job) ? 'success' : 'skipped' }])),
  };
}

test('required gate accepts a successful selected suite with only intentional skips', () => {
  for (const scope of ['full', 'website', 'node', 'app', 'native']) assert.equal(requiredChecksPassed(results(scope)), true);
});

test('required gate rejects failures, cancellation, unexpected skips, and missing jobs', () => {
  for (const scope of ['full', 'website', 'node', 'app', 'native']) {
    for (const job of Object.keys(results(scope))) {
      for (const result of ['success', 'skipped', 'failure', 'cancelled', undefined]) {
        const needs = results(scope);
        if (result === needs[job].result) continue;
        needs[job].result = result;
        assert.equal(requiredChecksPassed(needs), false, `${scope}: ${job} ${result}`);
      }
      const needs = results(scope);
      delete needs[job];
      assert.equal(requiredChecksPassed(needs), false);
    }
  }
});

test('required gate rejects unrecognized scope and dependencies', () => {
  assert.equal(requiredChecksPassed(undefined), false);
  for (const scope of ['', 'unknown', undefined]) assert.equal(requiredChecksPassed(results(scope)), false);
  assert.equal(requiredChecksPassed({ ...results('website'), unexpected: { result: 'success' } }), false);
});

test('only full PR validation records and uploads reusable release evidence', () => {
  const workflow = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  const gate = workflow.split('\n  required-checks:\n')[1];
  for (const name of ['Record the commit that passed all checks', 'Save checked source for release validation']) {
    const step = gate.split(`- name: ${name}\n`)[1].split('\n      - ')[0];
    const expression = step.match(/if: (.+)/)[1];
    const evaluate = new Function('github', 'needs', `return (${expression});`);
    for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
      for (const scope of ['full', 'website', 'node', 'app', 'native', undefined]) {
        assert.equal(evaluate({ event_name: event }, results(scope)), event === 'pull_request' && scope === 'full');
      }
    }
  }
});

test('workflow job selection matches the required gate for all watched scopes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  for (const scope of ['website', 'node', 'app', 'native', 'full']) {
    for (const job of ['website-tests', ...fullSuiteJobs]) {
      const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
      const expression = block.match(/\n    if: (.+)/)[1];
      const selected = new Function('needs', `return (${expression});`)(results(scope));
      assert.equal(selected, results(scope)[job].result === 'success', `${scope}: ${job}`);
    }
  }
});
