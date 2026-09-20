import test from 'node:test';
import assert from 'node:assert/strict';
import { claimIdleForUpdate, compareVersions, isDictationBusy, isUpdateRequired, isVersion, minimumVersion, waitUntilIdle, withMinimumVersion } from '../src/lib/force-update.util.ts';
import { parseArgs, requestedMinimum } from '../scripts/force-update.mjs';

const manifest = (extra = {}) => ({ version: 'v0.0.40', notes: 'Linty v0.0.40', platforms: { 'darwin-aarch64': { signature: 's', url: 'u' } }, ...extra });

test('versions compare numerically and accept the v prefix latest.json uses', () => {
  assert.equal(compareVersions('0.0.10', '0.0.9'), 1);
  assert.equal(compareVersions('v0.0.40', '0.0.40'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0+build', '1.0.0'), 0);
  assert.equal(isVersion('latest'), false);
  assert.throws(() => compareVersions('latest', '0.0.1'), /Not a version: latest/);
});

test('the minimum comes only from a well-formed minimum_version', () => {
  assert.equal(minimumVersion(manifest({ minimum_version: 'v0.0.38' })), '0.0.38');
  assert.equal(minimumVersion(manifest({ minimum_version: 'soon' })), null);
  assert.equal(minimumVersion(manifest({ minimum_version: 38 })), null);
  assert.equal(minimumVersion(manifest()), null);
  assert.equal(minimumVersion(undefined), null);
});

test('an update is required only below the minimum, and only if the offer meets it', () => {
  assert.equal(isUpdateRequired('0.0.37', '0.0.40', '0.0.38'), true);
  assert.equal(isUpdateRequired('0.0.38', '0.0.40', '0.0.38'), false, 'at the minimum');
  assert.equal(isUpdateRequired('0.0.39', '0.0.40', '0.0.38'), false, 'above the minimum');
  assert.equal(isUpdateRequired('0.0.37', '0.0.40', null), false, 'no minimum');
  assert.equal(isUpdateRequired('0.0.37', '0.0.40', '0.0.41'), false, 'the offer cannot satisfy it');
  assert.equal(isUpdateRequired('dev', '0.0.40', '0.0.38'), false);
});

test('setting the minimum refuses values no release could meet and silent lowering', () => {
  assert.equal(withMinimumVersion(manifest(), 'v0.0.39').minimum_version, '0.0.39');
  assert.deepEqual(withMinimumVersion(manifest({ minimum_version: '0.0.39' }), '0.0.40'), manifest({ minimum_version: '0.0.40' }));
  assert.throws(() => withMinimumVersion(manifest(), '0.0.41'), /above the release 0.0.40/);
  assert.throws(() => withMinimumVersion(manifest(), 'soon'), /Not a version/);
  assert.throws(() => withMinimumVersion(manifest({ minimum_version: '0.0.39' }), '0.0.38'), /needs --allow-lower/);
  assert.equal(withMinimumVersion(manifest({ minimum_version: '0.0.39' }), '0.0.38', { allowLower: true }).minimum_version, '0.0.38');
  assert.throws(() => withMinimumVersion(manifest({ minimum_version: '0.0.39' }), null), /needs --allow-lower/);
  assert.deepEqual(withMinimumVersion(manifest({ minimum_version: '0.0.39' }), null, { allowLower: true }), manifest());
  assert.deepEqual(withMinimumVersion(manifest(), null), manifest(), 'clearing nothing is harmless');
  assert.throws(() => withMinimumVersion({ platforms: {} }, '0.0.1'), /no readable version/);
});

test('the script takes exactly one target', () => {
  assert.deepEqual(parseArgs(['0.0.40', '--dry-run']), { show: false, latest: false, clear: false, allowLower: false, dryRun: true, version: '0.0.40' });
  assert.equal(parseArgs(['--show']).show, true);
  assert.throws(() => parseArgs([]), /exactly one/);
  assert.throws(() => parseArgs(['0.0.40', '--latest']), /exactly one/);
  assert.throws(() => parseArgs(['--show', '--clear']), /no other target/);
  assert.throws(() => parseArgs(['--force']), /unknown argument/);
  assert.equal(requestedMinimum({ latest: true }, manifest()), '0.0.40');
  assert.equal(requestedMinimum({ clear: true }, manifest()), null);
  assert.equal(requestedMinimum({ version: '0.0.39' }, manifest()), '0.0.39');
});

function fakeWorld() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  const listeners = new Set();
  const state = { isRecording: false, status: 'idle' };
  return {
    state,
    timers: {
      set: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
      clear: (id) => timers.delete(id),
    },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    change(patch) { Object.assign(state, patch); for (const l of [...listeners]) l(); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    listenerCount: () => listeners.size,
  };
}

const settled = async (promise) => {
  let done = false;
  promise.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  return done;
};

test('install waits for thirty quiet seconds and restarts the wait when dictation begins', async () => {
  const w = fakeWorld();
  const quiet = waitUntilIdle(() => isDictationBusy(w.state), w.subscribe, 30_000, w.timers);
  w.advance(20_000);
  w.change({ isRecording: true, status: 'recording' });
  w.advance(60_000);
  assert.equal(await settled(quiet), false, 'never installs while recording');
  w.change({ isRecording: false, status: 'transcribing' });
  w.change({ status: 'pasting' });
  w.advance(60_000);
  assert.equal(await settled(quiet), false, 'never installs while the text is being produced');
  w.change({ status: 'done' });
  w.advance(29_000);
  assert.equal(await settled(quiet), false);
  w.advance(1_000);
  assert.equal(await settled(quiet), true);
  assert.equal(w.listenerCount(), 0, 'unsubscribes when finished');
});

test('unrelated store changes do not postpone the install', async () => {
  const w = fakeWorld();
  const quiet = waitUntilIdle(() => isDictationBusy(w.state), w.subscribe, 30_000, w.timers);
  for (let i = 0; i < 29; i += 1) { w.advance(1_000); w.change({ status: 'idle' }); }
  w.advance(1_000);
  assert.equal(await settled(quiet), true);
});

test('busy means recording or producing text', () => {
  for (const status of ['recording', 'transcribing', 'correcting', 'pasting']) assert.equal(isDictationBusy({ isRecording: false, status }), true, status);
  for (const status of ['idle', 'done', 'error']) assert.equal(isDictationBusy({ isRecording: false, status }), false, status);
  assert.equal(isDictationBusy({ isRecording: true, status: 'idle' }), true);
});

test('the default timers resolve (the browser-only invocation error is covered by yarn test:ui)', async () => {
  await waitUntilIdle(() => false, () => () => {}, 1);
});


test('the final install claim waits for dictation started during the release recheck', async () => {
  const w = fakeWorld();
  w.change({ isRecording: true, status: 'recording' });
  let claimed = false;
  const install = claimIdleForUpdate(() => isDictationBusy(w.state), w.subscribe, () => { claimed = true; });
  assert.equal(await settled(install), false);
  w.change({ isRecording: false, status: 'transcribing' });
  assert.equal(await settled(install), false);
  w.change({ status: 'done' });
  await install;
  assert.equal(claimed, true);
  assert.equal(w.listenerCount(), 0);
});
