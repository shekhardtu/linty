import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const notes = await readFile('RELEASE_NOTES.md', 'utf8');
const firstHighlight = notes.split(/\r?\n/).find(line => line.startsWith('- ')).slice(2);
const port = process.env.UI_PORT ?? '1462';
const output = `artifacts/updates-${process.env.UI_BROWSER ?? 'chromium'}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const errors = [];

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview timeout')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', reject);
  });
  await mkdir(output, { recursive: true });
  browser = await engine.launch({ headless: true });

  const launch = async ({ previous = '0.0.1', running = version, theme = 'light', onboarding = false, offer = null, offline = false, clock = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1080, height: 760 } });
    const page = await context.newPage();
    if (clock) await page.clock.install();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(fixture, { empty: true, theme, onboarding, update: offer });
    await page.addInitScript(({ previous, running, offer, offline }) => {
      const qa = window.__QA__;
      const saved = sessionStorage.getItem('qa-update-history');
      qa.stores[1].updateHistory = saved ? JSON.parse(saved) : previous ? { lastRunVersion: previous, notice: null } : null;
      const currentVersion = sessionStorage.getItem('qa-running-version') ?? running;
      if (currentVersion !== running) qa.setUpdate(null);
      if (offline) qa.failures['check_for_update'] = 'Offline';
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'plugin:app|version') return currentVersion;
        if (command === 'plugin:store|save' && qa.failSave) throw new Error('Synthetic disk write failure');
        const result = await invoke(command, args);
        if (command === 'plugin:store|save' && qa.stores[1].updateHistory) {
          sessionStorage.setItem('qa-update-history', JSON.stringify(qa.stores[1].updateHistory));
        }
        if (command === 'plugin:updater|install') sessionStorage.setItem('qa-running-version', offer.version);
        if (command === 'plugin:process|restart') window.location.reload();
        if (command === 'plugin:shell|open') qa.openedUrl = args.path;
        return result;
      };
    }, { previous, running, offer, offline });
    await page.goto(`http://127.0.0.1:${port}`);
    return page;
  };
  const about = page => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'About', exact: true }).click();
  const check = page => page.evaluate(() => window.__QA__.emit('menu-check-for-updates'));
  const notice = page => page.getByRole('dialog', { name: 'Linty updated', exact: true });

  for (const theme of ['light', 'dark']) {
    const page = await launch({ theme, offline: true });
    const dialog = notice(page);
    await dialog.waitFor();
    assert.match(await dialog.innerText(), new RegExp(`Version ${version.replaceAll('.', '\\.')} is installed`));
    assert.ok(await dialog.getByText(firstHighlight, { exact: true }).isVisible());
    await check(page);
    await page.waitForFunction(() => window.__QA__.calls.includes('check_for_update'));
    assert.equal(await dialog.getByText('You’re up to date.', { exact: true }).count(), 0, 'offline is not proof of latest');
    await page.evaluate(() => { delete window.__QA__.failures['check_for_update']; });
    await check(page);
    await dialog.getByText('You’re up to date.', { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/updated-${theme}.png`, animations: 'disabled' });
    const audit = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(audit.violations.map(v => `${v.id}: ${v.help}`), []);
    await dialog.getByRole('button', { name: 'View release notes' }).click();
    assert.equal(await page.evaluate(() => window.__QA__.openedUrl), `https://github.com/shekhardtu/linty/releases/tag/v${version}`);

    await page.setViewportSize({ width: 640, height: 480 });
    await dialog.getByRole('button', { name: 'Got it' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'keyboard focus remains inside the dialog');
    await page.screenshot({ path: `${output}/updated-minimum-${theme}.png`, animations: 'disabled' });
    await page.evaluate(() => { window.__QA__.failSave = true; });
    await dialog.getByRole('button', { name: 'Got it' }).click();
    await dialog.getByRole('alert').waitFor();
    await page.reload();
    await notice(page).waitFor();
    await page.keyboard.press('Escape');
    await notice(page).waitFor({ state: 'detached' });
    await page.reload();
    await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
    assert.equal(await notice(page).count(), 0, 'acknowledgment stays dismissed after restart');
    await about(page);
    await page.getByRole('heading', { name: 'What’s new in this version' }).waitFor();
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await page.getByText('Could not check for updates. Check your connection and try again.').waitFor();
    assert.equal(await page.getByText('You’re up to date.', { exact: true }).count(), 0);
    await page.setViewportSize({ width: 1080, height: 760 });
    await page.screenshot({ path: `${output}/about-${theme}.png`, animations: 'disabled' });
    await page.close();
  }

  const fresh = await launch({ previous: null, onboarding: true });
  await fresh.waitForFunction(() => window.__QA__.stores[1].updateHistory?.lastRunVersion);
  assert.equal(await fresh.getByRole('dialog').count(), 0, 'fresh installs do not claim an update');
  await fresh.close();

  const legacy = await launch({ previous: null });
  await legacy.getByRole('dialog', { name: "What's new in Linty", exact: true }).waitFor();
  assert.equal(await notice(legacy).count(), 0, 'existing untracked installations get a neutral welcome');
  await legacy.close();

  // Exercise both real hook install paths. Only the simulated newly running
  // binary after relaunch creates the acknowledgment; the old binary does not.
  for (const required of [false, true]) {
    const offer = { rid: 9, currentVersion: '0.0.1', version, body: notes, rawJson: { version, ...(required ? { minimum_version: version } : {}) } };
    const page = await launch({ previous: '0.0.1', running: '0.0.1', offer });
    await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
    await page.clock.install();
    await check(page);
    if (required) {
      await page.getByRole('dialog', { name: 'Linty needs to update' }).getByText(firstHighlight, { exact: true }).waitFor();
      await page.waitForFunction(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().updateStatus === 'waiting');
      await page.clock.fastForward(31_000);
    } else {
      await about(page);
      await page.getByRole('heading', { name: `What’s new in v${version}` }).waitFor();
      await page.evaluate(() => { window.__QA__.failures['plugin:updater|install'] = 'Synthetic install failure'; });
      await page.getByRole('button', { name: 'Install', exact: true }).click();
      await page.getByText('Synthetic install failure', { exact: true }).waitFor();
      assert.equal(await notice(page).count(), 0, 'failed installation never acknowledges success');
      await page.evaluate(() => { delete window.__QA__.failures['plugin:updater|install']; });
      await check(page);
      await page.getByRole('button', { name: 'Install', exact: true }).click();
      await page.waitForFunction(version => sessionStorage.getItem('qa-running-version') === version, version);
      await page.clock.fastForward(2_000);
    }
    await notice(page).waitFor();
    await notice(page).getByText(`Version ${version} is installed.`, { exact: true }).waitFor();
    await page.close();
  }

  // Revoking a required update leaves the app idle on its older version.
  // Idle alone must not turn a successful check that found an update into
  // confirmation that the installed version is the latest.
  const revocableOffer = { rid: 9, currentVersion: '0.0.2', version, body: notes, rawJson: { version, minimum_version: version } };
  const revoked = await launch({ previous: '0.0.1', running: '0.0.2', offer: revocableOffer });
  await notice(revoked).waitFor();
  await revoked.clock.install();
  await check(revoked);
  await revoked.waitForFunction(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().updateStatus === 'waiting');
  await revoked.evaluate(offer => window.__QA__.setUpdate({ ...offer, rawJson: { version: offer.version } }), revocableOffer);
  await revoked.clock.fastForward(31_000);
  await notice(revoked).waitFor();
  assert.equal(await notice(revoked).getByText('You’re up to date.', { exact: true }).count(), 0, 'revoking a required update does not make the installed version current');
  assert.equal(await revoked.evaluate(() => window.__QA__.calls.includes('plugin:updater|install')), false);
  await notice(revoked).getByRole('button', { name: 'Got it' }).click();
  await about(revoked);
  assert.equal(await revoked.getByText('You’re up to date.', { exact: true }).count(), 0, 'About must also avoid false confirmation');
  await revoked.close();

  const retrying = await launch({ previous: version, offline: true, clock: true });
  await retrying.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  await about(retrying);
  await retrying.clock.fastForward(6_000);
  await retrying.getByText('Could not check for updates. Check your connection and try again.', { exact: true }).waitFor();
  await retrying.getByRole('button', { name: 'Retry update', exact: true }).waitFor();
  assert.equal(await retrying.getByText('You’re up to date.', { exact: true }).count(), 0);
  const checkCount = await retrying.evaluate(() => window.__QA__.calls.filter(command => command === 'check_for_update').length);
  await retrying.clock.fastForward(60_000);
  await retrying.waitForFunction(async count => {
    const state = (await import('/src/store/app.store.ts')).useAppStore.getState();
    return state.updateStatus === 'error' && window.__QA__.calls.filter(command => command === 'check_for_update').length === count + 1;
  }, checkCount);
  await retrying.evaluate(() => { delete window.__QA__.failures.check_for_update; });
  await retrying.clock.fastForward(120_000);
  await retrying.getByText('You’re up to date.', { exact: true }).waitFor();
  assert.equal(await retrying.getByRole('button', { name: 'Retry update', exact: true }).count(), 0, 'automatic recovery clears the retry state');
  await retrying.close();
  assert.deepEqual(errors, []);
  console.log('Update feedback passed: both themes, accessibility, minimum window, offline status, durable acknowledgment, fresh/legacy installs, release notes, failed install and optional/required update relaunch.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
