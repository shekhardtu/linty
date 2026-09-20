// Reproducible, lossless Retina image exports from the actual app and synthetic data.
// This is an asset build, not a capture of anyone's installed application/history.
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const origin = process.env.WEBSITE_CAPTURE_ORIGIN || 'http://127.0.0.1:1420';
const output = resolve('website/images');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({viewport:{width:1200,height:800},deviceScaleFactor:2,reducedMotion:'reduce'});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const capture = async name => {
    await page.getByText(/^Changes (?:are )?saved locally$/).waitFor();
    await page.mouse.move(1190, 790);
    await page.evaluate(async()=>{
      await document.fonts.ready;
      await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
    });
    await page.screenshot({path:resolve(output,`${name}.png`),type:'png',scale:'device',animations:'disabled'});
    const png=await readFile(resolve(output,`${name}.png`));
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),2400);
    assert.equal(png.readUInt32BE(20),1600);
    console.log(`${name}: lossless PNG, 2400 × 1600`);
  };
  for (const theme of ['light','dark']) {
    await page.goto(`${origin}/scripts/website-preview.html?theme=${theme}`);
    await page.getByRole('heading',{name:'Your dictation',exact:true}).waitFor();
    await page.getByRole('region',{name:'Dictation summary'}).getByText('3,048',{exact:true}).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
    await page.locator('.app-avatar.has-icon img').first().waitFor();
    await capture(`overview-${theme}`);
    await page.getByRole('button',{name:'History',exact:true}).click();
    await page.getByRole('region',{name:'Today',exact:true}).getByRole('button',{name:/Thanks for walking me through the proposal/}).click();
    await page.getByRole('region',{name:'Selected transcription',exact:true}).waitFor();
    await capture(`history-${theme}`);
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Dictation',exact:true}).click();
    await page.getByRole('heading',{name:'Dictation',exact:true}).waitFor();
    assert.equal(await page.getByRole('combobox',{name:'Transcription language',exact:true}).innerText(),'English');
    await page.getByText('S1-mini by Superwhisper', { exact: true }).waitFor();
    await page.getByText('Ready for offline dictation', { exact: true }).waitFor();
    await page.getByText('Customize cleanup', { exact: true }).click();
    await page.getByText('Use lists when appropriate', { exact: true }).waitFor();
    // Keep the existing asset URLs stable as Language moves into Dictation.
    await capture(`language-${theme}`);
  }
  assert.deepEqual(errors,[]);
} finally { await browser.close(); }
