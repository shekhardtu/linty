import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findReusableChecks } from '../scripts/reuse-pr-checks.mjs';

const repository = 'owner/linty';
const sha = 'a'.repeat(40);
const head = 'b'.repeat(40);
const checkedSha = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const repo = `repos/${repository}`;
const pullsEndpoint = `${repo}/commits/${sha}/pulls?per_page=100`;
const runsEndpoint = `${repo}/actions/workflows/checks.yml/runs?event=pull_request&head_sha=${head}&per_page=1`;

function fixture() {
  const pull = {
    number: 85, merged_at: '2026-09-20T07:39:42Z', merge_commit_sha: sha,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: head, repo: { full_name: repository } },
  };
  const run = {
    id: 123, run_attempt: 1, event: 'pull_request', path: '.github/workflows/checks.yml',
    repository: { full_name: repository }, head_sha: head,
    status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/linty/actions/runs/123',
  };
  const responses = {
    [pullsEndpoint]: [pull],
    [runsEndpoint]: { workflow_runs: [run] },
    [`${repo}/git/commits/${checkedSha}`]: { tree: { sha: tree }, parents: [{ sha: 'e'.repeat(40) }, { sha: head }] },
    [`${repo}/git/commits/${sha}`]: { tree: { sha: tree } },
    [`${repo}/actions/runs/123`]: { ...run },
  };
  const calls = [];
  const input = {
    repository, sha, eventName: 'push',
    api: endpoint => {
      calls.push(endpoint);
      assert.ok(Object.hasOwn(responses, endpoint), `Unexpected API request: ${endpoint}`);
      return responses[endpoint];
    },
    readCheckedCommit: selected => {
      assert.equal(selected.id, run.id);
      assert.equal(selected.run_attempt, run.run_attempt);
      return `${checkedSha}\n`;
    },
  };
  return { input, responses, pull, run, calls };
}

test('reuses the complete successful suite when the tested merge and release trees match', () => {
  const { input, run } = fixture();
  const result = findReusableChecks(input);
  assert.equal(result.reused, true);
  assert.ok(result.reason.includes(run.html_url));
  assert.ok(result.reason.includes(tree));
  // The squash commit and tested merge commit deliberately have different SHAs.
  assert.notEqual(sha, checkedSha);
});

test('manual validation runs always run fresh checks without querying GitHub', () => {
  const { input, calls } = fixture();
  input.eventName = 'workflow_dispatch';
  assert.equal(findReusableChecks(input).reused, false);
  assert.deepEqual(calls, []);
});

test('missing source identity never reuses checks', () => {
  for (const field of ['sha', 'repository']) {
    const { input, calls } = fixture();
    input[field] = undefined;
    assert.equal(findReusableChecks(input).reused, false);
    assert.deepEqual(calls, []);
  }
});

test('direct pushes and PRs other than the exact merged main PR need fresh checks', () => {
  for (const alter of [
    ({ responses }) => { responses[pullsEndpoint] = []; },
    ({ pull }) => { pull.merged_at = null; },
    ({ pull }) => { pull.merge_commit_sha = 'f'.repeat(40); },
    ({ pull }) => { pull.base.ref = 'release'; },
    ({ pull }) => { pull.head.repo = null; },
    ({ pull }) => { pull.head.repo.full_name = 'fork/linty'; },
  ]) {
    const state = fixture();
    alter(state);
    assert.equal(findReusableChecks(state.input).reused, false);
    assert.equal(state.calls.length, 1);
  }
});

test('only the newest successful run from the expected workflow, repo, event and head is reusable', () => {
  for (const changes of [
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    { status: 'in_progress', conclusion: null }, { status: 'queued', conclusion: null },
    { path: '.github/workflows/other.yml' }, { event: 'workflow_dispatch' },
    { repository: { full_name: 'fork/linty' } }, { head_sha: 'f'.repeat(40) },
  ]) {
    const { input, run } = fixture();
    Object.assign(run, changes);
    input.readCheckedCommit = () => assert.fail('Must not download evidence from an ineligible run');
    assert.equal(findReusableChecks(input).reused, false);
  }
});

