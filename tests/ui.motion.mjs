import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? (engine === webkit ? '1460' : '1459');
const url = `http://127.0.0.1:${port}`;
const output = `artifacts/motion-${engine.name()}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let stderr = '';
server.stderr.on('data', chunk => { stderr += chunk; });
const errors = [];
const settle = async locator => locator.evaluate(async el => {
  await new Promise(requestAnimationFrame);
  await Promise.allSettled(el.getAnimations({subtree:true}).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished));
});
const rect = locator => locator.evaluate(el => ({x:el.offsetLeft,y:el.offsetTop,width:el.offsetWidth,height:el.offsetHeight}));
const navigate = (page, name) => page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();
try {
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error(`Motion preview did not start: ${stderr}`)),15000);
    server.stdout.on('data',chunk=>{if(String(chunk).includes(port)){clearTimeout(timer);resolve();}});
    server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Motion preview exited ${code}: ${stderr}`));});
  });
  await mkdir(output,{recursive:true});
  browser=await engine.launch({headless:true});
  for (const reducedMotion of ['no-preference','reduce']) {
    for (const theme of ['light','dark']) {
      const context=await browser.newContext({viewport:{width:1080,height:760},reducedMotion});
      const page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(fixture,{theme,historyCount:80});
      await page.goto(url);
      await page.locator('.overview-transcripts [data-transcript-id="qa-0"]').waitFor();
      await settle(page.locator('main'));
      // Moving over row content and sibling actions cannot change layout or remount icons.
      const row=page.locator('.overview-transcripts .transcript-row').first();
      const rowRect=await rect(row);
      const rowHandle=await row.elementHandle();
      for (const target of [row.locator('.transcript-select'),row.getByRole('button',{name:'Copy transcript',exact:true}),row.getByRole('button',{name:'Delete transcript',exact:true})]) {
        await target.hover();
        assert.deepEqual(await rect(row),rowRect,'Hover preserves row geometry');
        assert.equal(await rowHandle.evaluate(el=>el.isConnected),true,'Hover preserves the DOM');
      }
      const rowBox=await row.boundingBox();
      await row.click({position:{x:rowBox.width-4,y:rowBox.height-8}});
      await page.waitForFunction(()=>window.__QA__.clipboard.length>0);
      assert.equal(await page.evaluate(()=>window.__QA__.clipboard),await row.locator('.transcript-preview').textContent(),'Press feedback preserves the stretched row action');
      if(theme==='light' && reducedMotion==='no-preference') {
        const copy=row.getByRole('button',{name:'Copy transcript',exact:true});
        await copy.click();
        await page.waitForTimeout(900);
        await copy.click();
        await page.waitForTimeout(750);
        assert.equal(await copy.locator('.lucide-check').count(),1,'A repeated copy gets its own full feedback duration');
      }
      while(await page.getByRole('button',{name:'Dismiss notification',exact:true}).count())
        await page.getByRole('button',{name:'Dismiss notification',exact:true}).first().click();
      await page.waitForFunction(()=>!document.querySelector('.toast-slot'));
      // Crossfading widgets retain the tallest card and keep hidden controls inert.
      const stack=page.locator('.widget-stack');
      const stackRect=await rect(stack);
      for (let i=0;i<4;i++) {
        await page.getByRole('button',{name:'Next widget',exact:true}).click();
        assert.deepEqual(await rect(stack),stackRect,'Widget changes preserve height');
        assert.equal(await page.locator('.widget-surface:not(.is-active):not([inert])').count(),0);
      }
      await settle(stack);
      await page.locator('.page-scroll').evaluate(el=>{el.scrollTop=0;});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const chart=page.locator('.usage-chart');
      const box=await chart.boundingBox();
      for (const [x,y] of [[8,40],[box.width-8,40],[8,box.height-8]]) {
        await page.mouse.move(box.x+x,box.y+y);
        const tip=page.getByRole('tooltip');
        await tip.waitFor();
        const tipBox=await tip.boundingBox();
        assert.ok(tipBox.x>=box.x-1 && tipBox.x+tipBox.width<=box.x+box.width+1,'Tooltip stays inside chart during movement');
        assert.equal(await tip.evaluate(el=>getComputedStyle(el).transitionProperty),'none','Pointer tracking does not queue position transitions');
      }
      await page.mouse.move(0,0);
      await navigate(page,'Settings');
      await navigate(page,'Privacy & storage');
      const pane=page.locator('.preferences-scroll');
      const toggle=page.getByRole('switch',{name:'Attribute dictations to apps',exact:true});
      const toggleRect=await rect(toggle);
      const thumb=toggle.locator('.toggle-thumb');
      assert.equal(await thumb.evaluate(el=>getComputedStyle(el).transitionProperty),'transform');
      const before=await toggle.getAttribute('aria-checked');
      await toggle.click();
      await settle(thumb);
      assert.notEqual(await toggle.getAttribute('aria-checked'),before);
      assert.deepEqual(await rect(toggle),toggleRect,'Switching preserves layout');
      await pane.evaluate(el=>{el.scrollTop=180;});
      await page.evaluate(()=>new Promise(requestAnimationFrame));
      const savedScroll=await pane.evaluate(el=>el.scrollTop);
      assert.ok(savedScroll>0);
      await navigate(page,'Language');
      assert.equal(await pane.evaluate(el=>el.scrollTop),0,'A new category starts at its own position');
      await navigate(page,'Privacy & storage');
      assert.equal(await pane.evaluate(el=>el.scrollTop),savedScroll,'Returning restores category scroll');
      await navigate(page,'Language');
      const trigger=page.getByRole('combobox',{name:'Transcription language',exact:true});
      const triggerRect=await rect(trigger);
      const selected=await trigger.innerText();
      const paneScroll=await pane.evaluate(el=>el.scrollTop);
      for(let i=0;i<3;i++) {
        await trigger.click();
        const list=page.getByRole('listbox',{name:'Transcription language',exact:true});
        await settle(list);
        if(i===0) await page.screenshot({path:`${output}/dropdown-${theme}-${reducedMotion}.png`});
        await page.keyboard.press('End');
        assert.equal(await pane.evaluate(el=>el.scrollTop),paneScroll,'Keyboard dropdown navigation only scrolls the list');
        assert.deepEqual(await rect(trigger),triggerRect,'Opening does not move its trigger');
        await page.keyboard.press('Escape');
        assert.equal(await trigger.innerText(),selected,'Escape keeps the selection');
        assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
      }
      // Focus restoration must not scroll the content underneath a modal.
      await trigger.focus();
      await page.evaluate(()=>window.__QA__.emit('menu-reset-all-data',{}));
      const dialog=page.locator('.confirmation-dialog[open]');
      await dialog.waitFor();
      await settle(dialog);
      await page.keyboard.press('Escape');
      await page.locator('.confirmation-dialog[open]').waitFor({state:'detached'});
      assert.equal(await pane.evaluate(el=>el.scrollTop),paneScroll);
      assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
      // Theme changes commit without transitions between unrelated palette colors.
      await navigate(page,'Appearance');
      await page.getByRole('group',{name:'Appearance',exact:true}).getByRole('button',{name:theme==='light'?'Dark':'Light',exact:true}).click();
      await page.waitForFunction(()=>!document.documentElement.classList.contains('theme-changing'));
      assert.equal(await page.locator('main').evaluate(el=>el.getAnimations().length),0);
      await navigate(page,'History');
      await page.locator('[data-transcript-id="qa-49"]').waitFor();
      const historyList=page.locator('.history-list');
      await historyList.evaluate(el=>{el.scrollTop=460;});
      await page.evaluate(()=>new Promise(requestAnimationFrame));
      const historyScroll=await historyList.evaluate(el=>el.scrollTop);
      await navigate(page,'About');
      await navigate(page,'History');
      await page.locator('[data-transcript-id="qa-49"]').waitFor();
      assert.equal(await historyList.evaluate(el=>el.scrollTop),historyScroll,'Returning to History restores the list position after loading');
      await historyList.evaluate(el=>{el.scrollTop=0;});
      const menuButton=page.locator('.history-list .transcript-row').first().getByRole('button',{name:'More transcription actions',exact:true});
      await menuButton.click();
      await page.locator('.transcript-menu:popover-open').waitFor();
      await historyList.evaluate(el=>{el.scrollTop=40;});
      await page.locator('.transcript-menu:popover-open').waitFor({state:'detached'});
      // All screens must avoid accidental geometry transitions; reduced motion applies everywhere.
      for (const name of ['Overview','Apps','Dictionary','Shortcuts','System Check','About']) {
        await navigate(page,name);
        await settle(page.locator('main'));
        const issues=await page.locator('main').evaluate((main,reduced)=>[...main.querySelectorAll('*')].filter(el=>el.getClientRects().length).flatMap(el=>{
          const s=getComputedStyle(el), duration=Math.max(...s.transitionDuration.split(',').map(parseFloat));
          if(duration>0 && s.transitionProperty.split(',').some(p=>['all','left','top','width','height'].includes(p.trim())))return [`${el.className}: ${s.transitionProperty}`];
          if(reduced && duration>0.001)return [`Reduced motion: ${el.className}`];
          return [];
        }),reducedMotion==='reduce');
        assert.deepEqual(issues,[],`${name}: no unbounded/layout transitions`);
        const cursorIssues=await page.locator('body').evaluate(body=>[...body.querySelectorAll('button,a[href],summary,[role="option"],[role="button"]')].filter(el=>el.getClientRects().length && !el.closest('[inert]')).flatMap(el=>{
          const expected=el.matches(':disabled,[aria-disabled="true"]')?'not-allowed':'pointer';
          return getComputedStyle(el).cursor===expected?[]:[`${el.textContent.trim() || el.getAttribute('aria-label')}: ${getComputedStyle(el).cursor} (expected ${expected})`];
        }));
        assert.deepEqual(cursorIssues,[],`${name}: consistent action cursors`);
      }
      await page.screenshot({path:`${output}/${theme}-${reducedMotion}.png`});
      await page.setViewportSize({width:640,height:480});
      await navigate(page,'Settings');
      await navigate(page,'Language');
      await page.getByRole('combobox',{name:'Transcription language',exact:true}).click();
      const smallList=page.getByRole('listbox',{name:'Transcription language',exact:true});
      await settle(smallList);
      const smallBox=await smallList.boundingBox();
      assert.ok(smallBox.x>=0 && smallBox.y>=0 && smallBox.x+smallBox.width<=640 && smallBox.y+smallBox.height<=480,'Dropdown fits the minimum window with motion enabled');
      await page.keyboard.press('End');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.preferences-scroll').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
      await context.close();
      console.log(`Motion checks passed: ${theme}, ${reducedMotion}`);
    }
    const context=await browser.newContext({viewport:{width:380,height:70},reducedMotion});
    const capsule=await context.newPage();
    capsule.on('pageerror',error=>errors.push(error.message));
    await capsule.addInitScript(fixture,{});
    await capsule.goto(`${url}/capsule.html`);
    await capsule.waitForFunction(()=>window.__QA__?.calls.includes('plugin:event|listen'));
    await capsule.evaluate(()=>window.__QA__.emit('capsule-state',{state:'recording'}));
    await capsule.locator('.capsule-recording').waitFor();
    await capsule.evaluate(()=>window.__QA__.emit('capsule-state',{state:'idle'}));
    if(reducedMotion==='no-preference') await capsule.waitForTimeout(80);
    await capsule.evaluate(()=>window.__QA__.emit('capsule-state',{state:'recording'}));
    await capsule.waitForTimeout(360);
    assert.equal(await capsule.locator('.capsule-recording').count(),1,'An interrupted exit cannot hide a new recording');
    for(const state of ['transcribing','correcting','pasting','done','error']) {
      await capsule.evaluate(state=>window.__QA__.emit('capsule-state',{state,text:'A completed dictation',error:'Please try again'}),state);
      await capsule.locator('.capsule-pill').waitFor();
      assert.equal(await capsule.locator('.capsule-pill').evaluate(el=>{
        const bounds=el.getBoundingClientRect();
        return bounds.left>=0 && bounds.right<=innerWidth && getComputedStyle(el).overflowX==='hidden';
      }),true,'The morph stays in the panel and clips its outgoing content');
    }
    await capsule.screenshot({path:`${output}/capsule-${reducedMotion}.png`});
    await context.close();
  }
  assert.deepEqual(errors,[],'No runtime errors');
  console.log(`Motion audit passed in ${engine.name()}. Screenshots: ${output}`);
} finally { await browser?.close(); server.kill(); }
