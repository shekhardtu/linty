import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1478';
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
  });
  browser = await engine.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixture, {});
  await page.goto(url);
  await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  const store = await page.evaluateHandle(async () => (await import('/src/store/app.store.ts')).useAppStore);
  await store.evaluate(s => { s.getState().setObserveCorrections(true); s.getState().setAutoLearnWords(true); });
  const observe = (to, app = 'Notes', from = 'YOLO', wordCount = 7) => page.evaluate(({ to, app, from, wordCount }) => {
    window.__QA__.emit('correction-observed', { batchId: crypto.randomUUID(), corrections: [{
      transcriptId: 'qa-0', pasted: 'I have to go to YOLO.', wordCount,
      application: { name: app, bundleId: `test.${app}` },
      pairs: [{ kind: 'substitution', from, to }], secondsAfterPaste: 4,
    }] });
  }, { to, app, from, wordCount });
  const feedbackCount = () => page.evaluate(() => window.__QA__.correctionFeedback.length);
  const waitForCount = count => page.waitForFunction(count => window.__QA__.correctionFeedback.length === count, count);
  await observe('YULU');
  await waitForCount(1);
  assert.deepEqual(await page.evaluate(() => {
    const { actions, ...feedback } = window.__QA__.correctionFeedback[0];
    return feedback;
  }), {
    title: 'Correction learned', message: 'I’ll remember it next time.', learned: true,
  });
  const applied = await page.evaluate(async () => {
    const { applyDictionary } = await import('/src/lib/dictionary.util.ts');
    return applyDictionary('I have to go to YOLO.', window.__QA__.stores[4].entries).text;
  });
  assert.equal(applied, 'I have to go to YULU.', 'The acknowledgment follows a saved replacement usable by the next dictation');
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.some(e => e.right === 'Tauri')), false, 'Unrelated ready suggestions are not learned along with this fix');
  await observe('Acme', 'Slack', 'Acne'); await waitForCount(2);
  await observe('Tauri', 'Safari', 'Tari'); await waitForCount(3);
  await observe('YULU');
  await page.waitForTimeout(200);
  assert.equal(await feedbackCount(), 3, 'An already known replacement has no duplicate acknowledgment');
  await observe('Rewritten', 'Notes', 'all of these words changed', 3);
  await page.waitForTimeout(200);
  assert.equal(await feedbackCount(), 3, 'Rewrites do not claim learning');
  await store.evaluate(s => s.getState().setAutoLearnWords(false));
  await observe('NewName', 'Notes', 'NewNane');
  await observe('receive', 'Notes', 'recieve');
  await page.waitForFunction(() => window.__QA__.stores[4].suggestions.some(s => s.right === 'receive'));
  await observe('receive', 'Notes', 'recieve');
  await page.waitForFunction(() => window.__QA__.stores[4].suggestions.some(s => s.right === 'receive' && s.seenCount === 2));
  assert.equal(await feedbackCount(), 3, 'Suggestions stay silent; only saved learning gets an automatic pill');
  await store.evaluate(s => { s.getState().setAutoLearnWords(true); s.getState().setDictionaryEnabled(false); });
  await observe('AnotherName', 'Notes', 'AnotherNane'); await waitForCount(4);
  assert.match(await page.evaluate(() => window.__QA__.correctionFeedback.at(-1).message), /Turn on Dictionary/);
  await page.evaluate(() => { window.__QA__.failures['plugin:store|save'] = 'Synthetic save failure'; });
  const writesBeforeFailure = await page.evaluate(() => window.__QA__.calls.filter(c => c === 'plugin:store|set').length);
  await observe('Unsaved', 'Notes', 'Unsavd');
  await page.waitForFunction(n => window.__QA__.calls.filter(c => c === 'plugin:store|set').length >= n + 4, writesBeforeFailure);
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.some(e => e.right === 'Unsaved')), false, 'A failed save restores the plugin cache before shutdown can persist it');
  assert.equal(await feedbackCount(), 4, 'A failed dictionary save never claims the word was learned');
  await store.evaluate(s => s.getState().setObserveCorrections(false));
  await observe('Disabled');
  await page.waitForTimeout(100);
  assert.equal(await feedbackCount(), 4, 'Turning observation off rejects late watch events');
  await page.evaluate(() => { delete window.__QA__.failures['plugin:store|save']; });
  await store.evaluate(s => { s.getState().setObserveCorrections(true); s.getState().setDictionaryEnabled(true); });
  await observe('Harishekhar', 'Zed', 'Hari Shekhar', 5); await waitForCount(5);
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.find(e => e.right === 'Harishekhar')?.wrong.includes('Hari Shekhar')), true);
  assert.equal(await page.evaluate(() => window.__QA__.correctionFeedback.at(-1).title), 'Correction learned', 'Joining the name from the reported sentence receives the learned pill');

  const savesBeforeBatch = await page.evaluate(() => window.__QA__.calls.filter(c => c === "plugin:store|save").length);
  // One native batch can carry several final word corrections. Undo must remove
  // only that batch, even when a later unrelated word has been learned.
  await page.evaluate(() => window.__QA__.emit('correction-observed', { batchId: 'multi-dictation-session', corrections: [{
    transcriptId: 'qa-0', pasted: 'Meet Anya at Figma with our team today', wordCount: 9,
    application: { name: 'Notes' }, secondsAfterPaste: 15,
    pairs: [{ kind: 'substitution', from: 'Jolo', to: 'yolo' }],
  }, { transcriptId: 'qa-1', wordCount: 8, application: { name: 'Notes' }, secondsAfterPaste: 5,
    pairs: [{ kind: 'substitution', from: 'Figna', to: 'Figma' }],
  }] }));
  await waitForCount(6);
  assert.equal(await page.evaluate(() => window.__QA__.calls.filter(c => c === "plugin:store|save").length), savesBeforeBatch + 1, 'All dictations in the session share one dictionary save');
  await page.evaluate(() => window.__QA__.emit('correction-observed', { batchId: 'multi-dictation-session', corrections: [] }));
  await page.waitForTimeout(100);
  assert.equal(await feedbackCount(), 6, 'A repeated native session cannot acknowledge twice');
  const undo = await page.evaluate(() => window.__QA__.correctionFeedback.at(-1).actions.find(a => a.action === 'undo'));
  assert.equal(await page.evaluate(() => window.__QA__.correctionFeedback.at(-1).title), '2 corrections learned');
  await observe('LaterWord', 'Notes', 'LaterWrd'); await waitForCount(7);
  await page.evaluate(action => window.__QA__.emit('correction-feedback-action', action), undo);
  await waitForCount(8);
  assert.equal(await page.evaluate(() => window.__QA__.correctionFeedback.at(-1).title), 'Learning undone');
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.some(e => ['yolo', 'Figma'].includes(e.right))), false);
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.some(e => e.right === 'LaterWord')), true);

  await page.evaluate(() => window.__QA__.emit('correction-capture-unavailable', 'qa-0'));
  await page.waitForTimeout(250);
  assert.equal(await feedbackCount(), 8, 'Unreadable fields never prompt to add a word or claim a correction');
  await store.evaluate(s => { s.getState().setCurrentView('history'); s.getState().setSelectedTranscriptId('qa-0'); });
  assert.equal(await page.getByRole('button', { name: 'Remember a correction', exact: true }).count(), 0);

  // A failed native pill must not create a second notification path. The
  // dictionary still retains the correction that was successfully persisted.
  const toastsBefore = await store.evaluate(s => s.getState().toasts.length);
  await page.evaluate(() => { window.__QA__.failures.show_correction_feedback = 'Synthetic panel failure'; });
  await observe('SavedWithoutPill', 'Notes', 'SavedWithoutPil');
  await page.waitForFunction(() => window.__QA__.stores[4].entries.some(e => e.right === 'SavedWithoutPill'));
  await page.waitForTimeout(200);
  assert.equal(await feedbackCount(), 8, 'A failed panel does not report a visible acknowledgment');
  assert.equal(await store.evaluate(s => s.getState().toasts.length), toastsBefore, 'A failed panel has no fallback toast');
  await page.evaluate(() => { delete window.__QA__.failures.show_correction_feedback; });

  // A verified pre-submit spelling correction reaches History and the saved
  // acknowledgment together; navigation text is excluded by the native session.
  await observe('canto', 'Google Chrome', 'Kanto', 9);
  await waitForCount(9);
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.some(e => e.right === 'canto' && e.wrong.includes('Kanto'))), true);
  assert.equal(await page.evaluate(() => window.__QA__.correctionFeedback.at(-1).title), 'Correction learned');
  const recorded = await page.evaluate(() => window.__QA__.stores[3].corrections.filter(c => c.pairs.some(p => p.to === 'canto')));
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].pairs, [{ kind: 'substitution', from: 'Kanto', to: 'canto' }]);

  await mkdir('artifacts/correction-feedback', { recursive: true });
  for (const theme of ['light', 'dark']) for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width: 380, height: 52 }, reducedMotion });
    const pill = await context.newPage();
    pill.on('pageerror', error => errors.push(error.message));
    await pill.addInitScript(fixture, { theme });
    await pill.goto(`${url}/capsule.html`);
    await pill.waitForFunction(() => window.__QA__.calls.includes('plugin:event|listen'));
    await pill.clock.install();
    const send = payload => pill.evaluate(payload => window.__QA__.emit('capsule-state', payload), payload);
    const notify = () => pill.evaluate(() => window.__QA__.emit('correction-feedback', {
      title: 'Correction learned', message: 'I’ll remember it next time.', learned: true,
    }));
    await notify();
    await pill.locator('.capsule-feedback').waitFor();
    await pill.clock.runFor(200);
    await pill.locator('.capsule-pill').evaluate(el => Promise.allSettled(el.getAnimations({ subtree: true })
      .filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished)));
    assert.equal(await pill.getByRole('status').innerText(), 'Correction learned. I’ll remember it next time.');
    assert.equal(await pill.evaluate(() => window.__QA__.calls.includes('show_capsule')), true);
    assert.deepEqual((await new AxeBuilder({ page: pill }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations, []);
    const fits = await pill.locator('.capsule-feedback-message').evaluate(el => {
      const outer = el.closest('.capsule-pill').getBoundingClientRect();
      const inner = el.getBoundingClientRect();
      return inner.top >= outer.top && inner.bottom <= outer.bottom && el.scrollWidth <= el.clientWidth;
    });
    assert.equal(fits, true, 'Both lines fit in the existing pill');
    await pill.screenshot({ path: `artifacts/correction-feedback/${engine.name()}-${theme}-${reducedMotion}.png` });
    await send({ state: 'idle' }); await pill.clock.runFor(200);
    assert.equal(await pill.locator('.capsule-feedback').count(), 1, 'Late dictation cleanup leaves the acknowledgment visible');
    await send({ state: 'recording', generation: 2 });
    await pill.locator('.capsule-recording').waitFor();
    await pill.clock.runFor(6000);
    assert.equal(await pill.locator('.capsule-recording').count(), 1, 'The old feedback timer cannot hide a new recording');
    await send({ state: 'done' }); await pill.clock.runFor(1400);
    assert.equal(await pill.locator('.capsule-pill').count(), 0, 'An acknowledgment that was already shown never resumes after dictation');
    await notify();
    await pill.locator('.capsule-feedback').waitFor();
    await pill.clock.runFor(2000);
    assert.equal(await pill.locator('.capsule-feedback').count(), 1, 'The brief acknowledgment gives time to read');
    await pill.clock.runFor(1300);
    assert.equal(await pill.locator('.capsule-pill').count(), 0, 'Feedback dismisses after three seconds plus its exit animation');
    await send({ state: 'transcribing' });
    await notify();
    assert.equal(await pill.locator('.capsule-feedback').count(), 0, 'Feedback waits for processing to finish');
    await send({ state: 'done' }); await pill.clock.runFor(1400);
    await pill.locator('.capsule-feedback').waitFor();
    await pill.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await pill.clock.runFor(200);
    assert.equal(await pill.locator('.capsule-pill').count(), 0, 'The acknowledgment can be dismissed');
    await pill.evaluate(() => window.__QA__.emit('correction-feedback', {
      title: '2 corrections learned', message: 'I’ll remember it next time.', learned: true,
      actions: [{ label: 'Review in Dictionary', action: 'review' }, { label: 'Undo learning', action: 'undo', id: 'batch-1' }],
    }));
    await pill.locator('.capsule-feedback').waitFor();
    await pill.clock.runFor(400);
    await pill.locator('.capsule-pill').evaluate(el => Promise.allSettled(el.getAnimations({ subtree: true })
      .filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished)));
    await pill.screenshot({ path: `artifacts/correction-feedback/${engine.name()}-${theme}-${reducedMotion}-actions.png` });
    assert.deepEqual((await new AxeBuilder({ page: pill }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations, []);
    await pill.getByRole('button', { name: 'Undo learning' }).hover();
    await pill.clock.runFor(5000);
    assert.equal(await pill.locator('.capsule-feedback').count(), 1, 'Hover pauses dismissal so the actions remain usable');
    await pill.getByRole('button', { name: 'Undo learning' }).focus();
    await pill.mouse.move(0, 0);
    await pill.clock.runFor(5000);
    assert.equal(await pill.locator('.capsule-feedback').count(), 1, 'Keyboard focus also pauses dismissal after the pointer leaves');
    await pill.getByRole('button', { name: 'Undo learning' }).click();
    assert.equal(await pill.evaluate(() => window.__QA__.emittedEvents.at(-1).payload.id), 'batch-1');
    await pill.clock.runFor(200);
    assert.equal(await pill.locator('.capsule-pill').count(), 0);
    await pill.mouse.move(0, 0);
    await pill.evaluate(() => window.__QA__.emit('correction-feedback', {
      title: 'Correction learned', message: 'I’ll remember it next time.', learned: true,
      actions: [{ label: 'Undo learning', action: 'undo', id: 'brief-batch' }],
    }));
    await pill.locator('.capsule-feedback').waitFor();
    await pill.clock.runFor(1800);
    await pill.getByRole('button', { name: 'Undo learning' }).hover();
    await pill.clock.runFor(4000);
    await pill.mouse.move(0, 0);
    await pill.clock.runFor(1500);
    assert.equal(await pill.locator('.capsule-pill').count(), 0, 'Actionable feedback resumes only its remaining time, not a new full timer');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Correction feedback checks passed in ${engine.name()}: saved learning, simulated app events, failure handling, queueing, brief dismissal, no replay, hover/focus pauses, themes, reduced motion and accessibility.`);
} finally { await browser?.close(); server.kill(); }
