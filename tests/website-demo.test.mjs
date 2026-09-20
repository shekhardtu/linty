import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../website/demo.js', import.meta.url), 'utf8');
const example = 'Example transcription.';
const typingDuration = Array.from(example).length * 26;

function preview({ reduced = false, sentence = example, sentences = [sentence, sentence, sentence] } = {}) {
  const element = () => ({
    dataset: {}, textContent: '', parentElement: { dataset: { example: sentence } },
    classList: { toggle() {} },
    attributes: {}, style: { setProperty(name, value) { this[name] = value; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    focus() { this.focused = true; },
    handlers: {},
    addEventListener(name, callback) { (this.handlers[name] ??= []).push(callback); },
    emit(name, event = {}) { for (const callback of this.handlers[name] ?? []) callback(event); },
    matches: () => true,
    contains: () => false,
  });
  const demo = element();
  const root = element();
  const document = element();
  const page = element();
  const ids = Object.fromEntries(['play-demo', 'demo-play-label', 'demo-status', 'demo-capsule', 'capsule-label', 'demo-stage', 'demo-track', 'demo-scene-description', 'demo-scene-status', 'demo-previous', 'demo-next', 'demo-detail'].map(id => [id, element()]));
  const outputs = sentences.map(sentence => Object.assign(element(), { parentElement: { dataset: { example: sentence } } }));
  const panels = ['notes', 'email', 'code'].map((name, index) => {
    const panel = element();
    panel.dataset = { demoPanel: name, description: name + ' description' };
    panel.setAttribute('aria-label', `${index + 1} of 3: ${name}`);
    panel.querySelector = () => outputs[index];
    return panel;
  });
  const sceneButtons = panels.map(() => element());
  ids['demo-output'] = outputs[0];
  const reducedMotion = Object.assign(element(), { matches: reduced });
  const pointer = { matches: true };
  const timers = new Map();
  let now = 0;
  let nextId = 0;
  let onIntersection;
  let onMotion;
  document.hidden = false;
  document.documentElement = root;
  document.getElementById = id => ids[id];
  document.querySelector = () => demo;
  document.querySelectorAll = selector => selector === '[data-demo-panel]' ? panels : sceneButtons;
  const context = {
    document, performance: { now: () => now },
    matchMedia: query => query.includes('reduced-motion') ? reducedMotion : pointer,
    setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener: page.addEventListener.bind(page),
    MutationObserver: class { constructor(callback) { onMotion = callback; } observe() {} },
    IntersectionObserver: class { constructor(callback) { onIntersection = callback; } observe() {} },
  };
  context.window = context;
  runInNewContext(source, context);
  return {
    demo, ids, document, page, timers, panels, outputs, sceneButtons, stage: ids['demo-stage'],
    visible(value) { onIntersection([{ isIntersecting: value, intersectionRatio: value ? 1 : 0 }]); },
    motion(value) { root.dataset.motion = value ? 'on' : 'off'; onMotion(); },
    tick(duration) {
      const end = now + duration;
      for (;;) {
        const pending = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!pending || pending[1].due > end) break;
        now = pending[1].due;
        timers.delete(pending[0]);
        pending[1].callback();
      }
      now = end;
    },
  };
}

test('autoplays in view, holds the result, and repeats with one timer', () => {
  const p = preview();
  assert.equal(p.timers.size, 0);
  p.visible(true);
  p.tick(1200);
  assert.equal(p.ids['capsule-label'].textContent, 'Listening…');
  p.tick(2000);
  assert.equal(p.ids['capsule-label'].textContent, 'Transcribing…');
  p.tick(900);
  assert.equal(p.demo.dataset.phase, 'typing');
  assert.equal(p.ids['demo-output'].textContent, '');
  p.tick(26);
  assert.equal(p.ids['demo-output'].textContent, 'E');
  p.tick(typingDuration - 26);
  assert.equal(p.demo.dataset.phase, 'complete');
  assert.equal(p.ids['demo-output'].textContent, 'Example transcription.');
  p.tick(4199);
  assert.equal(p.ids['demo-output'].textContent, 'Example transcription.');
  p.tick(1);
  assert.equal(p.ids['capsule-label'].textContent, 'Ready when you are');
  p.tick((8300 + typingDuration) * 3);
  assert.equal(p.ids['capsule-label'].textContent, 'Ready when you are');
  assert.equal(p.timers.size, 1);
});

test('pausing midway through typing preserves the text and the next-letter timing', () => {
  const p = preview();
  p.visible(true);
  p.tick(4100 + 26 * 4 + 12);
  assert.equal(p.ids['demo-output'].textContent, 'Exam');
  p.stage.emit('pointerenter', { pointerType: 'mouse' });
  p.tick(10000);
  assert.equal(p.ids['demo-output'].textContent, 'Exam');
  assert.equal(p.timers.size, 0);
  p.stage.emit('pointerleave');
  p.tick(13);
  assert.equal(p.ids['demo-output'].textContent, 'Exam');
  p.tick(1);
  assert.equal(p.ids['demo-output'].textContent, 'Examp');
  assert.equal(p.timers.size, 1);
});

test('the typewriter reveals Unicode code points without splitting emoji', () => {
  const p = preview({ sentence: 'A🌊B' });
  p.visible(true);
  p.tick(4100 + 52);
  assert.equal(p.ids['demo-output'].textContent, 'A🌊');
  p.tick(26);
  assert.equal(p.ids['demo-output'].textContent, 'A🌊B');
});

test('disabling motion reveals the whole sentence and prevents a rewind on resume', () => {
  const p = preview();
  p.visible(true);
  p.tick(4100 + 52);
  assert.equal(p.ids['demo-output'].textContent, 'Ex');
  p.motion(false);
  assert.equal(p.ids['demo-output'].textContent, example);
  assert.equal(p.timers.size, 0);
  p.motion(true);
  p.tick(26);
  assert.equal(p.ids['demo-output'].textContent, example);
  const q = preview({ reduced: true });
  q.visible(true);
  q.ids['play-demo'].emit('click');
  q.tick(4100);
  assert.equal(q.ids['demo-output'].textContent, example);
});

test('hover freezes the current phase and leaving resumes its remaining time', () => {
  const p = preview();
  p.visible(true);
  p.tick(500);
  p.stage.emit('pointerenter', { pointerType: 'mouse' });
  p.tick(20000);
  assert.equal(p.ids['capsule-label'].textContent, 'Ready when you are');
  assert.equal(p.timers.size, 0);
  assert.equal(p.ids['demo-play-label'].textContent, 'Play example');
  p.stage.emit('pointerleave');
  p.tick(699);
  assert.equal(p.ids['capsule-label'].textContent, 'Ready when you are');
  p.tick(1);
  assert.equal(p.ids['capsule-label'].textContent, 'Listening…');
});

test('explicit playback works while hovered and explicit pause survives leaving', () => {
  const p = preview();
  p.visible(true);
  p.stage.emit('pointerenter', { pointerType: 'mouse' });
  p.ids['play-demo'].emit('click');
  assert.equal(p.demo.dataset.playing, 'true');
  p.ids['play-demo'].emit('click');
  p.stage.emit('pointerleave');
  p.tick(20000);
  assert.equal(p.demo.dataset.playing, 'false');
  assert.equal(p.timers.size, 0);
  p.ids['play-demo'].emit('click');
  assert.equal(p.demo.dataset.playing, 'true');
});

test('offscreen, hidden, and page navigation suspend and resume playback', () => {
  const p = preview();
  p.visible(true);
  p.tick(500);
  for (const [pause, resume] of [
    [() => p.visible(false), () => p.visible(true)],
    [() => { p.document.hidden = true; p.document.emit('visibilitychange'); }, () => { p.document.hidden = false; p.document.emit('visibilitychange'); }],
    [() => p.page.emit('pagehide'), () => p.page.emit('pageshow')],
  ]) {
    pause();
    p.tick(20000);
    assert.equal(p.timers.size, 0);
    resume();
    assert.equal(p.timers.size, 1);
  }
  p.tick(700);
  assert.equal(p.ids['capsule-label'].textContent, 'Listening…');
});

test('motion preferences stop autoplay while explicit Play remains available', () => {
  const p = preview({ reduced: true });
  p.visible(true);
  assert.equal(p.demo.dataset.playing, 'false');
  p.ids['play-demo'].emit('click');
  assert.equal(p.demo.dataset.playing, 'true');
  const q = preview();
  q.visible(true);
  q.motion(false);
  assert.equal(q.demo.dataset.playing, 'false');
  q.motion(true);
  assert.equal(q.demo.dataset.playing, 'true');
  q.ids['play-demo'].emit('click');
  q.motion(false);
  q.motion(true);
  assert.equal(q.demo.dataset.playing, 'false');
});

test('touch does not trigger hover pause and keyboard focus can pause and resume', () => {
  const p = preview();
  p.visible(true);
  p.stage.emit('pointerenter', { pointerType: 'touch' });
  assert.equal(p.demo.dataset.playing, 'true');
  p.demo.emit('focusin', { target: p.ids['play-demo'] });
  assert.equal(p.demo.dataset.playing, 'false');
  p.ids['play-demo'].emit('click');
  assert.equal(p.demo.dataset.playing, 'true');
  p.demo.emit('focusout', { relatedTarget: null });
  assert.equal(p.demo.dataset.playing, 'true');
});

test('automatically rotates Notes, Email, and Code after each completed example', () => {
  const p = preview();
  p.visible(true);
  const cycle = 8300 + typingDuration;
  for (const [name, index] of [['email', 1], ['code', 2], ['notes', 0]]) {
    p.tick(cycle);
    assert.equal(p.demo.dataset.scene, name);
    assert.equal(p.demo.dataset.phase, 'ready');
    assert.equal(p.timers.size, 1);
    assert.equal(p.sceneButtons[index].getAttribute('aria-pressed'), 'true');
    assert.equal(p.panels.filter(panel => !panel.inert).length, 1);
    assert.equal(p.panels[index].inert, false);
  }
});

test('manual scene selection replaces a running timer and preserves email line breaks', () => {
  const email = 'Hi Maya,\n\nPreview ready.\n\nThanks,\nAlex';
  const p = preview({ sentences: [example, email, example] });
  p.visible(true);
  p.tick(4152);
  assert.equal(p.outputs[0].textContent, 'Ex');
  p.sceneButtons[1].emit('click');
  assert.equal(p.demo.dataset.scene, 'email');
  assert.equal(p.timers.size, 1);
  p.tick(4100 + Array.from(email).length * 26);
  assert.equal(p.outputs[1].textContent, email);
  assert.equal(p.outputs[0].textContent, 'Ex');
  assert.equal(p.demo.dataset.phase, 'complete');
  assert.equal(p.ids['demo-scene-status'].textContent, '2 of 3: email');
});

test('arrows wrap between scenes and keyboard browsing stays paused for reading', () => {
  const p = preview();
  p.visible(true);
  p.ids['demo-previous'].emit('click');
  assert.equal(p.demo.dataset.scene, 'code');
  p.ids['demo-next'].emit('click');
  assert.equal(p.demo.dataset.scene, 'notes');
  p.demo.emit('focusin', { target: p.sceneButtons[0] });
  let prevented = false;
  p.sceneButtons[0].emit('keydown', { key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(p.demo.dataset.scene, 'email');
  assert.equal(p.outputs[1].textContent, example);
  assert.equal(p.demo.dataset.playing, 'false');
  assert.equal(p.sceneButtons[1].focused, true);
});

test('reduced-motion browsing shows complete examples without starting timers', () => {
  const p = preview({ reduced: true });
  p.visible(true);
  assert.equal(p.outputs[0].textContent, example);
  p.sceneButtons[2].emit('click');
  assert.equal(p.outputs[2].textContent, example);
  assert.equal(p.timers.size, 0);
});

test('horizontal touch swipes change apps while vertical scrolling does not', () => {
  const p = preview();
  p.visible(true);
  const swipe = (x, y) => {
    p.stage.emit('pointerdown', { pointerType: 'touch', clientX: 200, clientY: 200 });
    p.stage.emit('pointerup', { pointerType: 'touch', clientX: x, clientY: y });
  };
  swipe(130, 350);
  assert.equal(p.demo.dataset.scene, 'notes');
  swipe(130, 205);
  assert.equal(p.demo.dataset.scene, 'email');
  swipe(275, 205);
  assert.equal(p.demo.dataset.scene, 'notes');
});
