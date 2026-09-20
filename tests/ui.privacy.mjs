import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
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
  await page.getByRole('button', { name: 'License and responsible use', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Recording and content', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

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
  assert.deepEqual(external, [], 'Reading bundled notices makes no external web request');
  console.log(`Offline notices, focus, minimum window and access before microphone permission passed (${engine.name()}).`);
} finally {
  await browser?.close();
  server.kill();
}
