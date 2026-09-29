import { spawn } from 'node:child_process';
import path from 'node:path';

// Each command owns a process group so cancellation also stops its test servers,
// browsers and build subprocesses. Never include argv: build tools may use secrets.
export function runCommand(command, args, { cwd, env = process.env, signal, stdio = 'inherit' } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, stdio, detached: grouped });
    let cleanup;
    let failedToStart = false;
    const stop = kind => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const abort = () => {
      stop('SIGTERM');
      // Yarn can exit before Playwright finishes closing its separate browser
      // process group. Give the test's SIGTERM handlers time to clean that up.
      cleanup = new Promise(done => setTimeout(() => { stop('SIGKILL'); done(); }, 2000));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => { failedToStart = true; });
    child.on('close', async (code, stoppedBy) => {
      if (cleanup) await cleanup;
      signal?.removeEventListener('abort', abort);
      // Clean up descendants even if the command exited before its children.
      stop('SIGKILL');
      if (signal?.aborted) reject(signal.reason);
      else if (failedToStart || code !== 0) reject(new Error(`${path.basename(command)} failed (${stoppedBy ?? code ?? 'could not start'}).`));
      else resolve();
    });
  });
}

// Do not return until every started task has stopped. The caller can safely
// publish only after this resolves, or release its lock after this rejects.
export async function runTasks(tasks, { concurrency = 2, signal } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.');
  const controller = new AbortController();
  let failure;
  let next = 0;
  const fail = error => {
    failure ??= error;
    controller.abort(error);
  };
  const abort = () => fail(signal.reason);
  const interrupt = () => fail(new Error('Parallel checks interrupted.'));
  if (signal) {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  } else {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (!controller.signal.aborted && next < tasks.length) {
        const task = tasks[next++];
        try { await task(controller.signal); }
        catch (error) { fail(error); }
      }
    }));
    if (controller.signal.aborted) throw failure;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!signal) {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}
