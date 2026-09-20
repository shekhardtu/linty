import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/publish-release.sh', import.meta.url));
const assets = [
  'src-tauri/target/release/bundle/dmg/linty-0.0.99.dmg',
  'src-tauri/target/release/bundle/dmg/linty.dmg',
  'src-tauri/target/release/bundle/macos/Linty.app.tar.gz',
  'src-tauri/target/release/bundle/macos/Linty.app.tar.gz.sig',
  'latest.json',
];

function publish(config = {}, missing) {
  const root = mkdtempSync(path.join(tmpdir(), 'linty-release-test-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    for (const asset of assets) {
      if (asset === missing) continue;
      const file = path.join(root, asset);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'synthetic release asset');
    }
    const stateFile = path.join(root, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ config, calls: [], attempts: {}, uploaded: [] }));
    writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.RELEASE_TEST_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const command = args[1];
let status = 0;
if (command === 'view') {
  console.log(state.config.published ? 'false' : 'true');
} else if (command === 'upload') {
  const asset = args[3];
  const attempt = state.attempts[asset] = (state.attempts[asset] || 0) + 1;
  if (attempt <= (state.config.failures?.[asset] || 0)) status = 1;
  else state.uploaded.push(asset);
} else if (command === 'edit') {
  state.publishAttempts = (state.publishAttempts || 0) + 1;
  if (state.publishAttempts <= (state.config.publishFailures || 0)) status = 1;
  else state.published = true;
} else status = 2;
fs.writeFileSync(file, JSON.stringify(state));
process.exit(status);
`, { mode: 0o755 });
    const result = spawnSync('bash', [script, 'v0.0.99'], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RELEASE_TEST_STATE: stateFile },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(result.error);
    return { ...result, state: JSON.parse(readFileSync(stateFile, 'utf8')) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('publishes only after every release asset is uploaded in order', () => {
  const { status, state } = publish();
  assert.equal(status, 0);
  assert.deepEqual(state.uploaded, assets);
  assert.equal(state.calls.at(-1)[1], 'edit');
  assert.equal(state.published, true);
});

test('retries the failed asset without reuploading successful assets', () => {
  const { status, state } = publish({ failures: { [assets[2]]: 2 } });
  assert.equal(status, 0);
  assert.deepEqual(state.attempts, Object.fromEntries(assets.map(asset => [asset, asset === assets[2] ? 3 : 1])));
  assert.deepEqual(state.uploaded, assets);
  assert.equal(state.published, true);
});

test('exhausted retries leave the release unpublished', () => {
  const { status, state } = publish({ failures: { [assets[1]]: 3 } });
  assert.notEqual(status, 0);
  assert.equal(state.attempts[assets[1]], 3);
  assert.deepEqual(state.uploaded, [assets[0]]);
  assert.equal(state.calls.some(call => call[1] === 'edit'), false);
});

test('missing updater manifest or bundle fails before any GitHub mutation', () => {
  for (const missing of [assets[2], assets.at(-1)]) {
    const { status, state } = publish({}, missing);
    assert.notEqual(status, 0);
    assert.deepEqual(state.calls, []);
  }
});

test('refuses to replace assets on an already published release', () => {
  const { status, state } = publish({ published: true });
  assert.notEqual(status, 0);
  assert.deepEqual(state.uploaded, []);
  assert.equal(state.calls.some(call => call[1] === 'edit'), false);
});

test('retries final publication without repeating uploads', () => {
  const { status, state } = publish({ publishFailures: 1 });
  assert.equal(status, 0);
  assert.deepEqual(state.uploaded, assets);
  assert.equal(state.publishAttempts, 2);
  assert.equal(state.published, true);
});
