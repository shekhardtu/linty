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

  const launch = async ({ previous = '0.0.0', running = version, theme = 'light', onboarding = false, offer = null, offline = false, clock = false, reloadOnRestart = true } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1080, height: 760 } });
    const page = await context.newPage();
    if (clock) await page.clock.install();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(fixture, { empty: true, theme, onboarding, update: offer });
    await page.addInitScript(({ previous, running, offer, offline, reloadOnRestart }) => {
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
        if (command === 'plugin:process|restart' && reloadOnRestart) window.location.reload();
        if (command === 'plugin:shell|open') qa.openedUrl = args.path;
        return result;
      };
    }, { previous, running, offer, offline, reloadOnRestart });
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
    await page.evaluate(() => { delete window.__QA__.failures['check_for_update']; });
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await page.getByText('You’re up to date.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Read full release notes', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__QA__.openedUrl), `https://github.com/shekhardtu/linty/releases/tag/v${version}`, 'About links to the installed release when current');
    while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) {
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
    }
    await page.setViewportSize({ width: 1240, height: 560 });
    await page.getByRole('main').locator('..').screenshot({ path: `${output}/about-current-${theme}.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 640, height: 480 });
    await page.screenshot({ path: `${output}/about-current-minimum-${theme}.png`, animations: 'disabled' });
    await page.evaluate(() => { window.__QA__.failures['check_for_update'] = 'Offline'; });
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
    const offer = { rid: 9, currentVersion: '0.0.0', version, body: notes, rawJson: { version, ...(required ? { minimum_version: version } : {}) } };
    const page = await launch({ previous: '0.0.0', running: '0.0.0', offer });
    await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
    await page.clock.install();
    await check(page);
    if (required) {
      const updateNotice = page.getByRole('dialog', { name: 'Updating Linty' });
      await updateNotice.getByText('What’s new', { exact: true }).click();
      await updateNotice.getByText(firstHighlight, { exact: true }).waitFor();
      await page.waitForFunction(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().updateStatus === 'waiting');
      await page.clock.fastForward(6_000);
    } else {
      await about(page);
      await page.getByRole('heading', { name: `What’s new in v${version}` }).waitFor();
      await page.getByRole('button', { name: 'Read full release notes', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__QA__.openedUrl), `https://github.com/shekhardtu/linty/releases/tag/v${version}`, 'Available-update highlights link to the offered release');
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
  const newerVersion = version.replace(/\d+$/, patch => String(Number(patch) + 1));
  const revocableOffer = { rid: 9, currentVersion: version, version: newerVersion, body: notes, rawJson: { version: newerVersion, minimum_version: newerVersion } };
  const revoked = await launch({ previous: '0.0.0', running: version, offer: revocableOffer });
  await notice(revoked).waitFor();
  await revoked.clock.install();
  await check(revoked);
  await revoked.waitForFunction(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().updateStatus === 'waiting');
  await revoked.evaluate(offer => window.__QA__.setUpdate({ ...offer, rawJson: { version: offer.version } }), revocableOffer);
  await revoked.clock.fastForward(6_000);
  await notice(revoked).waitFor();
  assert.equal(await notice(revoked).getByText('You’re up to date.', { exact: true }).count(), 0, 'revoking a required update does not make the installed version current');
  assert.equal(await revoked.evaluate(() => window.__QA__.calls.includes('plugin:updater|install')), false);
  await notice(revoked).getByRole('button', { name: 'Got it' }).click();
  await about(revoked);
  assert.equal(await revoked.getByText('You’re up to date.', { exact: true }).count(), 0, 'About must also avoid false confirmation');
  await revoked.close();

  const requiredOffer = { rid: 9, currentVersion: '0.0.0', version, body: notes, rawJson: { version, minimum_version: version } };
  for (const theme of ['light', 'dark']) {
    const page = await launch({ previous: '0.0.0', running: '0.0.0', offer: requiredOffer, theme, reloadOnRestart: false });
    await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
    await page.clock.install();
    await about(page);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'About', exact: true }).focus();
    const focusBefore = await page.evaluate(() => document.activeElement.textContent);
    await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ isRecording: true, status: 'recording' }));
    await check(page);
    const updateNotice = page.getByRole('dialog', { name: 'Updating Linty' });
    await updateNotice.getByText('Downloaded. Finish your dictation; Linty will restart afterward.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.querySelectorAll(':modal').length), 0);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), focusBefore, 'the update never steals keyboard focus');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'History', exact: true }).click();
    assert.equal(await page.getByRole('main').getAttribute('aria-label'), 'history', 'navigation works while the notice is visible');
    await updateNotice.getByRole('button', { name: 'Hide update notice' }).click();
    await updateNotice.waitFor({ state: 'detached' });
    await about(page);
    await page.getByRole('button', { name: 'Update status', exact: true }).click();
    await updateNotice.waitFor();
    await page.screenshot({ path: `${output}/required-modeless-${theme}.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 640, height: 480 });
    const box = await updateNotice.boundingBox();
    assert.ok(box.y >= 48 && box.x >= 0 && box.x + box.width <= 640 && box.y + box.height <= 440);
    const audit = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(audit.violations.map(v => `${v.id}: ${v.help}`), []);
    await page.screenshot({ path: `${output}/required-modeless-minimum-${theme}.png`, animations: 'disabled' });
    await updateNotice.getByRole('button', { name: 'Hide update notice' }).focus();
    await page.keyboard.press('Escape');
    await updateNotice.waitFor({ state: 'detached' });
    await page.clock.fastForward(60_000);
    assert.equal(await page.evaluate(() => window.__QA__.calls.includes('plugin:updater|install')), false, 'hiding never interrupts dictation');
    await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ isRecording: false, status: 'pasting' }));
    await page.clock.fastForward(60_000);
    assert.equal(await page.evaluate(() => window.__QA__.calls.includes('plugin:updater|install')), false, 'delivery must finish before install');
    await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ status: 'done' }));
    await page.getByRole('button', { name: 'Update status', exact: true }).click();
    await updateNotice.getByText('Downloaded. Restarting in 5 seconds…', { exact: true }).waitFor();
    await page.clock.fastForward(4_000);
    assert.equal(await page.evaluate(() => window.__QA__.calls.includes('plugin:updater|install')), false);
    await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ status: 'preparing' }));
    await page.clock.fastForward(10_000);
    assert.equal(await page.evaluate(() => window.__QA__.calls.includes('plugin:updater|install')), false, 'a new dictation cancels the countdown');
    await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ status: 'idle' }));
    await updateNotice.getByRole('button', { name: 'Hide update notice' }).click();
    await page.clock.fastForward(6_000);
    await page.waitForFunction(() => window.__QA__.calls.includes('plugin:process|restart'));
    const calls = await page.evaluate(() => window.__QA__.calls);
    for (const command of ['plugin:updater|download', 'plugin:updater|install', 'plugin:process|restart']) assert.equal(calls.filter(c => c === command).length, 1, command);
    assert.equal(await updateNotice.count(), 0, 'the notice closes before relaunch, even without a document reload');
    await page.close();
  }

  const restartFailure = await launch({ previous: '0.0.0', running: '0.0.0', offer: requiredOffer, reloadOnRestart: false });
  await restartFailure.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  await restartFailure.clock.install();
  await restartFailure.evaluate(() => { window.__QA__.failures['plugin:process|restart'] = 'Synthetic restart failure'; });
  await check(restartFailure);
  await restartFailure.waitForFunction(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().updateRestartAt !== null);
  await restartFailure.clock.fastForward(6_000);
  const failedNotice = restartFailure.getByRole('dialog', { name: 'Updating Linty' });
  await failedNotice.getByRole('alert').waitFor();
  await restartFailure.evaluate(() => { delete window.__QA__.failures['plugin:process|restart']; });
  await failedNotice.getByRole('button', { name: 'Restart Linty', exact: true }).click();
  await restartFailure.waitForFunction(() => window.__QA__.calls.filter(c => c === 'plugin:process|restart').length === 2);
  const recoveredCalls = await restartFailure.evaluate(() => window.__QA__.calls);
  assert.equal(recoveredCalls.filter(c => c === 'plugin:updater|download').length, 1, 'restart retry does not redownload');
  assert.equal(recoveredCalls.filter(c => c === 'plugin:updater|install').length, 1, 'restart retry does not reinstall');
  await failedNotice.waitFor({ state: 'detached' });
  await restartFailure.close();

  const stalledCheck = await launch({ previous: '0.0.0', running: '0.0.0', offer: requiredOffer, reloadOnRestart: false });
  await stalledCheck.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  await stalledCheck.clock.install();
  await check(stalledCheck);
  await stalledCheck.waitForFunction(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().updateRestartAt !== null);
  await stalledCheck.evaluate(offer => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'check_for_update') {
        await new Promise(resolve => { window.__QA__.finishStalledRecheck = resolve; });
        return { ...offer, rid: 10 };
      }
      if (command === 'plugin:resources|close') window.__QA__.closedUpdateRid = args.rid;
      return invoke(command, args);
    };
  }, requiredOffer);
  await stalledCheck.clock.fastForward(6_000);
  await stalledCheck.waitForFunction(() => window.__QA__.finishStalledRecheck);
  await stalledCheck.getByRole('dialog', { name: 'Updating Linty' }).getByText('Getting ready to restart…', { exact: true }).waitFor();
  await about(stalledCheck);
  await stalledCheck.clock.fastForward(41_000);
  await stalledCheck.waitForFunction(() => window.__QA__.calls.includes('plugin:process|restart'));
  await stalledCheck.evaluate(() => window.__QA__.finishStalledRecheck());
  await stalledCheck.waitForFunction(() => window.__QA__.closedUpdateRid === 10);
  assert.equal(await stalledCheck.evaluate(() => window.__QA__.calls.filter(c => c === 'plugin:updater|install').length), 1);
  await stalledCheck.close();

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
