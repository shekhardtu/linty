import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { validateReleaseNotes, latestReleaseTag } from '../scripts/release-notes.mjs';

const notes = "## What's new\n\n- See a confirmation after Linty updates and restarts.\n";
test('notes must explain improvements, not contain placeholders or a version', async () => {
  for (const invalid of ['', '# Changes', '- TODO: add release notes', 'Linty v0.0.55', '- v0.0.55', '- TBD']) {
    assert.throws(() => validateReleaseNotes(invalid));
  }
  assert.match(validateReleaseNotes(notes), /confirmation/);
  validateReleaseNotes(await readFile('RELEASE_NOTES.md', 'utf8'));
  assert.equal(latestReleaseTag(['v0.0.9', 'v0.0.55', 'v0.0.55-beta', 'test']), 'v0.0.55');
});

test('release gate rejects stale notes and accepts updated customer-facing notes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linty-notes-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  const check = () => spawnSync(process.execPath, [resolve('scripts/release-notes.mjs')], { cwd: directory, encoding: 'utf8' });
  try {
    git('init', '-q');
    await writeFile(join(directory, 'RELEASE_NOTES.md'), notes);
    assert.equal(check().status, 0, 'first release');
    git('add', '.');
    git('-c', 'user.name=Release Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'release');
    git('tag', 'v0.0.55');
    assert.notEqual(check().status, 0);
    assert.match(check().stderr, /still contains the notes from v0.0.55/);
    await writeFile(join(directory, 'RELEASE_NOTES.md'), notes.replaceAll('\n', '\r\n') + '\n');
    assert.notEqual(check().status, 0, 'whitespace is not a new improvement');
    await writeFile(join(directory, 'RELEASE_NOTES.md'), notes + '- Review the improvements from About at any time.\n');
    assert.equal(check().status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
