import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1468';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const errors = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
  });
  browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1040, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  // Exercise microphone lifecycle without opening a physical microphone.
  await page.addInitScript(() => {
    window.__mic = { requests: 0, stops: 0, closes: 0, delay: false };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      window.__mic.requests++;
      const stream = { getTracks: () => [{ stop: () => window.__mic.stops++ }] };
      if (window.__mic.delay) return new Promise(resolve => { window.__mic.resolve = () => resolve(stream); });
      return stream;
    } } });
    window.AudioContext = class {
      state = 'running';
      createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData: values => values.fill(.025) }; }
      createMediaStreamSource() { return { connect() {} }; }
      async resume() {}
      async close() { this.state = 'closed'; window.__mic.closes++; }
    };
  });
  await page.goto(`http://127.0.0.1:${port}/tests/previews/pill-motion-preview.html`);
  await page.locator('.capsule-recording.is-draggable').waitFor();
  assert.equal(await page.evaluate(() => window.__mic.requests), 0, 'The preview never requests the microphone automatically');
  await page.getByRole('button', { name: 'Background noise Low movement' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.capsule-wave span')].every(bar => new DOMMatrix(bar.style.transform).d * 20 < 4));
  await page.getByRole('button', { name: 'Quiet room Almost still' }).click();
  await page.waitForFunction(() => Number(document.getElementById('wave-height').textContent) <= 2.1);
  await page.getByRole('button', { name: 'Conversation Varied, mid-height' }).click();
  await page.waitForFunction(() => Number(document.getElementById('wave-height').textContent) > 6);
  const root = page.locator('#root');
  const origin = await root.boundingBox();
  const drag = async (dx, dy) => {
    const pill = await page.locator('.capsule-pill').boundingBox();
    await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
    await page.mouse.down();
    await page.mouse.move(pill.x + pill.width / 2 + dx, pill.y + pill.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
  };
  await drag(90, 35);
  let moved = await root.boundingBox();
  assert.equal(moved.x, origin.x + 90); assert.equal(moved.y, origin.y + 35);
  await page.getByRole('checkbox', { name: 'Hands-free · double-press to lock' }).uncheck();
  await page.waitForFunction(() => !document.querySelector('.capsule-pill').classList.contains('is-draggable'));
  await drag(-60, -25);
  assert.deepEqual(await root.boundingBox(), moved, 'Hold-to-talk stays in place');
  await page.getByRole('checkbox', { name: 'Hands-free · double-press to lock' }).check();
  await page.getByRole('button', { name: 'Process', exact: true }).click();
  await page.locator('.capsule-pill').evaluate(el => Promise.allSettled(el.getAnimations({ subtree: true }).filter(a => a.playState !== 'paused' && a.effect.getTiming().iterations !== Infinity).map(a => a.finished)));
  await drag(-60, -25);
  assert.deepEqual(await root.boundingBox(), moved, 'Processing stays in place');
  await page.getByRole('button', { name: 'Reset position' }).click();
  assert.deepEqual(await root.boundingBox(), origin);

  await page.getByRole('button', { name: 'Use my microphone' }).click();
  await page.waitForFunction(() => document.getElementById('microphone').textContent === 'Stop microphone' || document.getElementById('mic-note').textContent.includes('unavailable'));
  assert.equal(await page.locator('#microphone').textContent(), 'Stop microphone', JSON.stringify(await page.evaluate(() => ({note:document.getElementById('mic-note').textContent,mic:window.__mic,hidden:document.hidden}))));
  await page.waitForFunction(() => Number(document.getElementById('wave-height').textContent) > 4);
  await page.getByRole('button', { name: 'Process', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__mic.stops), 1, 'Processing releases the microphone track');
  assert.equal(await page.evaluate(() => window.__mic.closes), 1, 'Processing releases the audio context');
  await page.evaluate(() => { window.__mic.delay = true; });
  await page.getByRole('button', { name: 'Use my microphone' }).click();
  await page.waitForFunction(() => !!window.__mic.resolve);
  await page.getByRole('button', { name: 'Process', exact: true }).click();
  await page.evaluate(() => window.__mic.resolve());
  await page.waitForFunction(() => window.__mic.stops === 2);
  assert.equal(await page.locator('.capsule-transcribing').count(), 1, 'A late permission result cannot restart listening');
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.capsule-recording')?.getBoundingClientRect().width === 234 && Number(document.getElementById('wave-height').textContent) > 2);
  await mkdir('artifacts/pill-preview', { recursive: true });
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: 'Switch theme' }).click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.screenshot({ path: `artifacts/pill-preview/${engine.name()}-${theme}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(`Pill preview passed in ${engine.name()}: input examples, hands-free-only dragging, reset, fixed processing, themes and microphone cleanup.`);
} finally { await browser?.close(); server.kill(); }
