import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1478';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
const output = `artifacts/audio-history-${engine.name()}`;
let browser;
const errors = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview did not start')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
  });
  await mkdir(output, { recursive: true });
  browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1080, height: 760 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fixture, {});
  await page.addInitScript(() => {
    for (const record of window.__QA__.stores[2].transcripts.slice(0, 2)) {
      record.audio = { format: 'wav', sampleRate: 16000, channels: 1, bitsPerSample: 16, bytes: 16044 };
    }
    const revoke = URL.revokeObjectURL;
    window.__QA__.revoked = [];
    URL.revokeObjectURL = (url) => { window.__QA__.revoked.push(url); revoke.call(URL, url); };
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  const privacy = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Privacy & storage', exact: true }).click();
  };
  const history = async () => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'History', exact: true }).click();
  const open = async (id) => page.locator(`[data-transcript-id="${id}"]`).click();
  const audit = async () => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.failureSummary) })), []);
  };
  const captureThemes = async (name) => {
    while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) {
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async (value) => {
        const { useAppStore } = await import('/src/store/app.store.ts');
        useAppStore.getState().setTheme(value);
      }, theme);
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
      await audit();
      await page.screenshot({ path: `${output}/${name}-${theme}.png`, animations: 'disabled' });
    }
  };
  await privacy();
  const toggle = page.getByRole('switch', { name: 'Save dictation audio', exact: true });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'Saving requires opt-in');
  await page.evaluate(() => { window.__QA__.failures.history_set_save_audio = 'Disk unavailable'; });
  await toggle.click();
  await page.getByText('Could not save your audio preference. Please try again.').waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'A failed write never claims consent');
  await page.evaluate(() => { delete window.__QA__.failures.history_set_save_audio; });
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Save dictation audio"]').getAttribute('aria-checked') === 'true');
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Save dictation audio"]').getAttribute('aria-checked') === 'false');
  assert.equal(await page.evaluate(() => window.__QA__.stores[2].transcripts.filter(t => t.audio).length), 2, 'Opting out keeps existing recordings');
  await audit();
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/privacy.png` });
  await captureThemes('privacy');

  await history();
  await page.locator('[data-transcript-id="qa-0"]').waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.calls.filter(c => c === 'history_audio').length), 0, 'The history list never reads audio bytes');
  await open('qa-2');
  await page.getByText('No saved audio for this dictation.').waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.calls.filter(c => c === 'history_audio').length), 0, 'Transcripts without recordings never read audio bytes');
  await open('qa-0');
  const player = page.getByLabel('Play dictation recording');
  await player.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  assert.equal(await page.evaluate(() => window.__QA__.calls.includes('history_audio')), true, 'Selecting a transcript automatically reads its audio');
  assert.equal(await player.evaluate(el => el.paused), true, 'Selecting a transcript prepares audio without autoplay');
  assert.equal(await page.getByRole('button', { name: 'Load recording', exact: true }).count(), 0, 'Playback needs no separate loading action');
  assert.equal(await player.evaluate(el => el.duration), 0.5, 'WAV is decodable by the media player');
  await player.evaluate(async el => { await el.play(); });
  assert.equal(await player.evaluate(el => el.paused), false, 'Saved audio plays');
  await player.evaluate(el => el.pause());
  const oldUrl = await player.getAttribute('src');
  const oldPlayer = await player.elementHandle();
  await audit();
  await page.screenshot({ path: `${output}/playback.png` });
  await captureThemes('playback');
  await page.evaluate(() => { window.__QA__.failures.history_audio = 'Unavailable'; });
  await open('qa-1');
  await page.getByRole('button', { name: 'Retry audio', exact: true }).waitFor();
  assert.equal(await page.evaluate(url => window.__QA__.revoked.includes(url), oldUrl), true, 'Changing selection releases the old recording');
  assert.equal(await oldPlayer.getAttribute('src'), null, 'Unmounting stops and detaches the previous audio');
  await page.evaluate(() => { delete window.__QA__.failures.history_audio; });
  await page.getByRole('button', { name: 'Retry audio', exact: true }).click();
  await player.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Export WAV…', exact: true }).click();
  await page.getByText('Audio exported as WAV.').waitFor();
  await page.getByRole('button', { name: 'Delete recording…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete this recording?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await player.isVisible(), true, 'Cancel keeps audio');
  await page.getByRole('button', { name: 'Delete recording…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete this recording?' }).getByRole('button', { name: 'Delete recording', exact: true }).click();
  await page.getByText('No saved audio for this dictation.').waitFor();
  assert.equal(await page.locator('.reading-text').innerText(), 'Thanks for the thoughtful feedback. I’ll send the updated proposal tomorrow morning.');

  await page.setViewportSize({ width: 640, height: 480 });
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await open('qa-0');
  await player.waitFor({ state: 'visible' });
  assert.equal(await player.evaluate(el => el.getBoundingClientRect().width <= el.closest('.history-detail').clientWidth), true);
  await audit();
  await player.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/playback-small.png` });

  await privacy();
  await page.getByRole('button', { name: 'Delete all recordings…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete all saved recordings?' }).getByRole('button', { name: 'Delete all recordings', exact: true }).click();
  await page.getByText('Saved recordings deleted. Your transcripts were kept.').waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.stores[2].transcripts.length), 18);
  assert.equal(await page.evaluate(() => window.__QA__.stores[2].transcripts.filter(t => t.audio).length), 0);
  await page.evaluate(async () => {
    const { saveTranscript } = window.__QA__;
    await saveTranscript({ ...window.__QA__.stores[2].transcripts[2], audio: {format:'wav',sampleRate:16000,channels:1,bitsPerSample:16,bytes:70*1024*1024} });
  });
  const readsBeforeLarge = await page.evaluate(() => window.__QA__.calls.filter(c => c === 'history_audio').length);
  await history();
  await open('qa-2');
  await page.getByText('For this long recording, export the WAV to listen without loading it into Linty.').waitFor();
  assert.equal(await player.count(), 0);
  assert.equal(await page.getByText('Loading recording…', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', {name:'Export WAV…',exact:true}).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__QA__.calls.filter(c => c === 'history_audio').length), readsBeforeLarge, 'Large recordings stay out of webview memory');

  // A committed deletion must release playback and text caches even if every
  // subsequent refresh fails. The archive remains the authority after retry.
  await page.evaluate(async () => {
    const { saveTranscript } = window.__QA__;
    await saveTranscript({ ...window.__QA__.stores[2].transcripts.find(t => t.transcriptId === 'qa-2'),
      audio: {format:'wav',sampleRate:16000,channels:1,bitsPerSample:16,bytes:16044} });
  });
  await player.waitFor({state:'visible'});
  const deletedPlayer = await player.elementHandle();
  const deletedUrl = await player.getAttribute('src');
  await page.evaluate(async () => {
    const { removeTranscript } = await import('/src/services/history.service.ts');
    window.__QA__.failures.history_snapshot = 'Refresh unavailable';
    window.__QA__.failures.history_query = 'Refresh unavailable';
    await removeTranscript('qa-2');
  });
  await player.waitFor({state:'detached'});
  assert.equal(await deletedPlayer.getAttribute('src'), null, 'Deletion stops and detaches loaded audio despite refresh failure');
  assert.equal(await page.evaluate(url => window.__QA__.revoked.includes(url), deletedUrl), true);
  assert.equal(await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().transcripts.length), 0, 'No stale recent history survives the failed refresh');
  assert.equal(await page.evaluate(() => window.__QA__.stores[3].corrections.some(c => c.transcriptId === 'qa-2')), false);

  await page.evaluate(async () => {
    delete window.__QA__.failures.history_snapshot;
    delete window.__QA__.failures.history_query;
    const { refreshHistory, setHistoryRetention } = await import('/src/services/history.service.ts');
    const { saveTranscript } = window.__QA__;
    await refreshHistory();
    await saveTranscript({ ...window.__QA__.stores[2].transcripts.find(t => t.transcriptId === 'qa-3'),
      audio: {format:'wav',sampleRate:16000,channels:1,bitsPerSample:16,bytes:16044} });
    await setHistoryRetention(30);
  });
  await open('qa-3');
  await player.waitFor({state:'visible'});
  const expiredPlayer = await player.elementHandle();
  const expiredUrl = await player.getAttribute('src');
  await page.evaluate(async () => {
    const { refreshHistory } = await import('/src/services/history.service.ts');
    window.__QA__.stores[2].transcripts.find(t => t.transcriptId === 'qa-3').timestamp = Date.now() - 31 * 86400000;
    await refreshHistory();
  });
  assert.equal(await player.isVisible(), true, 'Repeated history access respects the persisted daily cleanup gate');
  await page.evaluate(async () => {
    window.__QA__.history.lastCleanupAt = Date.now() - 86400001;
    // Models a due native sweep while History is open; the fixture emits the
    // same content-free invalidation event as the native maintenance worker.
    await window.__TAURI_INTERNALS__.invoke('history_snapshot');
  });
  await player.waitFor({state:'detached'});
  assert.equal(await expiredPlayer.getAttribute('src'), null, 'Expiry detaches playback');
  assert.equal(await page.evaluate(url => window.__QA__.revoked.includes(url), expiredUrl), true, 'Expiry revokes the cached audio URL');
  await page.waitForFunction(() => !document.querySelector('[data-transcript-id="qa-3"]'));
  assert.equal(await page.evaluate(() => window.__QA__.stores[2].transcripts.some(t => t.transcriptId === 'qa-3')), false);
  assert.deepEqual(errors, []);
  console.log(`Audio history passed (${engine.name()}): opt-in, load on selection without autoplay, playable WAV, released URLs, export, deletion with failed refresh, daily expiry, responsive layout and accessibility.`);
} finally {
  await browser?.close();
  server.kill();
}
