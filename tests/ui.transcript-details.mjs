import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? (engine === webkit ? '1458' : '1457');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
const output = `artifacts/transcript-details-${engine.name()}`;
const original = 'How does Wursel team work? Does Wursel allow to link create ten projects with linked to ten different orgs with the different team members?';
const edited = original.replaceAll('Wursel', 'vercel');
let browser;
const errors = [];

function setupTranscripts({ original, edited }) {
  const qa = window.__QA__;
  const now = Date.now();
  Object.assign(qa.stores[2].transcripts[0], {
    rawText: original, pastedText: original, finalText: edited, deliveryStatus: 'pasted',
    application: {name:'Codex',bundleId:'com.openai.codex'},
  });
  qa.stores[3].corrections = [{
    correctionId:'repeated', transcriptId:'qa-0', timestamp:now, source:'edit',
    engine:'local', modelName:'Large Turbo Q5', language:'auto', wordCount:28,
    changedRatio:.07, rewrite:false,
    pairs:Array.from({length:2}, () => ({kind:'substitution',from:'Wursel',to:'vercel'})),
  }];
  qa.stores[4].entries.push({entryId:'vercel',right:'vercel',wrong:['Wursel'],enabled:true,origin:'learned',timesApplied:0,createdAt:now});
  Object.assign(qa.stores[2].transcripts[1], {
    rawText:'hi tory send notes', reformattedText:'Hi Tory,\n\nPlease send the notes.',
    pastedText:'Hi Tauri,\n\nPlease send the notes.', finalText:'Hi Tauri,\n\nPlease send the updated notes tomorrow.',
    deliveryStatus:'pasted', dictionaryApplied:[{from:'Tory',to:'Tauri'}],
    sttTimeMs:900, reformatTimeMs:200, pasteTimeMs:30, processingTimeMs:1200,
    reformatting:{schemaVersion:1,enabled:true,status:'applied',options:{styling:'formal',structure:'prose',context:'email'},
      requestedLanguage:'auto',detectedLanguage:'en',roundTripMs:200,modelLoadMs:0,prefillMs:50,decodeMs:120,
      tokensPerSecond:32.5,inputTokens:10,generatedTokens:6,inputWords:4,outputWords:7,inputCharacters:18,outputCharacters:30,changed:true},
  });
  qa.stores[3].corrections.push(
    { ...qa.stores[3].corrections[0],correctionId:'older',transcriptId:'qa-1',timestamp:now-1000,source:'observed',application:{name:'Mail'},rewrite:true,pairs:[{kind:'substitution',from:'note',to:'notes'}] },
    { ...qa.stores[3].corrections[0],correctionId:'many',transcriptId:'qa-1',timestamp:now,pairs:[
      {kind:'insertion',from:'',to:'updated'}, {kind:'insertion',from:'',to:'tomorrow'},
      {kind:'deletion',from:'old',to:''}, {kind:'substitution',from:'Tory',to:'Tauri'},
    ] },
  );
  const unchanged = qa.stores[2].transcripts[2];
  unchanged.pastedText = unchanged.rawText = unchanged.finalText;
  Object.assign(unchanged, {deliveryStatus:'verified', releaseToInsertionMs:1350, audioStopTimeMs:100, preparationTimeMs:20});
  qa.stores[2].transcripts[3].cloudRefinementStatus = 'applied';
  Object.assign(qa.stores[2].transcripts[3], {
    deliveryStatus:'unverified', attemptedText:qa.stores[2].transcripts[3].finalText,
    textValidation:{status:'fallback',reasons:['numbers_changed']},
  });
}

