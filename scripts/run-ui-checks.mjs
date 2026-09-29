import { pathToFileURL } from 'node:url';
import { runCommand, runTasks } from './run-tasks.mjs';

// Start the two longest suites first. CI and local releases use the same list.
export const uiSuites = ['ui', 'onboarding', 'security', 'audio-history', 'correction-feedback', 'updates', 'privacy', 'microphone'];

export async function runUiChecks({ run = runCommand, cwd = process.cwd(), env = process.env, signal } = {}) {
  const started = performance.now();
  await runTasks(uiSuites.map((suite, index) => async taskSignal => {
    const start = performance.now();
    console.log(`Starting WebKit ${suite}...`);
    await run('yarn', [`test:${suite}`], {
      cwd, env: { ...env, UI_BROWSER: 'webkit', UI_PORT: String(15200 + index) }, signal: taskSignal,
    });
    console.log(`WebKit ${suite} passed in ${((performance.now() - start) / 1000).toFixed(1)}s.`);
  }), { concurrency: 2, signal });
  console.log(`All ${uiSuites.length} WebKit suites passed in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runUiChecks(); }
  catch (error) {
    console.error(`browser checks: ${error.message}`);
    process.exitCode = 1;
  }
}
