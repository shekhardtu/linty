import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { runCommand, runTasks } from '../scripts/run-tasks.mjs';

test('the pool overlaps tasks, respects its bound and runs every task once', async () => {
  let active = 0;
  let maximum = 0;
  const seen = [];
  await runTasks(Array.from({ length: 8 }, (_, index) => async () => {
    seen.push(index);
    maximum = Math.max(maximum, ++active);
    await setImmediate();
    active--;
  }));
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('failure cancels running work, skips queued work and awaits cleanup before rejecting', async () => {
  const fail = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const original = new Error('first failure');
  const listeners = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
  let finished = false;
  const result = runTasks([
    () => fail.promise,
    async signal => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise;
      await cleanup.promise;
      throw new Error('secondary cancellation');
    },
    () => assert.fail('must not start queued work'),
  ]).finally(() => { finished = true; });
  const rejected = assert.rejects(result, error => error === original);
  fail.reject(original);
  await aborted.promise;
  assert.equal(finished, false);
  cleanup.resolve();
  await rejected;
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), listeners);
});

test('pre-aborted pools do not start any commands and invalid limits fail', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before start'));
  await assert.rejects(runTasks([() => assert.fail('must not start')], { signal: controller.signal }), /cancelled before start/);
  for (const concurrency of [0, -1, 1.5]) await assert.rejects(runTasks([], { concurrency }), /positive integer/);
});

test('command completion checks exit codes and errors never expose arguments', async () => {
  await runCommand(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)', 'sensitive-argument'], { stdio: 'ignore' }), error => {
    assert.match(error.message, /exit|7/);
    assert.doesNotMatch(error.message, /sensitive-argument/);
    return true;
  });
  await assert.rejects(runCommand('/nonexistent/linty-command', ['sensitive-argument'], { stdio: 'ignore' }), error => {
    assert.doesNotMatch(error.message, /sensitive-argument/);
    return true;
  });
});

test('cancellation kills a stubborn command and its subprocess before returning', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'linty-process-test-'));
  const ready = path.join(directory, 'ready.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const task = runCommand(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {stdio:'ignore'});
    writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `, ready], { stdio: 'ignore', signal: controller.signal });
  const rejected = assert.rejects(task, /cancel test/);
  for (let i = 0; i < 100 && !existsSync(ready); i++) await setTimeout(20);
  assert.ok(existsSync(ready), 'command must start before cancellation');
  const pids = JSON.parse(readFileSync(ready, 'utf8'));
  controller.abort(new Error('cancel test'));
  await rejected;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  for (let i = 0; i < 100 && pids.some(alive); i++) await setTimeout(20);
  assert.ok(pids.every(pid => !alive(pid)), 'no command or subprocess left running');
});
