import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1471';
const url = `http://127.0.0.1:${port}`;
const output = `artifacts/usability-${engine.name()}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page;
const errors = [];
const accessibility = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview timeout')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
  });
  await mkdir(output, { recursive: true });
  browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1080, height: 760 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixture, {});
  await page.goto(url);
  const nav = async name => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  const choose = async (name, value) => {
    await page.getByRole('combobox', { name, exact: true }).click();
    await page.getByRole('listbox', { name, exact: true }).getByRole('option', { name: value, exact: true }).click();
  };
  await page.locator('.overview-transcripts [data-transcript-id]').first().waitFor();
  await page.getByRole('group', { name: 'Usage period' }).getByRole('button', { name: '30 days', exact: true }).click();
  await nav('Apps');
  await choose('Sort applications', 'Sessions');
  await page.getByRole('group', { name: 'Usage period' }).getByRole('button', { name: 'All time', exact: true }).click();
  await nav('Dictionary');
  assert.equal(await page.locator('.dictionary-page .stat-grid').count(), 0, 'Dictionary starts with its useful content');
  await page.getByLabel('Correct spelling', { exact: true }).fill('DraftBeforeNavigation');
  await page.getByLabel('Heard as', { exact: false }).fill('draft before navigation');
  await nav('Overview');
  assert.equal(await page.getByRole('button', { name: '30 days', exact: true }).getAttribute('aria-pressed'), 'true');
  await nav('Apps');
  assert.equal(await page.getByRole('combobox', { name: 'Sort applications' }).innerText(), 'Sessions');
  assert.equal(await page.getByRole('button', { name: 'All time', exact: true }).getAttribute('aria-pressed'), 'true');
  await nav('Dictionary');
  assert.equal(await page.getByLabel('Correct spelling', { exact: true }).inputValue(), 'DraftBeforeNavigation');
  assert.equal(await page.getByLabel('Heard as', { exact: false }).inputValue(), 'draft before navigation');
  assert.equal(await page.evaluate(() => JSON.stringify(window.__QA__.stores).includes('DraftBeforeNavigation')), false, 'Unfinished entries are not persisted');
  await page.evaluate(() => { window.__QA__.failures['plugin:store|save'] = 'Synthetic save failure'; });
  await page.getByRole('button', { name: 'Add to dictionary', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not save the word' }).waitFor();
  await nav('Apps'); await nav('Dictionary');
  assert.equal(await page.getByLabel('Correct spelling', { exact: true }).inputValue(), 'DraftBeforeNavigation', 'Failed saves retain the draft');
  await page.evaluate(() => { delete window.__QA__.failures['plugin:store|save']; });
  await page.getByRole('button', { name: 'Add to dictionary', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '“DraftBeforeNavigation” added' }).waitFor();
  assert.equal(await page.getByLabel('Correct spelling', { exact: true }).inputValue(), '');
  await nav('Apps'); await nav('Dictionary');
  assert.equal(await page.getByLabel('Heard as', { exact: false }).inputValue(), '', 'Successful save clears both fields');
  // A completed write from the previous page must not wipe a newer form.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, ...args) => {
      if (command === 'plugin:store|save' && !window.__saveHeld) {
        window.__saveHeld = true;
        await new Promise(resolve => { window.__releaseSave = resolve; });
      }
      return invoke(command, ...args);
    };
  });
  await page.getByLabel('Correct spelling', { exact: true }).fill('SlowSaveWord');
  await page.getByRole('button', { name: 'Add to dictionary', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseSave);
  await nav('Apps'); await nav('Dictionary');
  await page.getByLabel('Correct spelling', { exact: true }).fill('NewerUnfinishedWord');
  await page.evaluate(() => window.__releaseSave());
  await page.getByRole('status').filter({ hasText: '“SlowSaveWord” added' }).waitFor();
  assert.equal(await page.getByLabel('Correct spelling', { exact: true }).inputValue(), 'NewerUnfinishedWord');
  await page.screenshot({ path: `${output}/dictionary.png` });

  await nav('Overview');
  const info = page.getByRole('button', { name: 'How time saved is estimated', exact: true });
  const bounds = await info.boundingBox();
  await info.hover();
  const tip = page.getByRole('tooltip').filter({ hasText: 'Compared with typing' });
  await tip.waitFor();
  assert.deepEqual(await info.boundingBox(), bounds, 'Tooltips do not shift their action');
  assert.equal(await info.getAttribute('title'), null, 'No competing native tooltip');
  assert.equal(await info.getAttribute('aria-describedby'), await tip.getAttribute('id'));
  await tip.hover();
  await page.waitForTimeout(250);
  assert.equal(await tip.isVisible(), true, 'Pointer can move onto the help without losing it');
  await page.keyboard.press('Escape');
  assert.equal(await tip.count(), 0);
  assert.equal(await info.getAttribute('aria-describedby'), null);
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await info.focus();
  await tip.waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await info.evaluate(el => el === document.activeElement), true);
  await info.click();
  const dialog = page.getByRole('dialog', { name: 'How this is estimated' });
  await dialog.waitFor();
  await page.keyboard.press('Tab');
  const close = dialog.getByRole('button', { name: 'Close estimate details' });
  await close.focus();
  const modalTip = page.getByRole('tooltip', { name: 'Close estimate details' });
  await modalTip.waitFor();
  assert.equal(await modalTip.evaluate(el => !!el.closest('dialog[open]')), true, 'Modal help belongs to the modal accessibility tree');
  const tipBox = await modalTip.boundingBox();
  assert.ok(tipBox.x >= 0 && tipBox.y >= 0 && tipBox.x + tipBox.width <= 1080 && tipBox.y + tipBox.height <= 760);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true, 'First Escape dismisses the focused tooltip');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await nav('Dictionary');
  assert.equal(await page.locator('.action-tooltip').count(), 0, 'Navigation removes stale help');

  for (const theme of ['light', 'dark']) {
    await nav('Settings');
    await nav('Appearance');
    await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
    for (const name of ['Overview', 'History', 'Apps', 'Dictionary', 'Shortcuts', 'System Check', 'Settings', 'About']) {
      await nav(name);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme, `${name}: the requested theme persists during the contrast audit`);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      accessibility.push(...result.violations.map(v => ({ theme, page: name, id: v.id, targets: v.nodes.map(n => n.target), details: v.nodes.map(n => n.failureSummary) })));
    }
  }
  // A 540 x 380 CSS viewport represents a 1080 x 760 window at 200% page zoom.
  // Hide the optional sidebar to give the enlarged content the full window.
  await page.setViewportSize({ width: 540, height: 380 });
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  for (const view of ['dashboard','history','apps','dictionary','shortcuts','system-check','about']) {
    await page.evaluate(async view => {
      const { useAppStore } = await import('/src/store/app.store.ts');
      useAppStore.getState().setCurrentView(view);
    }, view);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const overflow = await page.locator('.page-scroll,.history-page').evaluateAll(elements => elements.some(el => el.scrollWidth > el.clientWidth + 1));
    assert.equal(overflow, false, `${view}: page reflows at 200% equivalent zoom`);
    if (view === 'dictionary') await page.screenshot({ path: `${output}/dictionary-zoom.png` });
  }
  for (const section of ['general','audio','language','appearance','privacy']) {
    await page.evaluate(async section => {
      const { useAppStore } = await import('/src/store/app.store.ts');
      useAppStore.getState().setSettingsSection(section);
    }, section);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.preferences-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, `${section}: enlarged settings remain reachable`);
  }
  await writeFile(`${output}/accessibility.json`, JSON.stringify(accessibility, null, 2));
  const capsule = await context.newPage();
  await capsule.addInitScript(fixture, {});
  await capsule.goto(`${url}/capsule.html`);
  await capsule.waitForFunction(() => window.__QA__.calls.includes('plugin:event|listen'));
  const announcement = capsule.getByRole('status');
  await capsule.evaluate(() => window.__QA__.emit('capsule-state', { state: 'recording' }));
  await capsule.locator('.capsule-recording').waitFor();
  assert.equal(await announcement.textContent(), 'Listening. Release your trigger to finish.');
  await capsule.waitForTimeout(1100);
  assert.equal(await announcement.textContent(), 'Listening. Release your trigger to finish.', 'Elapsed time does not repeatedly interrupt a screen reader');
  await capsule.evaluate(() => {
    window.__QA__.emit('capsule-state', { state: 'transcribing' });
    window.__QA__.emit('capsule-partial-text', 'A sentence still being transcribed');
    window.__QA__.emit('capsule-stt-progress', 42);
  });
  await capsule.locator('.capsule-transcribing').waitFor();
  assert.equal(await announcement.textContent(), 'Processing dictation');
  assert.equal((await announcement.textContent()).includes('42'), false, 'Progress events do not interrupt the processing announcement');
  assert.equal((await announcement.textContent()).includes('sentence'), false);
  await capsule.evaluate(() => window.__QA__.emit('capsule-state', { state: 'error', error: 'Microphone unavailable' }));
  await capsule.locator('.capsule-error').waitFor();
  assert.equal(await announcement.textContent(), 'Microphone unavailable');
  await capsule.close();
  assert.deepEqual(accessibility, []);
  assert.deepEqual(errors, []);
  console.log('Usability checks passed: session state, unsaved dictionary text, failed/slow saves, tooltip hover/focus/Escape/modal behavior, increased contrast in both themes, 200% equivalent viewport reflow, and recording announcements.');
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
