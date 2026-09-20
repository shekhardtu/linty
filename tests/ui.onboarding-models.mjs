import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const PARAKEET = 'parakeet-tdt-0.6b-v3';
const WHISPER = 'ggml-large-v3-turbo-q5_0.bin';
const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1456';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const errors = [];

function setupBridge({ existing = [], parakeet = true, local = true, language = 'en', languages = ['en'] } = {}) {
  const qa = window.__QA__;
  qa.stores[1].transcriptionLanguage = language;
  qa.stores[1].autoDetectLanguages = languages;
  delete qa.stores[1].selectedModelFilename;
  qa.installed = new Set(existing);
  qa.downloads = [];
  qa.loads = [];
  qa.pendingDownloads = {};
  qa.pendingLoads = {};
  qa.holdNextLoad = false;
  qa.cleanupDownloads = 0;
  const original = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'download_s1_model') {
      qa.cleanupDownloads++;
      if (qa.holdNextCleanupDownload) {
        qa.holdNextCleanupDownload = false;
        await new Promise((resolve, reject) => { qa.pendingCleanupDownload = { resolve, reject }; });
      }
    }
    if (command === 'is_local_stt_available') return local;
    if (command === 'check_model_exists') return qa.installed.has(args.filename);
    if (command === 'get_available_models') {
      const catalog = await original(command, args);
      return parakeet ? catalog : catalog.filter(model => model.backend === 'whisper');
    }
    if (command === 'download_model_file') {
      qa.downloads.push(args.filename);
      return new Promise((resolve, reject) => {
        qa.pendingDownloads[args.filename] = {
          resolve: () => {
            qa.installed.add(args.filename);
            resolve(`/models/${args.filename}`);
          },
          reject: () => reject(new Error('Connection interrupted')),
        };
      });
    }
    if (command === 'load_local_model') {
      qa.loads.push(args.filename);
      if (qa.failNextLoad) { qa.failNextLoad = false; throw new Error('Preparation failed'); }
      if (qa.holdNextLoad) {
        qa.holdNextLoad = false;
        await new Promise(resolve => { qa.pendingLoads[args.filename] = resolve; });
      }
      qa.nativeModel = args.filename;
      return;
    }
    return original(command, args);
  };
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview did not start')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
  });
  browser = await engine.launch({ headless: true });
  await mkdir('artifacts/language', { recursive: true });
  const open = async (options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1080, height: 820 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ content: `(${fixture.toString()})(${JSON.stringify({ onboarding: !options.returning, empty: true, theme: options.theme ?? 'light' })});(${setupBridge.toString()})(${JSON.stringify(options)});` });
    await page.goto(`http://127.0.0.1:${port}`);
    return page;
  };
  const waitDownload = (page, filename) => page.waitForFunction(name => Boolean(window.__QA__.pendingDownloads[name]), filename);
  const finishDownload = (page, filename) => page.evaluate(name => window.__QA__.pendingDownloads[name].resolve(), filename);
  const waitLanguage = (page, language) => page.waitForFunction(async code => {
    const { useAppStore } = await import('/src/store/app.store.ts');
    const { languagePreparation } = await import('/src/services/language-preparation.service.ts');
    return useAppStore.getState().transcriptionLanguage === code && languagePreparation.getSnapshot().status === 'ready';
  }, language);
  const chooseLanguage = async (page, language, onboarding = false) => {
    await page.getByRole('combobox', { name: onboarding ? 'Dictation language' : 'Transcription language', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search languages', exact: true }).fill(language);
    await page.getByRole('option', { name: language, exact: true }).click();
  };
  const reachLanguage = async page => {
    await page.getByRole('button', { name: 'Get Started', exact: true }).click();
    await page.getByRole('combobox', { name: 'Dictation language', exact: true }).waitFor();
  };
  const reachDone = async page => {
    await page.getByRole('heading', { name: 'Choose Your Trigger Key', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Step 6 of 6 · Ready', { exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Speech model', exact: true }).count(), 0);
  };
  const openLanguageSettings = async page => {
    if (!await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Dictation', exact: true }).count()) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    }
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Dictation', exact: true }).click();
    assert.equal(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Language', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Speech engine', exact: true }).count(), 0);
  };
  const audit = async page => {
    // Let React commit navigation and finish the reduced-motion reveal before
    // axe snapshots colors; macOS WebKit can otherwise capture partial opacity.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.failureSummary) })), []);
  };

  // Onboarding asks for 1–3 real languages, never permits a fourth, and saves
  // the list before preparing Auto-detect. Empty selections cannot continue.
  let page = await open({ existing: [WHISPER] });
  await reachLanguage(page);
  assert.equal(await page.getByRole('group', { name: 'Frequently spoken languages' }).count(), 0);
  await chooseLanguage(page, 'Auto-detect', true);
  await page.getByRole('button', { name: 'Remove English', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true);
  const addLanguage = async (page, name) => {
    await page.getByRole('combobox', { name: 'Add spoken language', exact: true }).click();
    assert.equal(await page.getByRole('option', { name: 'Auto-detect', exact: true }).count(), 0);
    await page.getByRole('combobox', { name: 'Search languages', exact: true }).fill(name);
    await page.getByRole('option', { name, exact: true }).click();
  };
  for (const language of ['English', 'Hindi', 'Tamil']) await addLanguage(page, language);
  assert.equal(await page.getByRole('combobox', { name: 'Add spoken language', exact: true }).isDisabled(), true);
  await chooseLanguage(page, 'Hindi', true);
  assert.equal(await page.getByRole('group', { name: 'Frequently spoken languages' }).count(), 0);
  await chooseLanguage(page, 'Auto-detect', true);
  assert.equal(await page.getByRole('button', { name: /^Remove / }).count(), 3);
  await audit(page);
  await page.screenshot({ path: `artifacts/language/${engine.name()}-onboarding-languages.png` });
  await page.setViewportSize({ width: 640, height: 480 });
  await page.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.getByRole('button', { name: 'Continue', exact: true }).isVisible());
  await audit(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await waitLanguage(page, 'auto');
  assert.deepEqual(await page.evaluate(() => window.__QA__.stores[1].autoDetectLanguages), ['en', 'hi', 'ta']);
  await page.close();

  // No premature download before the first language is confirmed. Setup continues
  // during the download, with a retryable final readiness screen.
  page = await open();
  await reachLanguage(page);
  assert.deepEqual(await page.evaluate(() => window.__QA__.downloads), []);
  await chooseLanguage(page, 'Hindi', true);
  await page.evaluate(() => { window.__QA__.failures['plugin:store|save'] = 'Disk full'; });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__QA__.downloads), []);
  await page.evaluate(() => { delete window.__QA__.failures['plugin:store|save']; });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await waitDownload(page, WHISPER);
  await reachDone(page);
  assert.equal(await page.getByRole('button', { name: 'Start Using Linty', exact: true }).isDisabled(), true);
  await page.evaluate(name => window.__QA__.pendingDownloads[name].reject(), WHISPER);
  await page.getByText('Connection interrupted', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await page.waitForFunction(() => window.__QA__.downloads.length === 2);
  await finishDownload(page, WHISPER);
  await waitLanguage(page, 'hi');
  assert.deepEqual(await page.evaluate(() => window.__QA__.downloads), [WHISPER, WHISPER]);
  await page.getByRole('button', { name: 'Start Using Linty', exact: true }).click();
  await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].selectedModelFilename), WHISPER);
  await page.close();

  // First-run routing respects hardware, auto-detect and cached downloads.
  for (const options of [
    { language: 'en', existing: [PARAKEET], expected: PARAKEET },
    { language: 'en', parakeet: false, existing: [WHISPER], expected: WHISPER },
    { language: 'auto', languages: ['en', 'hi'], existing: [WHISPER], expected: WHISPER },
  ]) {
    page = await open(options);
    await reachLanguage(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await waitLanguage(page, options.language);
    assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), options.language === 'en', 'Onboarding sets cleanup from the selected language');
    assert.deepEqual(await page.evaluate(() => window.__QA__.downloads), []);
    assert.deepEqual(await page.evaluate(() => window.__QA__.loads), [options.expected]);
    await reachDone(page);
    await page.getByRole('button', { name: 'Start Using Linty', exact: true }).click();
    await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__QA__.loads), [options.expected]);
    await page.close();
  }

  // Dictation settings edit the persisted shortlist and expose exactly what
  // Auto-detect uses. Failed saves keep the active list and captured options.
  page = await open({ returning: true, language: 'auto', languages: ['en', 'hi'], existing: [WHISPER, PARAKEET] });
  await waitLanguage(page, 'auto');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Hindi', exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Text cleanup', exact: true }).count(), 0, 'Auto-detect only shows the language shortlist');
  assert.equal(await page.getByRole('button', { name: 'Save languages', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Try dictation', exact: true }).isEnabled(), true);
  await addLanguage(page, 'Tamil');
  assert.equal(await page.getByRole('button', { name: 'Try dictation', exact: true }).isDisabled(), true);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Audio', exact: true }).click();
  await openLanguageSettings(page);
  assert.equal(await page.getByRole('button', { name: 'Remove Tamil', exact: true }).isVisible(), true, 'Leaving the section preserves an unfinished shortlist edit');
  await page.getByText('Auto-detect currently uses: English, Hindi.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Add spoken language', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.__QA__.failures['plugin:store|save'] = 'Disk full'; });
  await page.getByRole('button', { name: 'Save languages', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Disk full' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__QA__.stores[1].autoDetectLanguages), ['en', 'hi']);
  await page.evaluate(() => { delete window.__QA__.failures['plugin:store|save']; });
  await page.getByRole('button', { name: 'Save languages', exact: true }).click();
  await page.getByRole('button', { name: 'Save languages', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Remove Tamil', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Try dictation', exact: true }).isEnabled(), true);
  const captured = await page.evaluate(async () => (await import('/src/services/dictation-options.service.ts')).dictationOptions());
  assert.equal(captured.language, 'auto');
  assert.deepEqual(captured.autoDetectLanguages, ['en', 'hi', 'ta']);
  await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ isRecording: true, status: 'recording' }));
  assert.equal(await page.getByRole('button', { name: 'Remove Hindi', exact: true }).isDisabled(), true);
  await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ isRecording: false, status: 'idle' }));
  await audit(page);
  await page.screenshot({ path: `artifacts/language/${engine.name()}-dictation-languages.png` });
  await page.getByRole('button', { name: 'Try dictation', exact: true }).click();
  await page.getByRole('heading', { name: 'Ready when you are', exact: true }).waitFor();
  await page.getByRole('button', { name: /Configure dictation language$/ }).click();
  await page.getByRole('heading', { name: 'Dictation', exact: true }).waitFor();
  await chooseLanguage(page, 'Hindi'); await waitLanguage(page, 'hi');
  assert.equal(await page.getByRole('combobox', { name: 'Text cleanup', exact: true }).count(), 0, 'Hindi hides cleanup');
  assert.equal(await page.getByRole('group', { name: 'Frequently spoken languages' }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__QA__.stores[1].autoDetectLanguages), ['en', 'hi', 'ta']);
  await chooseLanguage(page, 'Auto-detect'); await waitLanguage(page, 'auto');
  await page.getByRole('button', { name: 'Save languages', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Remove Tamil', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await openLanguageSettings(page);
  await audit(page);
  await page.screenshot({ path: `artifacts/language/${engine.name()}-dictation-languages-dark.png` });
  await page.setViewportSize({ width: 640, height: 480 });
  await page.getByRole('group', { name: 'Frequently spoken languages' }).scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.preferences-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'The three-language list fits the minimum window');
  await audit(page);
  await page.screenshot({ path: `artifacts/language/${engine.name()}-dictation-languages-small.png` });
  await chooseLanguage(page, 'English'); await waitLanguage(page, 'en');
  assert.equal(await page.getByRole('group', { name: 'Frequently spoken languages' }).count(), 0);
  assert.equal(await page.getByRole('combobox', { name: 'Text cleanup', exact: true }).innerText(), 'Clean up on this Mac');
  await page.getByRole('combobox', { name: 'Text cleanup', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.preferences-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'English cleanup fits the minimum window');
  await page.screenshot({ path: `artifacts/language/${engine.name()}-dictation-english-small.png` });
  await page.setViewportSize({ width: 1080, height: 820 });
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await openLanguageSettings(page);
    await audit(page);
    await page.screenshot({ path: `artifacts/language/${engine.name()}-dictation-english-${theme}.png` });
  }
  await chooseLanguage(page, 'Tamil'); await waitLanguage(page, 'ta');
  assert.equal(await page.getByRole('combobox', { name: 'Text cleanup', exact: true }).count(), 0, 'Tamil hides cleanup');
  assert.equal(await page.getByRole('group', { name: 'Frequently spoken languages' }).count(), 0);
  await page.close();

  // A late English download cannot re-enable cleanup after choosing another
  // language. Cached setup is reused, and an explicit English opt-out survives restart.
  page = await open({ returning: true, language: 'hi', existing: [WHISPER, PARAKEET] });
  await waitLanguage(page, 'hi'); await openLanguageSettings(page);
  await page.evaluate(() => { window.__QA__.holdNextCleanupDownload = true; });
  await chooseLanguage(page, 'English');
  await page.getByText('Downloading English text cleanup', { exact: true }).waitFor();
  await page.waitForFunction(() => !!window.__QA__.pendingCleanupDownload);
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'hi');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), false);
  await page.evaluate(() => window.__QA__.emit('s1-download-progress', 42));
  assert.equal(await page.getByRole('progressbar', { name: 'Text cleanup download' }).getAttribute('value'), '42');
  await chooseLanguage(page, 'Tamil'); await waitLanguage(page, 'ta');
  await page.evaluate(() => window.__QA__.pendingCleanupDownload.resolve());
  await page.waitForFunction(() => window.__QA__.calls.includes('download_s1_model'));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'ta');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), false);
  await chooseLanguage(page, 'English'); await waitLanguage(page, 'en');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), true);
  assert.equal(await page.evaluate(() => window.__QA__.cleanupDownloads), 1);
  await page.getByRole('combobox', { name: 'Text cleanup', exact: true }).click();
  await page.getByRole('option', { name: 'Keep as spoken', exact: true }).click();
  await page.waitForFunction(() => window.__QA__.stores[1].reformatEnabled === false);
  // Startup preparation must preserve a user's manual opt-out.
  await page.evaluate(async () => {
    (await import('/src/services/dictation-preparation.service.ts')).dictationPreparation.invalidate();
    await (await import('/src/services/language-preparation.service.ts')).prepareLanguage('en');
  });
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), false);
  await chooseLanguage(page, 'Hindi'); await waitLanguage(page, 'hi');
  await chooseLanguage(page, 'English'); await waitLanguage(page, 'en');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), true, 'Selecting English again restores its automatic default');
  await page.close();

  // Failed cleanup setup and failed preference writes preserve the confirmed
  // language/cleanup pair. Retry keeps the user's automatic English selection.
  page = await open({ returning: true, language: 'hi', existing: [WHISPER, PARAKEET] });
  await waitLanguage(page, 'hi'); await openLanguageSettings(page);
  await page.evaluate(() => { window.__QA__.failures.download_s1_model = 'Cleanup download interrupted'; });
  await chooseLanguage(page, 'English');
  await page.getByRole('alert').filter({ hasText: 'Cleanup download interrupted' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.__QA__.stores[1].transcriptionLanguage, window.__QA__.stores[1].reformatEnabled]), ['hi', false]);
  await page.evaluate(() => { delete window.__QA__.failures.download_s1_model; });
  await page.getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await waitLanguage(page, 'en');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), true);
  await page.evaluate(() => { window.__QA__.failures['plugin:store|save'] = 'Could not save language and cleanup'; });
  await chooseLanguage(page, 'Hindi');
  await page.getByRole('alert').filter({ hasText: 'Could not save language and cleanup' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.__QA__.stores[1].transcriptionLanguage, window.__QA__.stores[1].reformatEnabled]), ['en', true]);
  await page.evaluate(() => { delete window.__QA__.failures['plugin:store|save']; });
  await page.getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await waitLanguage(page, 'hi');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].reformatEnabled), false);
  await page.close();

  // Upgraded users must choose their own shortlist; missing preferences cannot
  // silently fall back to all languages or guessed regional defaults.
  page = await open({ returning: true, language: 'auto', languages: [], existing: [WHISPER] });
  await waitLanguage(page, 'auto');
  await openLanguageSettings(page);
  assert.equal(await page.getByRole('button', { name: 'Try dictation', exact: true }).isDisabled(), true);
  const missingChoice = await page.evaluate(async () => {
    try { (await import('/src/services/dictation-options.service.ts')).dictationOptions(); }
    catch (error) { return error.message; }
  });
  assert.match(missingChoice, /Choose one to three languages/);
  await page.close();

  // Languages sharing speech support do not reload it. New downloads preserve
  // the confirmed language until ready, survive navigation, and cache on disk.
  page = await open({ returning: true, existing: [PARAKEET] });
  await waitLanguage(page, 'en');
  await openLanguageSettings(page);
  await chooseLanguage(page, 'French');
  await waitLanguage(page, 'fr');
  assert.deepEqual(await page.evaluate(() => window.__QA__.loads), [PARAKEET]);
  await chooseLanguage(page, 'Hindi');
  await waitDownload(page, WHISPER);
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'fr');
  await page.getByText('French remains active until Hindi is ready.', { exact: true }).waitFor();
  await page.evaluate(name => window.__QA__.emit('model-download-progress', { filename: name, progress: 42 }), WHISPER);
  assert.equal(await page.getByRole('progressbar', { name: 'Speech support download' }).getAttribute('value'), '42');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await finishDownload(page, WHISPER);
  await waitLanguage(page, 'hi');
  await openLanguageSettings(page);
  await chooseLanguage(page, 'Japanese');
  await waitLanguage(page, 'ja');
  assert.deepEqual(await page.evaluate(() => window.__QA__.loads), [PARAKEET, WHISPER]);
  await chooseLanguage(page, 'English');
  await waitLanguage(page, 'en');
  await chooseLanguage(page, 'Hindi');
  await waitLanguage(page, 'hi');
  assert.deepEqual(await page.evaluate(() => window.__QA__.downloads), [WHISPER]);

  // The picker searches native names, supports keyboard selection, and fits the
  // minimum window in both themes. Errors are announced; technical details stay optional.
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await openLanguageSettings(page);
    await audit(page);
    await page.screenshot({ path: `artifacts/language/${engine.name()}-${theme}.png` });
    await page.getByRole('combobox', { name: 'Transcription language', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search languages', exact: true }).fill('हिन्दी');
    assert.equal(await page.getByRole('option', { name: 'Hindi', exact: true }).count(), 1);
    await audit(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('combobox', { name: 'Transcription language', exact: true }).evaluate(el => el === document.activeElement), true);
  }
  await page.setViewportSize({ width: 640, height: 480 });
  await page.getByRole('combobox', { name: 'Transcription language', exact: true }).click();
  const bounds = await page.getByRole('dialog', { name: 'Choose a language' }).boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 640 && bounds.y + bounds.height <= 480);
  await page.getByRole('combobox', { name: 'Search languages', exact: true }).fill('Japanese');
  await page.keyboard.press('Enter');
  await waitLanguage(page, 'ja');
  await page.close();

  // Latest selection wins even if an earlier download completes afterward.
  page = await open({ returning: true, existing: [PARAKEET] });
  await waitLanguage(page, 'en'); await openLanguageSettings(page);
  await chooseLanguage(page, 'Hindi'); await waitDownload(page, WHISPER);
  await chooseLanguage(page, 'French'); await waitLanguage(page, 'fr');
  await finishDownload(page, WHISPER);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(await page.evaluate(() => window.__QA__.loads), [PARAKEET]);
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'fr');
  await page.close();

  // A stale load and failed persistence both restore the prior active model.
  page = await open({ returning: true, existing: [PARAKEET, WHISPER] });
  await waitLanguage(page, 'en'); await openLanguageSettings(page);
  await page.evaluate(() => { window.__QA__.holdNextLoad = true; });
  await chooseLanguage(page, 'Hindi');
  await page.waitForFunction(name => !!window.__QA__.pendingLoads[name], WHISPER);
  await chooseLanguage(page, 'German');
  await page.evaluate(name => window.__QA__.pendingLoads[name](), WHISPER);
  await waitLanguage(page, 'de');
  assert.equal(await page.evaluate(() => window.__QA__.nativeModel), PARAKEET);
  await page.evaluate(() => { window.__QA__.failures['plugin:store|save'] = 'Could not save language'; });
  await chooseLanguage(page, 'Hindi');
  await page.getByText('Could not save language', { exact: true }).waitFor();
  await page.waitForFunction(name => window.__QA__.nativeModel === name, PARAKEET);
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'de');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].selectedModelFilename), PARAKEET);
  await page.evaluate(() => { delete window.__QA__.failures['plugin:store|save']; });
  await page.getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await waitLanguage(page, 'hi');
  await page.close();

  // A cached model that fails to load is retried without redownloading it.
  // Changing language after idle unload prepares the selected model again.
  page = await open({ returning: true, existing: [PARAKEET, WHISPER] });
  await waitLanguage(page, 'en'); await openLanguageSettings(page);
  await page.evaluate(() => { window.__QA__.failNextLoad = true; });
  await chooseLanguage(page, 'Hindi');
  await page.getByRole('alert').filter({ hasText: 'Preparation failed' }).waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'en');
  await page.getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await waitLanguage(page, 'hi');
  assert.deepEqual(await page.evaluate(() => window.__QA__.downloads), []);
  await page.evaluate(async () => {
    (await import('/src/services/dictation-preparation.service.ts')).dictationPreparation.invalidate();
    window.__QA__.calls = [];
  });
  await chooseLanguage(page, 'Japanese'); await waitLanguage(page, 'ja');
  assert.equal(await page.evaluate(() => window.__QA__.calls.includes('prepare_dictation')), true);
  assert.equal(await page.evaluate(async () => (await import('/src/services/dictation-preparation.service.ts')).dictationPreparation.getSnapshot()), 'ready');
  await page.close();

  // Download completion during capture waits to activate. Tray uses the same path.
  page = await open({ returning: true, existing: [PARAKEET] });
  await waitLanguage(page, 'en'); await openLanguageSettings(page);
  await page.evaluate(() => window.__QA__.emit('tray-language-changed', 'hi'));
  await waitDownload(page, WHISPER);
  await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ isRecording: true, status: 'recording' }));
  await finishDownload(page, WHISPER);
  await page.getByText('Waiting for your dictation to finish', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Transcription language', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__QA__.loads), [PARAKEET]);
  await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.setState({ isRecording: false, status: 'idle' }));
  await waitLanguage(page, 'hi');
  await page.waitForFunction(() => window.__QA__.emittedEvents.some(e => e.event === 'tray-language-result'));
  await page.close();

  // Missing native support blocks completion with an actionable local-build error.
  page = await open({ local: false });
  await reachLanguage(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await reachDone(page);
  assert.equal(await page.getByRole('button', { name: 'Start Using Linty', exact: true }).isDisabled(), true);
  await page.getByRole('alert').filter({ hasText: 'Install a version of Linty that includes on-device speech support' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__QA__.downloads), []);
  await page.close();

  assert.deepEqual(errors, []);
  console.log(`${engine.name()}: language routing, onboarding, caching, failure recovery, latest selection, recording safety, accessibility and responsive layout passed`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
