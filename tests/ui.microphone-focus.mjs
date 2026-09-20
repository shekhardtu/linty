import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1477';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
const output = `artifacts/microphone-focus/${engine.name()}`;
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
  });
  await mkdir(output, { recursive: true });
  browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1080, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixture, { theme: 'dark' });
  await page.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    Object.assign(window.__QA__, { generation: 0, hasAudio: true, phrase: 'My first microphone test.', focused: true });
    document.hasFocus = () => window.__QA__.focused;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const qa = window.__QA__;
      if (command === 'start_dictation') {
        qa.calls.push(command);
        if (qa.startError) throw new Error(qa.startError);
        return ++qa.generation;
      }
      if (command === 'stop_dictation') return { sample_count: qa.hasAudio ? 32000 : 0, duration_secs: 2, recording_generation: qa.generation };
      if (command === 'dictation_result') {
        if (qa.delayResult) await new Promise(resolve => { qa.finishResult = resolve; });
        if (qa.emptyResult) return { record: null, warnings: [], recognized: [], corrected: [] };
        const record = { transcriptId: `focus-${args.generation}`, finalText: qa.phrase, rawText: qa.phrase, timestamp: Date.now(), durationSeconds: 2, processingTimeMs: 100, wordCount: 5, engine: 'local', modelName: 'Fixture', corrected: false, deliveryStatus: 'skipped' };
        await original('history_save', { record });
        return { record, warnings: [], recognized: [], corrected: [] };
      }
      return original(command, args);
    };
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  await page.clock.install();
  const store = await page.evaluateHandle(async () => (await import('/src/store/app.store.ts')).useAppStore);
  const status = expected => page.waitForFunction(({ store, expected }) => store.getState().status === expected, { store, expected });
  const setQA = values => page.evaluate(values => Object.assign(window.__QA__, values), values);
  const navigate = view => store.evaluate((s, view) => s.getState().setCurrentView(view), view);
  const audit = async name => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], name);
  };
  const waveWidth = async root => {
    const section = await root.boundingBox();
    const wave = await root.locator('.microphone-test-waveform').boundingBox();
    const bars = root.locator('.waveform-bar');
    const first = await bars.first().boundingBox(), last = await bars.last().boundingBox();
    assert.ok(wave.width / section.width >= .7, 'Waveform covers at least 70% of the component');
    assert.ok((last.x + last.width - first.x) / wave.width > .98, 'The bars fill the waveform, not just its container');
  };
  const feedWave = () => page.evaluate(() => {
    for (let i = 0; i < 100; i++) window.__QA__.emit('audio-amplitude', [.001, .004, .02, .07, .12, .03, .007, 0][i % 8]);
  });
  const widget = page.locator('.microphone-test');
  const transcripts = widget.locator('.microphone-test-transcript > p:first-of-type');
  const start = () => widget.getByRole('button', { name: /^Start microphone test:/ }).click();
  const stop = () => widget.getByRole('button', { name: /^Stop microphone test:/ }).click();

  await navigate('system-check');
  await widget.waitFor();
  await audit('Idle microphone test');
  await widget.screenshot({ path: `${output}/test-idle-dark.png` });
  await start(); await status('recording'); await feedWave();
  await waveWidth(widget);
  await widget.screenshot({ path: `${output}/test-recording-dark.png` });
  await stop(); await status('done');
  await page.clock.runFor(15_000);
  assert.equal(await transcripts.first().innerText(), 'My first microphone test.', 'Results survive all shared reset timers');
  // Repeating the same phrase is still a distinct test. Keep only the newest three.
  for (const phrase of ['My first microphone test.', 'Third recording.', 'Fourth recording.']) {
    await setQA({ phrase }); await start(); await status('recording');
    assert.ok(await transcripts.count() > 0, 'Previous results remain visible while recording');
    await stop(); await status('done');
  }
  assert.deepEqual(await transcripts.allTextContents(), ['Fourth recording.', 'Third recording.', 'My first microphone test.']);
  await widget.getByRole('button', { name: 'Copy latest test transcript', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__QA__.clipboard), 'Fourth recording.');
  await page.evaluate(() => { window.__QA__.failures['plugin:clipboard-manager|write_text'] = 'Clipboard unavailable'; });
  await widget.getByRole('button', { name: 'Copy latest test transcript', exact: true }).click();
  await widget.getByRole('alert').getByText('Couldn’t copy. Try again, or select the text to copy it.').waitFor();
  assert.equal(await transcripts.count(), 3, 'A clipboard error never removes a transcript');
  await page.evaluate(() => { delete window.__QA__.failures['plugin:clipboard-manager|write_text']; });
  await setQA({ hasAudio: false }); await start(); await status('recording'); await stop(); await status('idle');
  assert.equal(await transcripts.count(), 3, 'An empty recording preserves previous results');
  await widget.getByText('No transcript this time', { exact: true }).waitFor();
  await setQA({ hasAudio: true, startError: 'Microphone is unavailable. Check your input.' });
  await start(); await status('error'); await page.clock.runFor(8000);
  assert.equal(await transcripts.count(), 3);
  await widget.getByText('Microphone is unavailable. Check your input.', { exact: true }).waitFor();
  await setQA({ startError: null });
  const longText = 'Here is a longer recording to review without losing any words.\n' + 'The whole transcript stays readable and selectable. '.repeat(12);
  await setQA({ phrase: longText }); await start(); await status('recording'); await stop(); await status('done');
  assert.equal(await transcripts.first().textContent(), longText);
  for (const theme of ['dark', 'light']) {
    await store.evaluate((s, theme) => s.getState().setTheme(theme), theme);
    await widget.screenshot({ path: `${output}/test-history-${theme}.png` });
    await audit(`Transcript history ${theme}`);
  }
  await navigate('dashboard'); await navigate('system-check');
  assert.equal(await transcripts.count(), 0, 'Leaving clears the local test results');

  const focus = page.getByRole('dialog', { name: 'Focused dictation', exact: true });
  const press = () => page.evaluate(() => window.__QA__.emit('fnkey-pressed'));
  const release = () => page.evaluate(() => window.__QA__.emit('fnkey-released'));
  const recordInFocus = async () => {
    await press(); await page.clock.runFor(250); await status('recording'); await focus.waitFor();
  };
  for (const view of ['dashboard', 'history', 'apps', 'dictionary', 'shortcuts', 'system-check', 'settings', 'about']) {
    await navigate(view);
    await setQA({ phrase: `Recording from ${view}.` });
    await recordInFocus();
    assert.equal(await store.evaluate(s => s.getState().currentView), view, 'The original page stays mounted');
    const bounds = await focus.boundingBox();
    assert.equal(bounds.width, 1080); assert.equal(bounds.height, 900);
    await waveWidth(focus.locator('.microphone-test'));
    await release(); await status('done');
    if (view === 'dashboard') await focus.screenshot({ path: `${output}/focus-countdown.png` });
    await page.clock.runFor(9000);
    assert.equal(await focus.count(), 1, 'The view stays for the full ten seconds');
    assert.match(await focus.locator('.microphone-test-transcript').innerText(), new RegExp(`Recording from ${view}`));
    await page.clock.runFor(1100);
    assert.equal(await focus.count(), 0, 'Returns automatically after ten seconds');
    assert.equal(await store.evaluate(s => s.getState().currentView), view);
  }

  // Preserve unsaved input, search and focus on the originating screen.
  await navigate('history');
  const search = page.getByRole('searchbox', { name: 'Search transcripts or apps' });
  await search.fill('first');
  await recordInFocus(); await release(); await status('done');
  await focus.getByRole('button', { name: 'Stay here', exact: true }).click();
  await page.clock.runFor(20_000);
  assert.equal(await focus.count(), 1, 'Stay here cancels automatic return');
  assert.equal(await focus.locator('.microphone-test-transcript').count(), 1);
  await audit('Focused completion');
  for (const theme of ['dark', 'light']) {
    await store.evaluate((s, theme) => s.getState().setTheme(theme), theme);
    await focus.screenshot({ path: `${output}/focus-complete-${theme}.png` });
  }
  await page.keyboard.press('Escape');
  assert.equal(await focus.count(), 0);
  assert.equal(await search.inputValue(), 'first');
  assert.equal(await search.evaluate(el => document.activeElement === el), true, 'Restores keyboard focus');

  // Processing does not use up reading time, and a new recording cancels an old countdown.
  await setQA({ delayResult: true });
  await recordInFocus(); await release();
  await page.clock.runFor(15_000);
  assert.equal(await focus.count(), 1);
  assert.equal(await focus.locator('.recording-focus-countdown').count(), 0);
  await page.evaluate(() => window.__QA__.finishResult()); await status('done');
  await page.clock.runFor(8000);
  await setQA({ delayResult: false });
  await recordInFocus(); await page.clock.runFor(12_000);
  assert.equal(await focus.count(), 1, 'An old countdown never interrupts a new recording');
  await feedWave();
  for (const theme of ['dark', 'light']) {
    await store.evaluate((s, theme) => s.getState().setTheme(theme), theme);
    await focus.screenshot({ path: `${output}/focus-recording-${theme}.png` });
  }
  await page.setViewportSize({ width: 640, height: 760 });
  await waveWidth(focus.locator('.microphone-test'));
  assert.equal(await focus.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await focus.screenshot({ path: `${output}/focus-narrow.png` });
  await audit('Narrow focused recording');
  await release(); await status('done');
  await focus.getByRole('button', { name: 'Back now', exact: true }).click();
  assert.equal(await focus.count(), 0);
  await setQA({ hasAudio: false });
  await recordInFocus(); await release(); await status('idle');
  await focus.getByText('No transcript this time', { exact: true }).waitFor();
  await page.clock.runFor(10_100);
  assert.equal(await focus.count(), 0, 'Empty recordings also return to the original screen');
  await setQA({ hasAudio: true, startError: 'Microphone unavailable.' });
  await press(); await page.clock.runFor(250); await status('error'); await release();
  await focus.getByText('Microphone unavailable.', { exact: true }).waitFor();
  await page.clock.runFor(10_100);
  assert.equal(await focus.count(), 0, 'A failed start does not strand the focused screen');
  await setQA({ startError: null });
  // Dictation from another app keeps using the external capsule.
  await setQA({ focused: false }); await press(); await page.clock.runFor(250); await status('recording');
  assert.equal(await focus.count(), 0);
  await release(); await status('done');
  assert.deepEqual(errors, []);
  console.log(`Microphone and focus checks passed in ${engine.name()}: full-width waveform, persistent last three results, identical phrases, copy, empty/error feedback, eight origin screens, ten-second return, stay/back, processing and repeat timing, focus/search restoration, responsive layout and accessibility.`);
} finally {
  await browser?.close(); server.kill('SIGTERM');
}
