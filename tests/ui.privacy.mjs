import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const port = process.env.UI_PORT ?? '1497';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Privacy preview did not start')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
  });
  const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch();
  const external = [];
  async function setup({ onboarding = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
    await context.addInitScript(fixture, { onboarding });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(`http://127.0.0.1:${port}/`)) return route.continue();
      external.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('heading', { name: onboarding ? 'Welcome to Linty' : 'Your dictation', exact: true }).waitFor();
    return { context, page };
  }
  const { context, page } = await setup();
  const navigate = name => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  await navigate('About');
  const link = page.getByRole('button', { name: 'Privacy notice', exact: true });
  await link.click();
  const dialog = page.getByRole('dialog', { name: 'Privacy notice', exact: true });
  await dialog.waitFor();
  for (const heading of ['On your Mac', 'Storage and your choices', 'Website and GitHub', 'About this notice']) {
    assert.equal(await dialog.getByRole('heading', { name: heading, exact: true }).count(), 1);
  }
  assert.match(await dialog.textContent(), /Available offline/);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await link.evaluate(element => element === document.activeElement), true, 'Escape restores focus');
  await page.getByRole('button', { name: 'License & terms', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Recording and content', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

  const creditsButton = page.getByRole('button', { name: 'Credits and licenses', exact: true });
  await creditsButton.click();
  const credits = page.getByRole('dialog', { name: 'Credits and licenses', exact: true });
  await credits.waitFor();
  for (const name of ['Whisper by OpenAI', 'Parakeet by NVIDIA', 'FluidAudio by FluidInference', 'S1-mini by Superwhisper', 'Qwen by Alibaba Cloud', 'Candle by Hugging Face', 'Tauri', 'React', 'Lucide']) {
    assert.equal(await credits.getByRole('button', { name, exact: true }).count(), 1, `Credits include ${name}`);
  }
  assert.match(await credits.textContent(), /Available offline/);
  const audit = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(audit.violations.map(violation => violation.id), [], 'Credits dialog is accessible');
  const documentPicker = credits.getByRole('combobox', { name: 'View', exact: true });
  for (const [value, path] of [
    ['software', 'THIRD_PARTY_NOTICES.txt'], ['models', 'MODELS.md'],
    ['s1License', 's1-mini/LICENSE'], ['s1Notice', 's1-mini/NOTICE'],
  ]) {
    await documentPicker.selectOption(value);
    await credits.locator('pre').waitFor();
    assert.equal(await credits.locator('pre').textContent(), await readFile(`src-tauri/licenses/${path}`, 'utf8'), `Viewer preserves ${path} verbatim`);
  }
  await page.setViewportSize({ width: 640, height: 480 });
  assert.equal(await credits.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Credits fit the minimum window');
  assert.equal(await credits.locator('.credits-reader').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'License text wraps within its reader');
  await page.keyboard.press('Escape');
  await credits.waitFor({ state: 'hidden' });
  assert.equal(await creditsButton.evaluate(element => element === document.activeElement), true, 'Closing credits restores focus');
  await creditsButton.click();
  assert.equal(await documentPicker.inputValue(), 'credits', 'Reopening starts at acknowledgments');
  await credits.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 650 });

  await navigate('Settings');
  await navigate('Privacy & storage');
  const sharing = page.getByRole('switch', { name: 'Share telemetry', exact: true });
  await sharing.waitFor();
  assert.equal(await sharing.getAttribute('aria-checked'), 'false', 'Previously confirmed off stays off');
  assert.deepEqual(await page.evaluate(() => window.__QA__.telemetryEvents), [], 'No events when off');
  await sharing.click();
  await page.waitForFunction(() => window.__QA__.stores[1].telemetry?.enabled === true);
  await page.waitForFunction(() => window.__QA__.telemetryEvents.some(e => e.command === 'telemetry_page_viewed'));
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE-DICTATION-SENTINEL' })));
  await page.waitForFunction(() => window.__QA__.telemetryEvents.some(e => e.command === 'telemetry_frontend_error'));
  assert.ok(!JSON.stringify(await page.evaluate(() => window.__QA__.telemetryEvents)).includes('PRIVATE-DICTATION-SENTINEL'), 'Raw errors never enter IPC');
  await page.evaluate(() => { window.__QA__.failures.telemetry_set_consent = 'Disk full. Retry saving the preference.'; });
  await sharing.click();
  await page.getByRole('alert').filter({ hasText: 'Disk full' }).waitFor();
  assert.equal(await sharing.getAttribute('aria-checked'), 'false', 'Failed opt-out save still stops sharing for this session');
  await page.evaluate(() => { delete window.__QA__.failures.telemetry_set_consent; });
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await page.waitForFunction(() => window.__QA__.stores[1].telemetry.enabled === false);
  const eventsBefore = (await page.evaluate(() => window.__QA__.telemetryEvents)).length;
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE-DICTATION-SENTINEL' })));
  await navigate('History');
  await page.getByRole('heading', { name: 'Your words', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__QA__.telemetryEvents)).length, eventsBefore, 'No events after opting out');
  await navigate('Settings');
  await navigate('Privacy & storage');
  await page.getByRole('button', { name: 'Privacy notice', exact: true }).click();
  await page.getByRole('dialog', { name: 'Privacy notice', exact: true }).getByRole('heading', { name: 'Storage and your choices', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await context.close();

  const onboarding = await setup({ onboarding: true });
  await onboarding.page.setViewportSize({ width: 640, height: 480 });
  await onboarding.page.getByRole('button', { name: 'Privacy notice', exact: true }).click();
  const onboardingDialog = onboarding.page.getByRole('dialog');
  await onboardingDialog.getByRole('heading', { name: 'About this notice', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await onboardingDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Notice fits the minimum window width');
  await onboarding.page.keyboard.press('Escape');
  assert.ok(!(await onboarding.page.evaluate(() => window.__QA__.calls)).includes('request_microphone'), 'Notice is available before requesting microphone permission');
  await onboarding.context.close();
  const unavailable = await browser.newContext({ viewport: { width: 900, height: 650 } });
  await unavailable.addInitScript(fixture, { telemetryAvailable: false });
  const unavailablePage = await unavailable.newPage();
  await unavailablePage.goto(`http://127.0.0.1:${port}`);
  await unavailablePage.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  await unavailablePage.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await unavailablePage.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Privacy & storage', exact: true }).click();
  assert.equal(await unavailablePage.getByRole('switch', { name: 'Share telemetry', exact: true }).isDisabled(), true, 'Unconfigured builds cannot opt in');
  await unavailable.close();
  // First introduction on an existing installation: preselected draft, no
  // capture before confirmation, then preserve the choice on ordinary reloads.
  for (const enable of [true, false]) {
    const upgrade = await browser.newContext({ viewport: { width: 640, height: 480 } });
    await upgrade.addInitScript(fixture, { telemetryDecided: false });
    const upgradePage = await upgrade.newPage();
    await upgradePage.goto(`http://127.0.0.1:${port}`);
    const invitation = upgradePage.getByRole('dialog', { name: 'Help improve Linty', exact: true });
    await invitation.waitFor();
    const choice = invitation.getByRole('switch', { name: 'Share telemetry', exact: true });
    assert.equal(await choice.getAttribute('aria-checked'), 'true', 'Initial choice is preselected');
    assert.deepEqual(await upgradePage.evaluate(() => window.__QA__.telemetryEvents), [], 'Preselection is not consent');
    assert.equal(await invitation.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    const consentAudit = await new AxeBuilder({ page: upgradePage }).analyze();
    assert.deepEqual(consentAudit.violations.map(v => v.id), [], 'Consent invitation is accessible');
    if (!enable) await choice.click();
    await invitation.getByRole('button', { name: 'Confirm preference', exact: true }).click();
    await invitation.waitFor({ state: 'hidden' });
    assert.equal(await upgradePage.evaluate(() => window.__QA__.stores[1].telemetry.enabled), enable);
    const saved = await upgradePage.evaluate(() => structuredClone(window.__QA__.stores[1]));
    await upgrade.addInitScript(settings => Object.assign(window.__QA__.stores[1], settings), saved);
    await upgradePage.reload();
    await upgradePage.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
    assert.equal(await invitation.count(), 0, 'Saved choice is not requested again on upgrade');
    await upgrade.close();
  }
  assert.deepEqual(external, [], 'Reading bundled notices makes no external web request');
  console.log(`Offline notices, focus, minimum window and access before microphone permission passed (${engine.name()}).`);
} finally {
  await browser?.close();
  server.kill();
}
