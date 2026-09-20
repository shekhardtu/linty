import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? (engine === webkit ? '1440' : '1439');
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const errors = [];
const failures = [];
const output = engine === webkit ? 'artifacts/ui-webkit' : 'artifacts/ui';
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UI preview did not start')), 15000);
    server.stdout.on('data', (chunk) => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
  });
  await mkdir(output, { recursive: true });
  browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1080, height: 760 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixture, {});
  await page.goto(url);
  await page.getByRole('heading', { name: 'Your dictation', exact: true }).waitFor();
  const audit = async (name) => {
    // A frame lets React commit state and the reduced-motion transition finish.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    if (result.violations.length) console.log(name, JSON.stringify(result.violations.map(v => ({id:v.id, nodes:v.nodes.map(n=>({target:n.target,detail:n.failureSummary}))}))));
    failures.push(...result.violations.map(v => ({ screen: name, id: v.id, targets: v.nodes.map(n => n.target), details: v.nodes.map(n => n.failureSummary) })));
    assert.equal(await page.locator('button button').count(), 0, `${name}: nested buttons`);
  };
  const screenshot = async (name) => {
    while (!(await page.getByRole('dialog').count()) && !(await page.locator(':popover-open').count()) && await page.getByRole('button', {name:'Dismiss notification',exact:true}).count()) await page.getByRole('button', {name:'Dismiss notification',exact:true}).first().click();
    return page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
  };
  const settingLabels = { general:'Dictation', audio:'Audio', language:'Language', appearance:'Appearance', privacy:'Privacy & storage' };
  const openSettingsSection = async (screen, name) => {
    const showSidebar = screen.getByRole('button', {name:'Show sidebar',exact:true});
    if (await showSidebar.count()) await showSidebar.click();
    await screen.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name,exact:true}).click();
  };
  const chooseOption = async (screen,label,option) => {
    await screen.getByRole('combobox',{name:label,exact:true}).click();
    await screen.getByRole('listbox',{name:label,exact:true}).getByRole('option',{name:option,exact:true}).click();
    if (label === 'Transcription language') await screen.waitForFunction(async expected => {
      const { useAppStore } = await import('/src/store/app.store.ts');
      const { languageLabel } = await import('/src/lib/languages.util.ts');
      return languageLabel(useAppStore.getState().transcriptionLanguage) === expected;
    }, option);
  };
  const checkOverviewRanges = async (screen) => {
    const ranges = screen.getByRole('group', {name:'Usage period'});
    await ranges.getByRole('button', {name:'7 days',exact:true}).click();
    const baseline = await screen.locator('.usage-chart').boundingBox();
    for (const range of ['30 days', 'All time', '7 days']) {
      await ranges.getByRole('button', {name:range,exact:true}).click();
      await screen.evaluate(() => new Promise(requestAnimationFrame));
      const chart = await screen.locator('.usage-chart').boundingBox();
      for (const dimension of ['width', 'height', 'x']) {
        assert.ok(Math.abs(chart[dimension] - baseline[dimension]) < 1, `${range}: chart ${dimension} stays stable`);
      }
      for (const selector of ['.page-scroll', '.overview-support', '.overview-activity', '.usage-chart']) {
        const overflow = await screen.locator(selector).evaluate(el => el.scrollWidth > el.clientWidth + 1);
        assert.equal(overflow, false, `${range}: ${selector} stays within its available width`);
      }
    }
  };
  await audit('overview-light'); await screenshot('overview-light');
  // The typing assumption is supplementary: available on hover/focus and editable from its info icon.
  const estimateInfo = page.getByRole('button',{name:'How time saved is estimated',exact:true});
  assert.equal(await page.getByText('Compared with typing at 40 wpm',{exact:true}).count(),0);
  const payoffBox = await page.locator('.payoff-summary').boundingBox();
  await estimateInfo.hover();
  await page.getByRole('tooltip').filter({hasText:'Compared with typing at 40 wpm'}).waitFor();
  assert.deepEqual(await page.locator('.payoff-summary').boundingBox(),payoffBox,'Hover explanation never changes summary geometry');
  await page.mouse.move(0,0);
  await estimateInfo.focus();
  await page.getByRole('tooltip').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tooltip').count(),0);
  await estimateInfo.click();
  const estimateDialog=page.getByRole('dialog',{name:'How this is estimated',exact:true});
  await estimateDialog.waitFor();
  await audit('estimate-details'); await screenshot('estimate-details');
  const typingField=estimateDialog.getByLabel('Typing speed for estimate');
  await typingField.fill('0');
  assert.equal(await estimateDialog.getByRole('button',{name:'Save typing speed',exact:true}).isDisabled(),true);
  await typingField.fill('60');
  await estimateDialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.evaluate(async()=>{const {useAppStore}=await import('/src/store/app.store.ts');return useAppStore.getState().typingWordsPerMinute;}),40,'Cancel retains the prior baseline');
  await estimateInfo.click();
  await typingField.fill('60');
  await page.evaluate(()=>{window.__QA__.failures['plugin:store|save']='Synthetic preferences failure';});
  await estimateDialog.getByRole('button',{name:'Save typing speed',exact:true}).click();
  await estimateDialog.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(()=>window.__QA__.stores[1].typingWordsPerMinute),40,'Failed save restores the persisted assumption');
  assert.equal(await typingField.inputValue(),'60','A failed save preserves the typing-speed draft for retry');
  await page.evaluate(()=>{delete window.__QA__.failures['plugin:store|save'];});
  await estimateDialog.getByRole('button',{name:'Save typing speed',exact:true}).click();
  await estimateDialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.__QA__.stores[1].typingWordsPerMinute),60);
  await estimateInfo.hover();
  await page.getByRole('tooltip').filter({hasText:'Compared with typing at 60 wpm'}).waitFor();
  await page.getByRole('button',{name:'History',exact:true}).click();
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await estimateInfo.hover();
  await page.getByRole('tooltip').filter({hasText:'Compared with typing at 60 wpm'}).waitFor();
  await estimateInfo.click();
  await typingField.fill('200');
  await estimateDialog.getByRole('button',{name:'Save typing speed',exact:true}).click();
  await page.getByText('Longer than typing estimate',{exact:true}).waitFor();
  await estimateInfo.click();
  await typingField.fill('40');
  await estimateDialog.getByRole('button',{name:'Save typing speed',exact:true}).click();
  await page.locator('.payoff-label').getByText('Estimated time saved',{exact:true}).waitFor();
  await page.getByRole('group',{name:'Usage period'}).getByRole('button',{name:'7 days',exact:true}).focus();
  await page.mouse.move(0,0);

  assert.equal(await page.locator('#app-sidebar').getByText('A little less typing', {exact:true}).count(), 1);
  assert.equal(await page.getByRole('main').getByText('A little less typing', {exact:true}).count(), 0);
  // Recent rows copy the full text, including clicks in empty space beneath the action icons.
  const recentRows = page.locator('.overview-transcripts .transcript-row');
  const copyCount = () => page.evaluate(() => window.__QA__.calls.filter(command => command === 'plugin:clipboard-manager|write_text').length);
  for (let i = 0; i < 5; i++) {
    const row = recentRows.nth(i);
    const expected = await row.locator('.transcript-preview').textContent();
    const before = await copyCount();
    const box = await row.boundingBox();
    await row.click({position:{x:box.width-4,y:box.height-8}});
    assert.equal(await page.evaluate(() => window.__QA__.clipboard), expected);
    assert.equal(await copyCount(), before + 1, 'A row click copies exactly once');
    assert.equal(await row.locator('.transcript-select').getAttribute('aria-pressed'), null, 'Copy is an action, not a toggle');
  }
  const firstRecent = recentRows.first();
  const firstRecentText = await firstRecent.locator('.transcript-preview').textContent();
  for (const key of ['Enter','Space']) {
    const before = await copyCount();
    await firstRecent.locator('.transcript-select').focus();
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => window.__QA__.clipboard), firstRecentText);
    assert.equal(await copyCount(), before + 1);
  }
  let beforeCopy = await copyCount();
  await firstRecent.getByRole('button',{name:'Copy transcript',exact:true}).click();
  assert.equal(await copyCount(), beforeCopy + 1, 'The separate copy icon does not trigger the row again');
  beforeCopy = await copyCount();
  await firstRecent.getByRole('button',{name:'Delete transcript',exact:true}).click();
  assert.equal(await copyCount(), beforeCopy, 'Delete never copies');
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await page.locator('.overview-transcripts [data-transcript-id="qa-0"]').waitFor();
  await page.evaluate(() => { window.__QA__.failures['plugin:clipboard-manager|write_text'] = 'Clipboard unavailable'; window.__QA__.clipboard = 'Existing clipboard'; });
  await firstRecent.locator('.transcript-select').click();
  await page.getByText('Could not copy transcription. Please try again.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.clipboard), 'Existing clipboard');
  await page.evaluate(() => { delete window.__QA__.failures['plugin:clipboard-manager|write_text']; });
  while (await page.getByRole('button', {name:'Dismiss notification',exact:true}).count()) await page.getByRole('button', {name:'Dismiss notification',exact:true}).first().click();
  await page.locator('.page-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.mouse.move(0,0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // One cursor-following tooltip stays above the bars and within the visible chart edges.
  const chart = page.getByRole('group', {name:'Words transcribed over time'});
  const plot = await chart.boundingBox();
  const settleTooltip = async () => {
    await page.getByRole('tooltip').waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.getByRole('tooltip').boundingBox();
  };
  await page.mouse.move(plot.x + 20, plot.y + 80);
  const firstTip = await settleTooltip();
  await page.mouse.move(plot.x + 36, plot.y + 95);
  const movedTip = await settleTooltip();
  assert.ok(movedTip.x > firstTip.x && movedTip.y > firstTip.y, 'Tooltip follows the cursor on both axes');
  for (const [x,y] of [[2,2], [plot.width-2,2], [2,plot.height-2], [plot.width-2,plot.height-2]]) {
    await page.mouse.move(plot.x+x, plot.y+y);
    const tooltip = await settleTooltip();
    assert.ok(tooltip.x >= plot.x && tooltip.x + tooltip.width <= plot.x + plot.width + 1, 'Tooltip respects horizontal edges');
    assert.ok(tooltip.y >= plot.y && tooltip.y + tooltip.height <= plot.y + plot.height + 1, 'Tooltip respects vertical edges');
  }
  const overlay = await page.getByRole('tooltip').evaluate(el => ({inOverlay:el.parentElement === document.body,zIndex:Number(getComputedStyle(el).zIndex),pointerEvents:getComputedStyle(el).pointerEvents}));
  assert.equal(overlay.inOverlay, true, 'Tooltip escapes the bars’ stacking contexts');
  assert.ok(overlay.zIndex > 1);
  assert.equal(overlay.pointerEvents, 'none', 'Tooltip does not interrupt pointer tracking');
  await screenshot('chart-tooltip-light');
  await page.mouse.move(0,0);
  assert.equal(await page.getByRole('tooltip').count(), 0);
  await chart.getByRole('button').first().focus();
  await page.getByRole('tooltip').waitFor();
  assert.equal(await chart.getByRole('button').first().getAttribute('aria-describedby'), await page.getByRole('tooltip').getAttribute('id'));
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tooltip').count(), 0);
  // The editorial reading column and its supporting activity stack stay distinct on desktop.
  assert.equal(await page.getByText('Processing details', {exact:true}).count(), 0);
  const readingColumn = await page.locator('.overview-transcripts').boundingBox();
  const supportingColumn = await page.getByRole('complementary', {name:'Activity and useful details'}).boundingBox();
  assert.ok(supportingColumn.x >= readingColumn.x + readingColumn.width, 'Overview has two desktop columns');
  const chartBox = await page.locator('.overview-activity').boundingBox();
  const appsBox = await page.locator('.overview-apps').boundingBox();
  const widgetBox = await page.getByRole('region', {name:'For your flow'}).boundingBox();
  assert.ok(chartBox.y < appsBox.y && appsBox.y < widgetBox.y, 'Activity, apps, then widgets in the supporting column');
  const period = page.getByRole('group', {name:'Usage period'});
  await period.getByRole('button', {name:'7 days',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await period.getByRole('button', {name:'30 days',exact:true}).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('group', {name:'Words transcribed over time'}).getByRole('button').count(), 30);
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', {name:'Show a little milestone',exact:true}).click();
  await page.getByRole('heading', {name:'1,000 words. Yours.',exact:true}).waitFor();
  await page.getByRole('button', {name:'Next widget',exact:true}).click();
  await page.getByRole('button', {name:'Your shortcuts',exact:true}).waitFor();
  await page.getByRole('button', {name:'Next widget',exact:true}).click();
  await page.getByText('1 suggestion ready to review.', {exact:true}).waitFor();
  await page.getByRole('button', {name:'Show your dictionary',exact:true}).click();
  await audit('overview-dictionary-widget'); await screenshot('overview-widgets-light');
  await page.getByRole('button', {name:'Open dictionary',exact:true}).click();
  await page.getByRole('main').getByRole('heading', {name:'Dictionary',exact:true}).waitFor();
  await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:'Overview',exact:true}).click();
  await page.getByRole('button', {name:'View all apps', exact:true}).click();
  await page.getByRole('main').getByRole('heading', {name:'Words, everywhere', exact:true}).waitFor();
  await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:'Overview',exact:true}).click();
  await page.keyboard.press('Meta+f');
  assert.equal(await page.locator('#history-search').evaluate(el => el === document.activeElement), true);
  await page.locator('#history-search').fill('zz-no-matches');
  await page.getByRole('heading', {name:'No results'}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#history-search').inputValue(), '');
  const checkHistoryHover = async () => {
    for (const row of (await page.locator('.history-list .transcript-row').all()).slice(0,3)) {
      await row.scrollIntoViewIfNeeded();
      await page.mouse.move(0,0);
      const geometry = () => row.evaluate(el => Array.from(el.querySelectorAll('.transcript-context, .transcript-preview, .transcript-metadata, .transcript-action')).map(node => node.getBoundingClientRect().toJSON()));
      const before = await geometry();
      await row.hover();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.deepEqual(await geometry(),before,'History hover never moves text or actions, including later rows');
    }
    await page.mouse.move(0,0);
  };
  await checkHistoryHover();
  assert.equal(await page.locator('.transcript-context').first().getByRole('img',{name:'Notes',exact:true}).getAttribute('title'),'Notes','Icon-only app identity exposes its name on hover and to assistive technology');
  await page.locator('.history-list').evaluate(el => { el.scrollTop=0; });
  const historyHeaderBox = await page.locator('.history-page-header').boundingBox();
  await audit('history-timeline-light'); await screenshot('history-timeline-light');
  await page.locator('[data-transcript-id]').first().click();
  assert.deepEqual(await page.locator('.history-page-header').boundingBox(),historyHeaderBox,'Opening a transcription keeps the header and search fixed');
  await checkHistoryHover();
  await page.locator('[data-transcript-id]').first().focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[data-transcript-id="qa-1"]').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Meta+c');
  assert.match(await page.evaluate(() => window.__QA__.clipboard), /thoughtful feedback/);
  await page.locator('.history-detail').getByRole('button', {name:'More transcription actions',exact:true}).click();
  await page.locator('.history-detail').getByLabel('Delete transcript', {exact:true}).click();
  assert.equal(await page.locator('[data-transcript-id="qa-1"]').count(), 0);
  await page.getByRole('button', {name:'Undo',exact:true}).click();
  await page.locator('[data-transcript-id="qa-1"]').waitFor();
  assert.equal(await page.locator('[data-transcript-id]').count(), 18);
  await page.locator('[data-transcript-id]').first().click();
  assert.equal(await page.getByRole('region', {name:'Corrections',exact:true}).count(), 0, 'Unchanged transcriptions have no empty corrections section');
  const originalText = await page.evaluate(() => window.__QA__.stores[2].transcripts.find(t=>t.transcriptId==='qa-0').rawText);
  assert.equal(await page.locator('.history-detail .original-transcript').count(),0,'The reading pane only shows the latest transcript');
  const overflow = page.locator('.history-detail').getByRole('button',{name:'More transcription actions',exact:true});
  await overflow.click();
  await page.locator('.transcript-menu:popover-open').getByRole('button',{name:'Details',exact:true}).click();
  const dictationDetails = page.getByRole('dialog',{name:'Dictation details',exact:true});
  await dictationDetails.locator('[aria-label="Text versions"] summary').click();
  assert.equal(await dictationDetails.locator('.text-version-content').textContent(),originalText,'Details preserves the original text even before an edit');
  await audit('history-details'); await screenshot('history-details');
  await page.keyboard.press('Escape');
  assert.equal(await overflow.evaluate(el => el === document.activeElement),true,'Closing Details returns focus to its trigger');
  await overflow.click();
  await audit('history-actions');
  const menuBox = await page.locator('.transcript-menu:popover-open').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= viewport.width && menuBox.y + menuBox.height <= viewport.height,'History actions remain within window edges');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.history-detail').count(),1,'Escape closes the action menu before the reading pane');
  assert.equal(await overflow.evaluate(el => el === document.activeElement),true,'Closing actions returns focus to the trigger');
  for (const selector of ['.history-page','.history-list','.history-detail']) assert.equal(await page.locator(selector).evaluate(el=>el.scrollWidth>el.clientWidth+1),false,`${selector} has no horizontal overflow`);
  await audit('history-light'); await screenshot('history-light');
  // Editing a transcript records the correction, shows the diff and offers to learn the word.
  await page.locator('.history-detail').getByLabel('Edit transcription', {exact:true}).click();
  const editor = page.getByLabel('Edit transcription text', {exact:true});
  await editor.fill((await editor.inputValue()).replace('experience', 'expereince'));
  await page.getByRole('button', {name:'Save', exact:true}).click();
  await page.getByText('Correction noted. I’ll keep learning from your edits.').waitFor();
  await page.locator('.correction-pair ins', {hasText:'expereince'}).waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.stores[3].corrections[0].pairs[0].from), 'experience');
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].suggestions.length), 2);
  await page.getByRole('button', {name:'Add expereince to dictionary, replacing experience', exact:true}).click();
  await page.getByText('“expereince” added to your dictionary').waitFor();
  await page.locator('.correction-known').waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.some(e => e.right === 'expereince' && e.wrong.includes('experience'))), true);
  await audit('history-correction'); await screenshot('history-correction');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.history-detail').count(), 0);
  await page.keyboard.press('Meta+k');
  await page.getByRole('combobox', {name:'Search Linty'}).fill('language');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.locator('.settings-language').waitFor();
  assert.equal(await page.locator('.window-toolbar [role=combobox]').count(), 0, 'Settings navigation lives in the sidebar');
  await chooseOption(page,'Transcription language','Spanish');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'es');
  const languageSelect = page.getByRole('combobox',{name:'Transcription language',exact:true});
  const languageGeometry = await languageSelect.boundingBox();
  await languageSelect.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('listbox',{name:'Transcription language',exact:true}).waitFor();
  await audit('language-dropdown'); await screenshot('language-dropdown');
  assert.deepEqual(await languageSelect.boundingBox(),languageGeometry,'Opening a dropdown keeps trigger geometry fixed');
  await page.getByRole('combobox', {name:'Search languages',exact:true}).fill('English');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__QA__.stores[1].transcriptionLanguage === 'en');
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage),'en','Typeahead selects English');
  await languageSelect.click();
  await page.keyboard.press('End'); await page.keyboard.press('Escape');
  assert.equal(await languageSelect.innerText(),'English','Escape leaves the saved selection unchanged');
  assert.equal(await languageSelect.evaluate(el=>el === document.activeElement),true,'Dropdown dismissal retains keyboard focus');
  await chooseOption(page,'Transcription language','Spanish');

  for (const theme of ['light', 'dark']) {
    await openSettingsSection(page,settingLabels['appearance']);
    await page.getByRole('button', {name: theme === 'light' ? 'Light' : 'Dark', exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    if (theme === 'light') {
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      assert.equal(await page.getByRole('button', {name:'Dark',exact:true}).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    }
    for (const section of ['general', 'audio', 'language', 'appearance', 'privacy']) {
      await openSettingsSection(page,settingLabels[section]);
      await audit(`${section}-${theme}`);
      if (section === 'audio') {
        const input = page.getByRole('combobox', { name: 'Input device', exact: true });
        await page.waitForFunction(() => !document.querySelector('[role="combobox"][aria-label="Input device"]').disabled);
        await chooseOption(page, 'Input device', 'USB Microphone');
        await page.getByRole('heading', { name: 'USB Microphone', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__QA__.stores[1].audioInputName), 'USB Microphone');
        // A native tray selection updates Settings without remounting the page.
        await page.evaluate(() => {
          window.__QA__.audioInputs.selected = 'Built-in Microphone';
          window.__QA__.emit('audio-input-changed', structuredClone(window.__QA__.audioInputs));
        });
        await page.getByRole('heading', { name: 'Built-in Microphone', exact: true }).waitFor();
        await page.evaluate(() => { window.__QA__.failures.set_audio_input = 'Could not save microphone selection'; });
        await chooseOption(page, 'Input device', 'USB Microphone');
        await page.getByRole('main').getByText('Could not save microphone selection', { exact: true }).waitFor();
        assert.equal(await input.innerText(), 'Built-in Microphone', 'A failed selection retains the confirmed microphone');
        await page.evaluate(async () => {
          delete window.__QA__.failures.set_audio_input;
          const { useAppStore } = await import('/src/store/app.store.ts');
          useAppStore.getState().setIsRecording(true);
        });
        assert.equal(await input.isDisabled(), true, 'Input selection is disabled during capture');
        await page.evaluate(async () => {
          const { useAppStore } = await import('/src/store/app.store.ts');
          useAppStore.getState().setIsRecording(false);
          window.__QA__.audioInputs.selected = 'Disconnected Microphone';
          window.__QA__.emit('audio-input-changed', structuredClone(window.__QA__.audioInputs));
        });
        await page.getByText('Your selected microphone is unavailable or has an ambiguous name. Choose another input or System Default.', { exact: true }).waitFor();
        assert.equal(await input.innerText(), 'Disconnected Microphone (Unavailable)');
        await chooseOption(page, 'Input device', 'System Default — Built-in Microphone');
        await page.getByRole('heading', { name: 'System microphone', exact: true }).waitFor();
        await screenshot(`audio-${theme}`);
      }
      if (section === 'language') {
        const dropdown=page.getByRole('combobox',{name:'Transcription language',exact:true});
        await dropdown.click();
        await audit(`dropdown-${theme}`); await screenshot(`dropdown-${theme}`);
        const bounds=await page.getByRole('listbox',{name:'Transcription language',exact:true}).boundingBox();
        const windowSize=page.viewportSize();
        assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=windowSize.width && bounds.y+bounds.height<=windowSize.height,'Dropdown stays within the window');
        await page.keyboard.press('Escape');
        if (theme === 'light') {
          const chooseTrayLanguage = async (language) => {
            const before = await page.evaluate(() => window.__QA__.emittedEvents.filter(e => e.event === 'tray-language-result').length);
            await page.evaluate(code => window.__QA__.emit('tray-language-changed', code), language);
            await page.waitForFunction(count => window.__QA__.emittedEvents.filter(e => e.event === 'tray-language-result').length > count, before);
          };
          await chooseTrayLanguage('fr');
          assert.equal(await dropdown.innerText(), 'French', 'Tray changes update Settings');
          assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'fr');
          await page.waitForFunction(() => window.__QA__.emittedEvents.filter(e => e.event === 'tray-state-changed').at(-1)?.payload.transcriptionLanguage === 'fr');
          const trayLanguages = await page.evaluate(() => window.__QA__.emittedEvents.filter(e => e.event === 'tray-state-changed').at(-1).payload.languages);
          await dropdown.click();
          assert.deepEqual(await page.getByRole('listbox', {name:'Transcription language',exact:true}).getByRole('option').evaluateAll(elements => elements.map(el => el.getAttribute('aria-label'))), trayLanguages.map(language => language.label), 'Tray and Settings share language choices');
          await page.keyboard.press('Escape');
          await chooseOption(page, 'Transcription language', 'German');
          await page.waitForFunction(() => window.__QA__.emittedEvents.filter(e => e.event === 'tray-state-changed').at(-1)?.payload.transcriptionLanguage === 'de');
          await page.evaluate(() => { window.__QA__.failures['plugin:store|save'] = 'Language preferences could not be saved'; });
          await chooseTrayLanguage('fr');
          assert.equal(await page.locator('.language-feature h3').innerText(), 'GermanDeutsch', 'Failed tray saves retain the active language');
          assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'de');
          await page.evaluate(async () => {
            delete window.__QA__.failures['plugin:store|save'];
            (await import('/src/store/app.store.ts')).useAppStore.getState().setIsRecording(true);
          });
          await chooseTrayLanguage('fr');
          assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'de', 'Language cannot change during dictation');
          assert.equal(await dropdown.isDisabled(), true);
          await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().setIsRecording(false));
          await chooseTrayLanguage('xx');
          assert.equal(await page.evaluate(() => window.__QA__.stores[1].transcriptionLanguage), 'de', 'Unsupported tray values are rejected');
          await chooseTrayLanguage('auto');
          assert.equal(await dropdown.innerText(), 'Auto-detect');
          await chooseTrayLanguage('es'); // Restore the shared fixture for later cancellation checks.
        }
      }

      if (section === 'privacy' || section === 'appearance' || section === 'language') await screenshot(`${section}-${theme}`);
      if (section === 'privacy') {
        const processing = page.locator('details', {has:page.getByText('Processing details', {exact:true})});
        assert.equal(await processing.evaluate(el => el.open), false);
        await processing.locator('summary').click();
        const engines = processing.getByRole('table', {name:'Processing by speech engine'});
        assert.equal(await engines.getByRole('row', {name:/On-device/}).getByRole('cell').first().innerText(), '13');
        assert.equal(await engines.getByRole('row', {name:/Previous version/}).getByRole('cell').first().innerText(), '5');
        await processing.getByRole('button', {name:'All time',exact:true}).click();
        await audit(`processing-${theme}`); await screenshot(`processing-${theme}`);
        await processing.locator('summary').click();
      }
    }
    for (const name of ['Overview', 'History', 'Apps', 'Dictionary', 'Shortcuts', 'System Check', 'About']) {
      await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name,exact:true}).click();
      await audit(`${name}-${theme}`);
      if (name === 'Overview') {
        await checkOverviewRanges(page);
        await page.getByRole('group', {name:'Usage period'}).getByRole('button', {name:'30 days',exact:true}).click();
        await screenshot(`overview-30-days-${theme}`);
        await page.getByRole('group', {name:'Usage period'}).getByRole('button', {name:'7 days',exact:true}).click();
        await screenshot(`overview-${theme}`);
      }
      if (name === 'History') {
        await screenshot(`history-timeline-${theme}`);
        await page.locator('[data-transcript-id]').first().click();
        await audit(`history-selected-${theme}`); await screenshot(`history-selected-${theme}`);
        await checkHistoryHover();
        await page.getByRole('button',{name:'Back to history',exact:true}).click();
      }
      if (name === 'Apps') {
        await screenshot(`apps-${theme}`);
        const distribution=await page.getByRole('img',{name:/Share of all words by app/}).getAttribute('aria-label');
        await chooseOption(page,'Sort applications','Last used');
        assert.equal(await page.getByRole('img',{name:/Share of all words by app/}).getAttribute('aria-label'),distribution,'Table sorting does not re-rank distribution colors');
        await chooseOption(page,'Sort applications','Words');
        assert.equal(await page.locator('.apps-page').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'Application usage fits its page');
        await page.getByRole('button',{name:'Privacy settings',exact:true}).click();
        assert.equal(await page.locator('.settings-privacy').isVisible(),true);
      }
      if (name === 'Dictionary') {
        const tableOverflow = await page.locator('.dictionary-entries .app-table-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1);
        assert.equal(tableOverflow, false, 'Dictionary words and controls fit at desktop size');
        await screenshot(`dictionary-${theme}`);
      }
    }
    await page.keyboard.press('Meta+,');
  }
  // A disconnected input must not leave the recording/hotkey state locked.
  await page.evaluate(() => {
    window.__QA__.failures.start_dictation = 'Selected microphone is unavailable';
    window.__QA__.emit('fnkey-pressed');
  });
  await page.getByText('Selected microphone is unavailable', {exact:true}).first().waitFor();
  assert.equal(await page.evaluate(async () => (await import('/src/store/app.store.ts')).useAppStore.getState().isRecording), false);
  await page.evaluate(async () => {
    delete window.__QA__.failures.start_dictation;
    (await import('/src/store/app.store.ts')).useAppStore.getState().resetTranscription();
    window.__QA__.calls = [];
    window.__QA__.originalMicInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'start_dictation') return new Promise(resolve => { window.__QA__.finishMicStart = resolve; });
      return window.__QA__.originalMicInvoke(command, args);
    };
    window.__QA__.emit('fnkey-pressed');
  });
  await page.waitForFunction(() => Boolean(window.__QA__.finishMicStart));
  await page.evaluate(() => window.__QA__.emit('fnkey-released'));
  assert.equal(await page.evaluate(() => window.__QA__.calls.includes('stop_dictation')), false, 'Quick release waits for microphone startup');
  await page.evaluate(() => window.__QA__.finishMicStart());
  const recordingStore = await page.evaluateHandle(async () => (await import('/src/store/app.store.ts')).useAppStore);
  await page.waitForFunction(store => {
    const state = store.getState();
    return window.__QA__.calls.includes('stop_dictation') && !state.isRecording && state.status === 'idle';
  }, recordingStore);
  await page.evaluate(() => { window.__TAURI_INTERNALS__.invoke = window.__QA__.originalMicInvoke; });

  // Expose recoverable failures from the same commands used by the desktop app.
  await page.getByRole('button', {name:'About',exact:true}).click();
  await page.evaluate(() => { window.__QA__.failures['check_for_update'] = 'Offline'; });
  await page.getByRole('button', {name:'Check for updates',exact:true}).click();
  await page.getByText('Could not check for updates. Check your connection and try again.').waitFor();
  await audit('update-error');
  await page.evaluate(() => { delete window.__QA__.failures['check_for_update']; });
  await page.getByRole('button', {name:'Retry',exact:true}).click();
  await page.getByText('You’re using the latest version of Linty.').waitFor();
  // Dictionary page: accept a suggestion, add a word by hand, pause one, and see the learning switches.
  await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:'Dictionary',exact:true}).click();
  await page.getByRole('main').getByRole('heading', {name:'Dictionary', exact:true}).waitFor();
  await page.locator('.dictionary-row', {hasText:'Tauri'}).getByRole('button', {name:'Add', exact:true}).click();
  await page.getByText('“Tauri” added to your dictionary').waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.some(e => e.right === 'Tauri' && e.wrong.includes('Tory'))), true);
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].suggestions.some(s => s.right === 'Tauri')), false);
  await page.locator('#dictionary-right').fill('Zustand');
  await page.locator('#dictionary-wrong').fill('Zoo stand, Sustained');
  await page.getByRole('button', {name:'Add to dictionary', exact:true}).click();
  await page.getByText('“Zustand” added to your dictionary').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__QA__.stores[4].entries.find(e => e.right === 'Zustand').wrong), ['Zoo stand', 'Sustained']);
  await page.getByRole('switch', {name:'Disable Linty', exact:true}).click();
  await page.getByRole('switch', {name:'Enable Linty', exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.find(e => e.right === 'Linty').enabled), false);
  await page.getByRole('button', {name:'Remove Zustand', exact:true}).click();
  await page.getByText('“Zustand” removed').waitFor();
  await audit('dictionary-edited'); await screenshot('dictionary-edited');
  await page.keyboard.press('Meta+,');
  await openSettingsSection(page,settingLabels['privacy']);
  await page.getByRole('switch', {name:'Learn new words automatically', exact:true}).click();
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].autoLearnWords), true);
  await page.getByRole('switch', {name:'Apply my dictionary', exact:true}).click();
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].dictionaryEnabled), false);
  await page.getByRole('switch', {name:'Apply my dictionary', exact:true}).click();
  await page.getByRole('switch', {name:'Learn from corrections in other apps', exact:true}).click();
  assert.equal(await page.evaluate(() => window.__QA__.stores[1].observeCorrections), true);
  await screenshot('privacy-light');
  // A verified native batch records a reusable spelling correction in History
  // and learns it once when automatic learning is enabled.
  await page.evaluate(() => window.__QA__.emit('correction-observed', { batchId: 'smoke-observed-session', corrections: [{ transcriptId: 'qa-3', wordCount: 8, application: { name: 'Safari', bundleId: 'com.apple.Safari' }, pairs: [{ kind: 'substitution', from: 'Taury', to: 'Tauri' }], secondsAfterPaste: 9 }] }));
  await page.waitForFunction(() => window.__QA__.correctionFeedback.at(-1)?.title === 'Correction learned');
  assert.equal(await page.evaluate(() => window.__QA__.stores[3].corrections[0].source), 'observed');
  assert.equal(await page.evaluate(() => window.__QA__.stores[4].entries.find(e => e.right === 'Tauri').wrong.includes('Taury')), true);
  await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:'History',exact:true}).click();
  await page.locator('[data-transcript-id="qa-3"]').click();
  await page.getByText('Corrected in Safari').waitFor();
  await page.locator('.correction-pair ins', {hasText:'Tauri'}).waitFor();
  await audit('history-observed'); await screenshot('history-observed');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+,');
  await openSettingsSection(page,settingLabels['privacy']);
  // Native reset-menu event opens an inert dialog; cancellation restores focus.
  await page.getByRole('button',{name:'Hide sidebar',exact:true}).focus();
  await page.evaluate(() => window.__QA__.emit('menu-reset-all-data', {}));
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('button', {name:'Cancel',exact:true}).evaluate(el => el === document.activeElement), true);
  for (let i=0; i<5; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
  await audit('reset-dialog'); await screenshot('reset-dialog');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('button',{name:'Hide sidebar',exact:true}).evaluate(el=>el === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.__QA__.calls.includes('reset_all_data')), false);
  await page.getByRole('button', {name:'Hide sidebar',exact:true}).click();
  assert.equal(await page.locator('#app-sidebar').count(), 0);
  await page.keyboard.press('Control+Meta+s');
  await page.locator('#app-sidebar').waitFor();
  // Original minimum window size: every preference remains reachable without horizontal overflow.
  await page.getByRole('button', {name:'Overview',exact:true}).click();
  await page.setViewportSize({ width:900, height:760 });
  await checkOverviewRanges(page);
  await page.keyboard.press('Meta+,');
  await page.setViewportSize({ width:640, height:480 });
  for (const section of ['general','audio','language','appearance','privacy']) {
    await openSettingsSection(page,settingLabels[section]);
    const overflow = await page.locator('.preferences-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false, `${section}: horizontal overflow at 640 × 480`);
    if (section === 'language') {
      const trigger=page.getByRole('combobox',{name:'Transcription language',exact:true});
      await trigger.click();
      assert.equal(await page.getByRole('combobox', {name:'Search languages',exact:true}).evaluate(el=>el===document.activeElement),true,'Opening the language picker focuses search on macOS');
      const bounds=await page.getByRole('listbox',{name:'Transcription language',exact:true}).boundingBox();
      assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=640 && bounds.y+bounds.height<=480,'Long language list fits the minimum window');
      await page.keyboard.press('End');
      await screenshot('dropdown-small');
      await page.keyboard.press('Escape');
      assert.equal(await trigger.innerText(),'Spanish','Narrow dropdown cancellation keeps the prior setting');
    }

  }
  await screenshot('settings-small');
  for (const name of ['Overview', 'Apps', 'Dictionary', 'Shortcuts', 'System Check', 'About']) {
    await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name,exact:true}).click();
    const overflow = await page.locator('.page-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false, `${name}: horizontal overflow at 640 × 480`);
    if (name === 'Overview') await checkOverviewRanges(page);
    await audit(`${name}-small`);
    if (name === 'Overview' || name === 'Dictionary') await screenshot(`${name.toLowerCase()}-small`);
  }
  await page.getByRole('button',{name:'History',exact:true}).click();
  await page.locator('[data-transcript-id="qa-0"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Transcription text');
  assert.equal(await page.locator('.history-detail').evaluate(el=>el.scrollTop),0,'Opening narrow detail keeps the app icon, actions and back control visible');
  await screenshot('history-small'); await audit('history-small');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-transcript-id') === 'qa-0');
  await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Back to history',exact:true}).click();
  assert.equal(await page.locator('.history-list').isVisible(), true);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-transcript-id') === 'qa-0');
  await context.close();
  // Undo retries a failed save and merges the deleted record with newer dictations.
  const recoveryContext = await browser.newContext({ viewport:{width:1080,height:760}, reducedMotion:'reduce' });
  const recovery = await recoveryContext.newPage();
  recovery.on('pageerror', error => errors.push(error.message));
  await recovery.addInitScript(fixture, {});
  await recovery.goto(url);
  await recovery.getByRole('button',{name:'History',exact:true}).click();
  await recovery.locator('[data-transcript-id="qa-0"]').click();
  await recovery.locator('.history-detail').getByRole('button', {name:'More transcription actions',exact:true}).click();
  await recovery.locator('.history-detail').getByLabel('Delete transcript',{exact:true}).click();
  await recovery.getByRole('button',{name:'Undo',exact:true}).waitFor();
  await recovery.evaluate(async () => {
    const { saveTranscript } = window.__QA__;
    await saveTranscript({ ...window.__QA__.stores[2].transcripts[0], transcriptId:'qa-new', timestamp:Date.now(), finalText:'A newer dictation must be preserved.' });
    window.__QA__.failures['history_restore'] = 'Disk unavailable';
  });
  await recovery.getByRole('button',{name:'Undo',exact:true}).click();
  await recovery.getByText('Could not restore transcript. Try Undo again.').waitFor();
  assert.equal(await recovery.locator('[data-transcript-id="qa-0"]').count(), 0);
  await recovery.evaluate(() => { delete window.__QA__.failures['history_restore']; });
  await recovery.getByRole('button',{name:'Undo',exact:true}).click();
  await recovery.locator('[data-transcript-id="qa-0"]').waitFor();
  assert.equal(await recovery.locator('[data-transcript-id]').count(), 19);
  assert.equal(await recovery.locator('[data-transcript-id]').first().getAttribute('data-transcript-id'), 'qa-new');
  assert.equal(await recovery.evaluate(() => new Set(window.__QA__.stores[2].transcripts.map(record => record.transcriptId)).size), 19);
  // Sparse saved history can span many years; all-time bars must still fit the column.
  await recovery.evaluate(async () => {
    const { saveTranscript } = window.__QA__;
    const date = new Date(); date.setFullYear(date.getFullYear() - 10);
    await saveTranscript({ ...window.__QA__.stores[2].transcripts[0], transcriptId:'qa-older', timestamp:date.getTime(), finalText:'An older saved dictation.' });
  });
  await recovery.getByRole('button', {name:'Overview',exact:true}).click();
  await checkOverviewRanges(recovery);
  await recoveryContext.close();
  // A lifetime archive stays searchable and contributes to totals beyond the old 500-record cap.
  const archiveContext = await browser.newContext({viewport:{width:1080,height:760},reducedMotion:'reduce'});
  const archive = await archiveContext.newPage();
  archive.on('pageerror', error => errors.push(error.message));
  await archive.addInitScript(fixture,{historyCount:605});
  await archive.goto(url);
  await archive.getByRole('group',{name:'Usage period'}).getByRole('button',{name:'All time',exact:true}).click();
  const expectedWords = await archive.evaluate(() => window.__QA__.stores[2].transcripts.reduce((n,t)=>n+t.wordCount,0).toLocaleString());
  await archive.getByRole('region',{name:'Dictation summary'}).getByText(expectedWords,{exact:true}).waitFor();
  assert.equal(await archive.evaluate(async()=>{const {useAppStore}=await import('/src/store/app.store.ts');return useAppStore.getState().transcripts.length;}),20,'Only a bounded recent cache enters the app store');
  await archive.getByText('Based on all your saved transcriptions.',{exact:true}).waitFor();
  await archive.getByRole('button',{name:'History',exact:true}).click();
  await archive.locator('[data-transcript-id="qa-49"]').waitFor();
  assert.equal(await archive.locator('[data-transcript-id]').count(),50);
  await archive.getByRole('navigation',{name:'History pages'}).getByText('Page 1 of 13',{exact:true}).waitFor();
  await archive.locator('[data-transcript-id="qa-0"]').click();
  await archive.getByRole('navigation',{name:'History pages'}).scrollIntoViewIfNeeded();
  assert.equal(await archive.locator('.history-list').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'Pagination fits the compact history index');
  await archive.getByRole('button',{name:'Back to history',exact:true}).click();
  await archive.getByRole('button',{name:'Next',exact:true}).click();
  await archive.locator('[data-transcript-id="qa-50"]').waitFor();
  assert.equal(await archive.locator('[data-transcript-id]').count(),50);
  assert.equal(await archive.locator('[data-transcript-id="qa-0"]').count(),0);
  await archive.getByRole('button',{name:'Previous',exact:true}).click();
  await archive.locator('[data-transcript-id="qa-0"]').waitFor();
  await archive.evaluate(async()=>{const {updateTranscript}=await import('/src/services/history.service.ts');await updateTranscript('qa-604',{finalText:'An older archive reference 604.'});});
  await archive.locator('#history-search').fill('archive reference 604');
  await archive.locator('[data-transcript-id="qa-604"]').waitFor();
  assert.equal(await archive.locator('[data-transcript-id]').count(),1,'Search includes older pages');
  await archive.locator('[data-transcript-id="qa-604"]').click();
  assert.equal(await archive.locator('.history-list').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'Selected archive index stays within its column');
  await archive.locator('.history-detail').getByRole('button',{name:'Copy transcript',exact:true}).click();
  assert.equal(await archive.evaluate(()=>window.__QA__.clipboard),'An older archive reference 604.');
  await archive.evaluate(()=>{window.__QA__.failures.history_query='Synthetic query failure';});
  await archive.locator('#history-search').fill('retry-search');
  await archive.getByRole('alert').filter({hasText:'Synthetic query failure'}).waitFor();
  await archive.evaluate(()=>{delete window.__QA__.failures.history_query;});
  await archive.getByRole('button',{name:'Retry',exact:true}).click();
  await archive.getByRole('heading',{name:'No results',exact:true}).waitFor();
  await archive.keyboard.press('Meta+,');
  await openSettingsSection(archive,settingLabels['privacy']);
  const retention=archive.getByRole('combobox',{name:'History retention',exact:true});
  assert.equal(await retention.innerText(),'Until I delete it');
  await archive.evaluate(()=>{window.__QA__.cancelExport=true;});
  await archive.getByRole('button',{name:'Export history…',exact:true}).click();
  assert.equal(await archive.evaluate(()=>!!window.__QA__.exported),false,'Cancelling export leaves the archive untouched');
  await archive.evaluate(()=>{window.__QA__.cancelExport=false;window.__QA__.failures.history_export='Synthetic export failure';});
  await archive.getByRole('button',{name:'Export history…',exact:true}).click();
  await archive.getByText(/Could not export history/).waitFor();
  await archive.evaluate(()=>{delete window.__QA__.failures.history_export;});
  await archive.getByRole('button',{name:'Export history…',exact:true}).click();
  await archive.getByText('Exported 605 transcriptions.',{exact:true}).waitFor();
  assert.equal(await archive.evaluate(()=>window.__QA__.exported.transcripts.length),605,'Export includes the whole archive');
  assert.equal(await archive.evaluate(()=>window.__QA__.exported.corrections.length),1);
  await chooseOption(archive,'History retention','30 days');
  await archive.getByRole('dialog').waitFor();
  assert.equal(await archive.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true);
  for (let i=0;i<5;i++) await archive.keyboard.press('Tab');
  assert.equal(await archive.evaluate(()=>!!document.activeElement?.closest('dialog')),true,'Retention dialog contains keyboard focus');
  const retentionAudit = await new AxeBuilder({page:archive}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  failures.push(...retentionAudit.violations.map(v=>({screen:'history-retention-dialog',id:v.id})));
  await archive.screenshot({path:`${output}/history-retention.png`,animations:'disabled'});
  await archive.keyboard.press('Escape');
  await archive.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await archive.evaluate(()=>window.__QA__.stores[2].transcripts.length),605,'Cancel does not change retention or delete history');
  assert.equal(await retention.innerText(),'Until I delete it');
  await chooseOption(archive,'History retention','30 days');
  await archive.getByRole('dialog').waitFor();
  await archive.evaluate(()=>{window.__QA__.failures.history_set_retention='Synthetic retention failure';});
  await archive.getByRole('button',{name:'Apply retention',exact:true}).click();
  await archive.getByText(/Could not update saved history/).waitFor();
  assert.equal(await archive.evaluate(()=>window.__QA__.stores[2].transcripts.length),605);
  await archive.evaluate(()=>{delete window.__QA__.failures.history_set_retention;});
  await archive.getByRole('button',{name:'Apply retention',exact:true}).click();
  await archive.getByRole('dialog').waitFor({state:'hidden'});
  const retained=await archive.evaluate(()=>window.__QA__.stores[2].transcripts.length);
  assert.ok(retained>0&&retained<605);
  assert.equal(await retention.innerText(),'30 days');
  await archive.getByRole('button',{name:'Overview',exact:true}).click();
  await archive.getByText('Based on retained history with a 30-day retention period.',{exact:true}).waitFor();
  await archive.keyboard.press('Meta+,');
  await chooseOption(archive,'History retention','Until I delete it');
  await archive.getByText('History will be kept until you delete it.',{exact:true}).waitFor();
  assert.equal(await archive.evaluate(()=>window.__QA__.stores[2].transcripts.length),retained,'Longer retention does not resurrect deleted data');
  await archive.getByRole('button',{name:'Clear history…',exact:true}).click();
  await archive.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await archive.evaluate(()=>window.__QA__.stores[2].transcripts.length),retained);
  await archive.getByRole('button',{name:'Clear history…',exact:true}).click();
  await archive.getByRole('button',{name:'Clear history',exact:true}).click();
  await archive.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await archive.evaluate(()=>window.__QA__.stores[2].transcripts.length),0);
  assert.equal(await archive.evaluate(()=>window.__QA__.stores[3].corrections.length),0);
  assert.equal(await archive.evaluate(()=>window.__QA__.stores[4].entries.length),1,'Clearing history keeps the dictionary');
  await archive.getByRole('button',{name:'History',exact:true}).click();
  await archive.getByRole('heading',{name:'No transcriptions yet',exact:true}).waitFor();
  await archiveContext.close();
  const fresh = await browser.newContext({ viewport:{width:640,height:480}, reducedMotion:'reduce' });
  const setup = await fresh.newPage();
  setup.on('pageerror', error => errors.push(error.message));
  await setup.addInitScript(fixture,{onboarding:true,empty:true});
  await setup.goto(url);
  await setup.getByRole('button',{name:'Get Started'}).waitFor();
  await setup.screenshot({path:`${output}/onboarding-small.png`,animations:'disabled'});
  await setup.getByRole('button',{name:'Get Started'}).click();
  await setup.getByRole('combobox',{name:'Dictation language',exact:true}).waitFor();
  await setup.getByRole('button',{name:'Continue',exact:true}).click();
  await setup.getByRole('heading',{name:'Choose Your Trigger Key'}).waitFor();
  await setup.getByRole('button',{name:'Continue',exact:true}).click();
  await setup.getByRole('button',{name:'Start Using Linty'}).waitFor();
  await setup.getByRole('button',{name:'Start Using Linty'}).click();
  await setup.getByText('Ready for your first dictation').waitFor();
  assert.equal(await setup.getByRole('region', {name:'Dictation summary'}).getByText('0', {exact:true}).count(), 1);
  await setup.getByRole('button', {name:'Show your dictionary',exact:true}).click();
  await setup.getByText('Add names and terms you use often, so Linty gets them right.', {exact:true}).waitFor();
  await setup.screenshot({path:`${output}/overview-empty.png`,animations:'disabled'});
  await setup.getByRole('button',{name:'History',exact:true}).click();
  await setup.getByRole('heading',{name:'No transcriptions yet'}).waitFor();
  await setup.screenshot({path:`${output}/history-empty.png`,animations:'disabled'});
  const capsuleContext = await browser.newContext({ viewport:{width:380,height:70}, reducedMotion:'reduce' });
  const capsule = await capsuleContext.newPage();
  capsule.on('pageerror', error => errors.push(error.message));
  await capsule.addInitScript(fixture,{theme:'dark'});
  await capsule.goto(`${url}/capsule.html`);
  await capsule.waitForFunction(() => window.__QA__.calls.includes('plugin:event|listen'));
  for (const state of ['recording','transcribing','done','error']) {
    await capsule.evaluate((state) => window.__QA__.emit('capsule-state', {state, text: state === 'done' ? 'Your words are ready.' : undefined, error: state === 'error' ? 'Could not transcribe. Please try again.' : undefined}), state);
    await capsule.locator('.capsule-pill').waitFor();
    await capsule.screenshot({path:`${output}/capsule-${state}.png`,animations:'disabled'});
  }
  await capsuleContext.close();
  const requiredAudit = async (screen, name) => {
    await screen.evaluate(() => new Promise(requestAnimationFrame));
    const result = await new AxeBuilder({ page: screen }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    failures.push(...result.violations.map(v => ({ screen: name, id: v.id, targets: v.nodes.map(n => n.target), details: v.nodes.map(n => n.failureSummary) })));
  };
  const requiredUpdate = { rid:9, currentVersion:'0.0.25', version:'0.0.27', date:null, body:null, rawJson:{ version:'v0.0.27', minimum_version:'0.0.26' } };
  const forcedContext = await browser.newContext({ viewport:{width:1080,height:760}, reducedMotion:'reduce' });
  const forced = await forcedContext.newPage();
  forced.on('pageerror', error => errors.push(error.message));
  await forced.clock.install();
  await forced.addInitScript(fixture, { update: requiredUpdate });
  await forced.goto(url);
  await forced.clock.runFor(6_000);
  const required = forced.getByRole('dialog', {name:'Linty needs to update'});
  await required.getByText('From version 0.0.25 to 0.0.27', {exact:true}).waitFor();
  await required.getByText(/Linty restarts once you’ve finished dictating/).waitFor();
  const beforeInstall = await forced.evaluate(() => window.__QA__.calls);
  assert.ok(beforeInstall.includes('plugin:updater|download'), 'a required update downloads at once');
  assert.ok(!beforeInstall.includes('plugin:updater|install'), 'it installs only after dictation has been quiet');
  await forced.keyboard.press('Escape');
  assert.equal(await required.isVisible(), true, 'Escape does not dismiss a required update');
  await requiredAudit(forced, 'required-update');
  await forced.screenshot({path:`${output}/update-required.png`,animations:'disabled'});
  await forced.evaluate(() => { window.__QA__.calls.length = 0; });
  await forced.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'check_for_update') {
        await new Promise(resolve => { window.__QA__.finishUpdateRecheck = resolve; });
      }
      return invoke(command, args);
    };
  });
  await forced.clock.runFor(31_000);
  await forced.waitForFunction(() => window.__QA__.finishUpdateRecheck);
  await forced.evaluate(() => window.__QA__.emit('fnkey-pressed'));
  await forced.waitForFunction(() => window.__QA__.calls.includes('start_dictation'));
  await forced.evaluate(() => window.__QA__.finishUpdateRecheck());
  await forced.clock.runFor(1_000);
  assert.ok(!(await forced.evaluate(() => window.__QA__.calls)).includes('plugin:updater|install'), 'dictation during the recheck postpones installation');
  await forced.evaluate(() => window.__QA__.emit('fnkey-released'));
  await forced.clock.runFor(2_000);
  await forced.waitForFunction(() => window.__QA__.calls.includes('plugin:process|restart'));
  const installCalls = await forced.evaluate(() => window.__QA__.calls);
  await forced.evaluate(() => { window.__QA__.calls.length = 0; window.__QA__.emit('fnkey-pressed'); });
  await forced.clock.runFor(1_000);
  assert.ok(!(await forced.evaluate(() => window.__QA__.calls)).includes('start_dictation'), 'installation blocks new recordings');
  assert.ok(installCalls.indexOf('check_for_update') < installCalls.indexOf('plugin:updater|install'), 'the release is checked again before installing');
  await forcedContext.close();

  const clearedContext = await browser.newContext({ viewport:{width:1080,height:760}, reducedMotion:'reduce' });
  const cleared = await clearedContext.newPage();
  cleared.on('pageerror', error => errors.push(error.message));
  await cleared.clock.install();
  await cleared.addInitScript(fixture, { update: requiredUpdate });
  await cleared.goto(url);
  await cleared.clock.runFor(6_000);
  const waiting = cleared.getByRole('dialog', {name:'Linty needs to update'});
  await waiting.getByText(/Linty restarts once you’ve finished dictating/).waitFor();
  await cleared.evaluate((offer) => window.__QA__.setUpdate({ ...offer, rawJson: { version: 'v0.0.27' } }), requiredUpdate);
  await cleared.clock.runFor(31_000);
  await waiting.waitFor({ state: 'hidden' });
  const clearedCalls = await cleared.evaluate(() => window.__QA__.calls);
  assert.ok(!clearedCalls.includes('plugin:updater|install'), 'a cleared minimum is not installed');
  assert.ok(!clearedCalls.includes('plugin:process|restart'));
  await clearedContext.close();

  const optionalContext = await browser.newContext({ viewport:{width:1080,height:760}, reducedMotion:'reduce' });
  const optional = await optionalContext.newPage();
  optional.on('pageerror', error => errors.push(error.message));
  await optional.addInitScript(fixture, { update: { ...requiredUpdate, rawJson: { version: 'v0.0.27' } } });
  await optional.goto(url);
  await optional.getByRole('button', {name:/Update$/}).waitFor({ timeout: 15000 });
  assert.equal(await optional.getByRole('dialog').count(), 0, 'an update without a minimum stays optional');
  await optional.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'plugin:updater|download') {
        await new Promise(resolve => { window.__QA__.finishOptionalDownload = resolve; });
      }
      return invoke(command, args);
    };
  });
  await optional.getByRole('button', {name:/Update$/}).click();
  await optional.waitForFunction(() => window.__QA__.finishOptionalDownload);
  await optional.evaluate(() => window.__QA__.emit('fnkey-pressed'));
  await optional.waitForFunction(() => window.__QA__.calls.includes('start_dictation'));
  await optional.evaluate(() => window.__QA__.finishOptionalDownload());
  await optional.waitForFunction(() => window.__QA__.calls.includes('plugin:updater|download'));
  assert.ok(!(await optional.evaluate(() => window.__QA__.calls)).includes('plugin:updater|install'), 'manual updates also preserve dictation');
  await optional.evaluate(() => window.__QA__.emit('fnkey-released'));
  await optional.waitForFunction(() => window.__QA__.calls.includes('plugin:process|restart'));
  await optionalContext.close();

  assert.deepEqual(errors, [], 'Unexpected runtime errors');
  assert.deepEqual(failures, [], 'Accessibility failures');
  console.log('UI checks passed: both themes, all screens, 605-record archive, pagination/search, full totals/export, retention/clear confirmations, recovery, keyboard navigation, copy, delete/undo, corrections/dictionary, modal focus, minimum window, onboarding and required updates.');
  console.log(`Screenshots: ${output}`);
} finally { await browser?.close(); server.kill(); }
