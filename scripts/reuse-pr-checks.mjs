import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fullSha = /^[a-f0-9]{40}$/;
const freshChecks = reason => ({ reused: false, reason });

// A PR run's head_sha identifies the branch tip, not the synthetic merge
// commit actually checked out. The successful suite records that commit in
// an artifact, so squash/rebase merges can be compared by their file trees.
export function findReusableChecks({ repository, sha, eventName, api, readCheckedCommit }) {
  if (eventName !== 'push') return freshChecks('Manual runs require fresh checks.');
  try {
    if (!fullSha.test(sha ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
      return freshChecks('Missing release source identity.');
    }
    const repo = `repos/${repository}`;
    const pulls = api(`${repo}/commits/${sha}/pulls?per_page=100`);
    const pull = pulls.find(pr => pr.merged_at && pr.merge_commit_sha === sha &&
      pr.base.ref === 'main' && pr.base.repo.full_name === repository &&
      pr.head.repo?.full_name === repository);
    if (!pull) return freshChecks('No merged repository PR matches this main commit.');

    const { workflow_runs: runs } = api(
      `${repo}/actions/workflows/checks.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=1`,
    );
    const run = runs[0];
    // Use the newest run, including its latest attempt. Never fall back to an
    // older green result when the same PR's newest validation failed.
    if (!run || run.event !== 'pull_request' || run.path !== '.github/workflows/checks.yml' ||
        run.repository.full_name !== repository || run.head_sha !== pull.head.sha ||
        run.status !== 'completed' || run.conclusion !== 'success') {
      return freshChecks('The latest PR check suite has not succeeded.');
    }

    const checkedSha = readCheckedCommit(run).trim();
    if (!fullSha.test(checkedSha)) return freshChecks('Invalid checked-commit record.');
    const checked = api(`${repo}/git/commits/${checkedSha}`);
    const source = api(`${repo}/git/commits/${sha}`);
    if (checked.parents.length !== 2 || checked.parents[1].sha !== pull.head.sha ||
        !fullSha.test(checked.tree.sha) || checked.tree.sha !== source.tree.sha) {
      return freshChecks('The PR did not test this exact source tree.');
    }

    // A rerun may have started while we downloaded the record. Its previous
    // attempt's artifact must not authorize publication for the new attempt.
    const latest = api(`${repo}/actions/runs/${run.id}`);
    if (latest.run_attempt !== run.run_attempt || latest.status !== 'completed' ||
        latest.conclusion !== 'success') {
      return freshChecks('PR validation changed during verification.');
    }
    return {
      reused: true,
      reason: `Reusing PR #${pull.number} checks: ${run.html_url} (tree ${checked.tree.sha}).`,
    };
  } catch {
    // Missing/expired artifacts, deleted merge objects, and API errors only
    // cost a fresh suite; they never permit an unverified release.
    return freshChecks('Previous PR validation could not be verified; running fresh checks.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = findReusableChecks({
    repository,
    sha: process.env.GITHUB_SHA,
    eventName: process.env.GITHUB_EVENT_NAME,
    api: endpoint => JSON.parse(gh(['api', endpoint])),
    readCheckedCommit: run => {
      const directory = mkdtempSync(path.join(tmpdir(), 'linty-checked-source-'));
      try {
        gh(['run', 'download', String(run.id), '--repo', repository,
          '--name', `checked-source-${run.run_attempt}`, '--dir', directory]);
        return readFileSync(path.join(directory, 'checked-commit.txt'), 'utf8');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  });
  console.log(result.reason);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reused=${result.reused}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.reason}\n`);
}
