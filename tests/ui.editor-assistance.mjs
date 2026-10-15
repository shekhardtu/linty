import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { fixture } from './ui.fixture.mjs';
const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1494';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], {stdio:['ignore','pipe','pipe']});
let browser;
try {
  await new Promise((resolve,reject) => { const timer=setTimeout(() => reject(new Error('Preview timeout')),15000); server.stdout.on('data',c=>{if(String(c).includes(port)){clearTimeout(timer);resolve();}});server.once('exit',reject); });
  browser=await engine.launch({headless:true}); const page=await browser.newPage({reducedMotion:'reduce'}); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(fixture, {empty:true});
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading',{name:'Your dictation',exact:true}).waitFor();
  const emit = id => page.evaluate(id => window.__QA__.emit('editor-edit-preview', {id,original:'mixedCase 😀',replacement:'MIXEDCASE 😀'}),id);
  await emit('cancel');
  await page.getByRole('heading',{name:'Review selected-text edit'}).waitFor();
  assert.equal(await page.getByLabel('Original selection').inputValue(),'mixedCase 😀');
  assert.equal(await page.getByLabel('Proposed edit').inputValue(),'MIXEDCASE 😀');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(await page.evaluate(()=>window.__QA__.calls.filter(c=>c==='accept_editor_edit').length),0);
  await emit('accept');
  await page.getByRole('button',{name:'Accept edit',exact:true}).click();
  await page.getByRole('heading',{name:'Edit applied',exact:true}).waitFor();
  await page.getByRole('button',{name:'Undo edit',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(await page.evaluate(()=>window.__QA__.calls.filter(c=>c==='undo_editor_edit').length),1);
  await page.evaluate(()=>{window.__QA__.failures.accept_editor_edit='The selected text changed';});
  await emit('stale');
  await page.getByRole('button',{name:'Accept edit',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'The selected text changed'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Accept edit',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  await page.evaluate(()=>{delete window.__QA__.failures.accept_editor_edit;});
  for (const action of ['accept', 'cancel', 'undo']) {
    await emit(`old-${action}`);
    if (action === 'undo') {
      await page.getByRole('button',{name:'Accept edit',exact:true}).click();
      await page.getByRole('heading',{name:'Edit applied',exact:true}).waitFor();
    }
    await page.evaluate(action => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === `${action}_editor_edit`) {
          await new Promise(resolve => { window.__releaseEditorOperation = resolve; });
          window.__TAURI_INTERNALS__.invoke = original;
        }
        return original(command, args);
      };
    }, action);
    await page.getByRole('button',{name:action === 'accept' ? 'Accept edit' : action === 'undo' ? 'Undo edit' : 'Cancel',exact:true}).click();
    await page.waitForFunction(()=>typeof window.__releaseEditorOperation==='function');
    await emit(`new-${action}`);
    await page.evaluate(()=>{window.__releaseEditorOperation();delete window.__releaseEditorOperation;});
    await page.getByRole('heading',{name:'Review selected-text edit',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Accept edit',exact:true}).isEnabled(),true,'An older operation must not accept, disable, or hide a newer preview');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  }
  assert.deepEqual(errors,[]);
  console.log(`${engine.name()}: selected-text preview, cancel, accept, undo, and stale rejection passed.`);
} finally { await browser?.close(); server.kill('SIGTERM'); }
