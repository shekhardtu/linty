import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { fixture } from './ui.fixture.mjs';

// Use the production bundle and its actual CSP; Vite dev mode needs a looser policy.
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const port = process.env.UI_PORT ?? '1488';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Production preview did not start')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
  });
  const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch();
  const context = await browser.newContext();
  await context.addInitScript(fixture, {});
  await context.route(`http://127.0.0.1:${port}/**`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': config.app.security.csp } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  assert.deepEqual(errors, [], 'Production assets must work under CSP');
  await page.evaluate(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(event.effectiveDirective));
  });
  assert.equal(await page.evaluate(async () => {
    const script = document.createElement('script');
    script.textContent = 'window.__unsafeInlineRan = true';
    document.body.append(script);
    await new Promise(resolve => setTimeout(resolve, 10));
    return !!window.__unsafeInlineRan;
  }), false, 'Inline injected scripts are blocked');
  assert.equal(await page.evaluate(async () => {
    try { await fetch('https://unapproved.invalid/'); return true; } catch { return false; }
  }), false, 'Unexpected network destinations are blocked');
  await page.waitForFunction(() => window.__cspViolations.includes('connect-src'));
  assert.ok((await page.evaluate(() => window.__cspViolations)).some(directive => directive.startsWith('script-src')), 'CSP enforces the inline script block');
  await page.goto(`http://127.0.0.1:${port}/capsule.html`);
  await page.waitForFunction(() => window.__QA__.calls.includes('get_theme'));
  await page.evaluate(() => window.__QA__.emit('theme-changed', 'light'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.evaluate(() => window.__QA__.emit('theme-changed', 'dark'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.ok(!(await page.evaluate(() => window.__QA__.calls)).some(command => command.startsWith('plugin:store|')), 'Capsule has no store access');
  assert.deepEqual(errors, [], 'Capsule initializes under CSP');
  console.log(`Production CSP and capsule theme checks passed (${engine.name()})`);
} finally {
  await browser?.close();
  server.kill();
}