test('missing runs and an older success behind a newer failure cannot skip checks', () => {
  const { input, responses, run } = fixture();
  responses[runsEndpoint].workflow_runs = [];
  assert.equal(findReusableChecks(input).reused, false);
  responses[runsEndpoint].workflow_runs = [{ ...run, conclusion: 'failure' }, run];
  assert.equal(findReusableChecks(input).reused, false);
});

test('changed merged source, including a base branch update, requires fresh checks', () => {
  const { input, responses } = fixture();
  responses[`${repo}/git/commits/${sha}`].tree.sha = 'f'.repeat(40);
  assert.equal(findReusableChecks(input).reused, false);
});

test('the recorded commit must be a merge of the final PR head', () => {
  for (const parents of [[{ sha: head }], [{ sha: head }, { sha: 'f'.repeat(40) }]]) {
    const { input, responses } = fixture();
    responses[`${repo}/git/commits/${checkedSha}`].parents = parents;
    assert.equal(findReusableChecks(input).reused, false);
  }
});

test('missing, expired, or invalid evidence cannot skip checks', () => {
  for (const record of ['', '../bad', `${checkedSha}\n${head}`, 'success']) {
    const { input } = fixture();
    input.readCheckedCommit = () => record;
    assert.equal(findReusableChecks(input).reused, false);
  }
  const { input } = fixture();
  input.readCheckedCommit = () => { throw new Error('Artifact not found'); };
  assert.equal(findReusableChecks(input).reused, false);
});

test('API errors at every verification stage fall back to running the suite', () => {
  for (const failAt of Object.keys(fixture().responses)) {
    const { input } = fixture();
    const originalApi = input.api;
    input.api = endpoint => {
      if (endpoint === failAt) throw new Error('API unavailable');
      return originalApi(endpoint);
    };
    assert.equal(findReusableChecks(input).reused, false);
  }
});

test('reruns must finish successfully and use evidence from the same attempt', () => {
  for (const changes of [
    { run_attempt: 2 }, { status: 'in_progress', conclusion: null }, { conclusion: 'failure' },
  ]) {
    const { input, responses } = fixture();
    Object.assign(responses[`${repo}/actions/runs/123`], changes);
    assert.equal(findReusableChecks(input).reused, false);
  }
  const { input, run, responses } = fixture();
  run.run_attempt = 2;
  responses[`${repo}/actions/runs/123`].run_attempt = 2;
  assert.equal(findReusableChecks(input).reused, true);
});

test('publication accepts verified reuse but blocks other skips, failures, cancellations and build-only runs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/build-dmg.yml', import.meta.url), 'utf8');
  const publishJob = workflow.split('\n  publish-release:\n')[1];
  const expression = publishJob.match(/if: >-\s*\$\{\{([\s\S]*?)\}\}/)[1];
  const evaluate = new Function('needs', 'inputs', 'cancelled',
    `return (${expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]')});`);
  const allowed = ({ checked = 'success', checks = 'skipped', build = 'success', reused = 'true',
    buildOnly = false, cancelled = false } = {}) => {
    const needs = {
      'checked-source': { result: checked, outputs: { reused } },
      checks: { result: checks }, 'build-macos': { result: build },
    };
    // GitHub implicitly requires successful dependencies unless the expression
    // includes a status function. That matters when reuse skips the suite.
    if (!/\b(?:always|cancelled|success|failure)\(/.test(expression) &&
        Object.values(needs).some(job => job.result !== 'success')) return false;
    return evaluate(needs, { build_only: buildOnly }, () => cancelled);
  };
  assert.equal(allowed(), true);
  assert.equal(allowed({ checks: 'success', reused: 'false' }), true);
  for (const reused of ['false', '']) assert.equal(allowed({ reused }), false);
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.equal(allowed({ checked: result }), false);
    assert.equal(allowed({ build: result }), false);
    if (result !== 'skipped') assert.equal(allowed({ checks: result }), false);
  }
  assert.equal(allowed({ buildOnly: true }), false);
  assert.equal(allowed({ cancelled: true }), false);
});
