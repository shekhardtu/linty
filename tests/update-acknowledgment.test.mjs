import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileUpdateHistory, releaseHighlights } from '../src/lib/update-acknowledgment.ts';

test('fresh installs establish a baseline; customers from older releases get a neutral welcome', () => {
  assert.deepEqual(reconcileUpdateHistory(null, '0.0.55', false), { lastRunVersion: '0.0.55', notice: null });
  assert.deepEqual(reconcileUpdateHistory(null, '0.0.55', true).notice, { version: '0.0.55', kind: 'whats-new' });
});

test('only a newer running binary creates a success acknowledgment, including skipped versions', () => {
  const saved = { lastRunVersion: '0.0.52', notice: null };
  assert.deepEqual(reconcileUpdateHistory(saved, 'v0.0.55', true).notice, { version: '0.0.55', kind: 'updated' });
  assert.equal(reconcileUpdateHistory(saved, '0.0.52', true).notice, null, 'a failed install still runs the old version');
  assert.equal(reconcileUpdateHistory(saved, '0.0.51', true).notice, null, 'a downgrade must not claim update success');
});

test('a notice survives restarts until acknowledged, then remains dismissed', () => {
  const first = reconcileUpdateHistory({ lastRunVersion: '0.0.52' }, '0.0.55', true);
  assert.deepEqual(reconcileUpdateHistory(first, '0.0.55', true), first);
  const dismissed = { ...first, notice: null };
  assert.deepEqual(reconcileUpdateHistory(dismissed, '0.0.55', true), dismissed);
  assert.equal(reconcileUpdateHistory(first, '0.0.56', true).notice.version, '0.0.56');
});

test('malformed state and stale notices do not produce false success', () => {
  assert.equal(reconcileUpdateHistory({ lastRunVersion: 'dev' }, '0.0.55', true).notice.kind, 'whats-new');
  assert.equal(reconcileUpdateHistory({ lastRunVersion: '0.0.55', notice: { version: '0.0.54', kind: 'updated' } }, '0.0.55', true).notice, null);
  assert.equal(reconcileUpdateHistory({ lastRunVersion: '0.0.55', notice: { version: '0.0.55', kind: 'invalid' } }, '0.0.55', true).notice, null);
  assert.throws(() => reconcileUpdateHistory(null, 'unknown', true));
});

test('release highlights suppress legacy version-only notes and retain text safely', () => {
  assert.deepEqual(releaseHighlights('Linty v0.0.55'), []);
  assert.deepEqual(releaseHighlights(null), []);
  assert.deepEqual(releaseHighlights("## What's new\n\n- Your improvements now appear after restart.\n- <img src=x onerror=alert(1)>"), [
    'Your improvements now appear after restart.', '<img src=x onerror=alert(1)>',
  ]);
});