try {
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Preview did not start')),15000);
    server.stdout.on('data', chunk => { if(String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
  });
  await mkdir(output,{recursive:true});
  browser = await engine.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1080,height:760},reducedMotion:'reduce'});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({content:`(${fixture.toString()})({});(${setupTranscripts.toString()})(${JSON.stringify({original,edited})});`});
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading',{name:'Your dictation',exact:true}).waitFor();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'History',exact:true}).click();
  const pane = page.locator('.history-detail');
  const dialog = page.getByRole('dialog',{name:'Dictation details',exact:true});
  const openDetails = async () => {
    await pane.getByRole('button',{name:'More transcription actions',exact:true}).click();
    await pane.locator('.transcript-menu:popover-open').getByRole('button',{name:'Details',exact:true}).click();
    await dialog.waitFor();
  };
  const audit = async () => {
    const result = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(result.violations.map(v => ({id:v.id,nodes:v.nodes.map(n=>n.failureSummary)})),[]);
  };

  await page.locator('[data-transcript-id="qa-0"]').click();
  await pane.getByText('2 replacements',{exact:false}).waitFor();
  assert.equal(await pane.locator('.reading-text').textContent(),edited);
  assert.equal(await pane.locator('.reading-title').innerText(),'Transcript\n· Edited');
  assert.equal(await pane.locator('.correction-pair').count(),1,'Repeated substitutions are grouped without losing their count');
  assert.equal(await pane.locator('.correction-known').innerText(),'In dictionary');
  assert.equal(await pane.locator('.original-transcript').count(),0);
  assert.equal(await pane.getByText('Edited in Linty',{exact:false}).count(),0);
  await pane.getByRole('button',{name:'Copy transcript',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__QA__.clipboard),edited);
  await audit();
  await page.screenshot({path:`${output}/transcript-light.png`});
  await openDetails();
  for (const label of ['Speech engine','Model','Audio length','Words','Total processing','Speech recognition','Cloud refinement']) {
    assert.equal(await dialog.getByText(label,{exact:true}).count(),1,`${label} is preserved in Details`);
  }
  assert.equal(await dialog.locator('.text-version-content').count(),1,'Identical original and pasted snapshots appear once');
  const originalSummary = dialog.getByText('Original and pasted text',{exact:true});
  await page.keyboard.press('Tab');
  assert.equal(await originalSummary.evaluate(el=>el===document.activeElement),true,'Tab reaches the newly added disclosures');
  await page.keyboard.press('Enter');
  assert.equal(await dialog.locator('.text-version-content').innerText(),original);
  await dialog.locator('.transcript-edit-history summary').click();
  assert.equal(await dialog.locator('.correction-record').count(),1);
  await audit();
  await page.screenshot({path:`${output}/details-light.png`});
  await dialog.getByRole('button',{name:'Close dictation details',exact:true}).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.locator('.transcript-edit-history summary').evaluate(el=>el===document.activeElement),true,'Shift+Tab wraps to the last visible control');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.getByRole('button',{name:'Close dictation details',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Escape');
  assert.equal(await pane.getByRole('button',{name:'More transcription actions',exact:true}).evaluate(el=>el===document.activeElement),true);

  // No edit status or corrections section for untouched entries.
  await page.locator('[data-transcript-id="qa-2"]').click();
  assert.equal(await pane.locator('.reading-title').innerText(),'Transcript');
  assert.equal(await pane.locator('.correction-panel').count(),0);
  await openDetails();
  assert.match(await dialog.innerText(),/Insertion confirmed/);
  assert.match(await dialog.innerText(),/Stop request to confirmed insertion: 1.35 s/);
  assert.match(await dialog.innerText(),/Confirmed inserted text/);
  await page.keyboard.press('Escape');

  // All distinct text stages, formatting notes and detailed measurements survive the move.
  await page.locator('[data-transcript-id="qa-1"]').click();
  await pane.getByRole('button',{name:'View edit history',exact:true}).click();
  await dialog.locator('.transcript-edit-history[open]').waitFor();
  assert.equal(await dialog.locator('.correction-record').count(),2,'Older corrections remain available');
  assert.equal(await dialog.locator('.correction-pair').count(),5,'Changes beyond the compact summary remain available');
  assert.match(await dialog.innerText(),/Corrected in Mail/);
  assert.match(await dialog.innerText(),/rewrite, not used for learning/);
  for(const label of ['Model loading','Input processing','Text generation','Generation speed','Input / generated tokens','Words before / after','Language setting','Detected language','Layout']) {
    assert.equal(await dialog.getByText(label,{exact:true}).count(),1,`${label} is preserved`);
  }
  for(const disclosure of await dialog.locator('[aria-label="Text versions"] details').all()) {
    await disclosure.locator('summary').click();
  }
  assert.deepEqual(await dialog.locator('.text-version-content').allTextContents(),[
    'hi tory send notes','Hi Tory,\n\nPlease send the notes.','Hi Tauri,\n\nPlease send the notes.',
  ]);
  await dialog.getByText('Automatic changes',{exact:true}).click();
  assert.match(await dialog.innerText(),/Automatically reformatted this transcription/);
  assert.match(await dialog.innerText(),/Dictionary applied before paste: Tory → Tauri/);
  await dialog.getByRole('button',{name:'Add Tauri to dictionary, replacing Tory',exact:true}).click();
  await dialog.locator('.correction-known').waitFor();
  assert.equal(await page.evaluate(()=>window.__QA__.stores[4].entries.some(e=>e.right==='Tauri'&&e.wrong.includes('Tory'))),true);
  await audit();
  await page.screenshot({path:`${output}/details-all-stages.png`});

  for(const theme of ['dark','light']) {
    await page.evaluate(async theme => (await import('/src/store/app.store.ts')).useAppStore.getState().setTheme(theme),theme);
    await page.setViewportSize({width:640,height:480});
    assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
    await audit();
    await page.screenshot({path:`${output}/details-small-${theme}.png`});
  }
  await page.keyboard.press('Escape');
  assert.equal(await pane.getByRole('button',{name:'View edit history',exact:true}).evaluate(el=>el===document.activeElement),true);
  assert.equal(await pane.locator('.correction-pair').count(),3,'The main view limits the latest summary to three distinct changes');
  await page.setViewportSize({width:1080,height:760});

  // Row menus work even with the reading pane closed, including retrying unavailable history.
  await pane.getByRole('button',{name:'Back to history',exact:true}).click();
  await page.evaluate(()=>{window.__QA__.failures.history_corrections='Temporarily unavailable';});
  const row = page.locator('.transcript-row').filter({has:page.locator('[data-transcript-id="qa-0"]')});
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await row.getByRole('button',{name:'More transcription actions',exact:true}).click();
  await row.getByRole('button',{name:'Details',exact:true}).click();
  await dialog.locator('.transcript-edit-history summary').click();
  await dialog.getByRole('alert').waitFor();
  await page.evaluate(()=>{delete window.__QA__.failures.history_corrections;});
  await dialog.getByRole('button',{name:'Retry',exact:true}).click();
  await dialog.locator('.correction-pair').waitFor();
  await page.keyboard.press('Escape');

  // Older records with no paste snapshot keep their original and refinement note.
  await page.locator('[data-transcript-id="qa-3"]').click();
  await openDetails();
  assert.equal(await dialog.locator('.text-version-content').count(),2);
  await dialog.getByText('Automatic changes',{exact:true}).click();
  assert.match(await dialog.innerText(),/Automatically refined this transcription/);
  assert.equal(await dialog.getByText('Pasted text',{exact:true}).count(),0);
  assert.match(await dialog.innerText(),/Paste sent — insertion unconfirmed/);
  assert.match(await dialog.innerText(),/Original kept — cleanup changed protected details/);
  assert.equal(await dialog.getByText('Text sent for pasting',{exact:true}).count(),1);
  assert.doesNotMatch(await dialog.innerText(),/Stop request to confirmed insertion/);
  for (const theme of ['light','dark']) {
    await page.evaluate(async theme => (await import('/src/store/app.store.ts')).useAppStore.getState().setTheme(theme),theme);
    await audit();
    await page.screenshot({path:`${output}/delivery-unconfirmed-${theme}.png`});
  }
  assert.deepEqual(errors,[]);
  console.log(`Transcript view and Details passed (${engine.name()}).`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
