import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../website/product.js', import.meta.url), 'utf8');

function preview({ reduced = false } = {}) {
  const element = () => {
    const classes = new Set();
    return {
      dataset: {}, attributes: {}, hidden: false, handlers: {},
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return name === 'src' ? this.src : this.attributes[name] ?? null; },
      addEventListener(name, fn) { (this.handlers[name] ??= []).push(fn); },
      emit(name, event = {}) { for (const fn of this.handlers[name] ?? []) fn(event); },
      focus() { this.focused = true; },
      matches: () => true, contains: () => false,
    };
  };
  const document = element();
  const page = element();
  const root = element();
  root.dataset = { theme: 'light', motion: 'on' };
  const ids = Object.fromEntries(['the-app', 'product-window', 'product-playback', 'product-status', 'screen-caption', 'sample-label'].map(id => [id, element()]));
  const names = ['history', 'overview', 'language'];
  const images = names.map(name => Object.assign(element(), { complete: true, naturalWidth: 2400, src: `${name}-light?v=version`, dataset: { light: `${name}-light?v=version`, dark: `${name}-dark?v=version` } }));
  const slides = names.map((name, index) => {
    const slide = element();
    slide.hidden = index !== 1;
    slide.dataset = { productSlide: name, caption: `${name} caption`, sample: `${name} sample` };
    slide.setAttribute('aria-label', name);
    slide.querySelector = () => images[index];
    return slide;
  });
  const buttons = names.map(() => element());
  const reducedQuery = Object.assign(element(), { matches: reduced });
  const timers = new Map();
  let now = 0;
  let nextId = 0;
  let onVisible;
  let onMutation;
  document.documentElement = root;
  document.getElementById = id => ids[id];
  document.querySelectorAll = query => query === '[data-product-slide]' ? slides : query === '[data-screen]' ? buttons : [];
  const context = {
    document, performance: { now: () => now },
    matchMedia: query => query.includes('reduced-motion') ? reducedQuery : { matches: true },
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener: page.addEventListener.bind(page),
    MutationObserver: class { constructor(fn) { onMutation = fn; } observe() {} },
    IntersectionObserver: class { constructor(fn) { onVisible = fn; } observe() {} },
  };
  context.window = context;
  runInNewContext(source, context);
  return {
    ids, slides, images, buttons, timers, document, page, stage: ids['the-app'], reducedQuery,
    get selected() { return ids['the-app'].dataset.productScreen; },
    visible(value) { onVisible([{ isIntersecting: value }]); },
    motion(value) { root.dataset.motion = value ? 'on' : 'off'; onMutation([{ attributeName: 'data-motion' }]); },
    theme(value) { root.dataset.theme = value; onMutation([{ attributeName: 'data-theme' }]); },
    finish() { const incoming = slides.find(slide => slide.classList.contains('is-entering')); if (incoming) incoming.emit('animationend', { target: incoming, animationName: 'product-enter' }); },
    tick(duration) {
      const end = now + duration;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

test('rotates every ten seconds in view and wraps without duplicate active screens', () => {
  const p = preview();
  assert.equal(p.timers.size, 0);
  p.visible(true);
  for (const name of ['language', 'history', 'overview', 'language']) {
    p.tick(9999);
    assert.notEqual(p.selected, name);
    p.tick(1);
    assert.equal(p.selected, name);
    assert.equal(p.slides.filter(slide => !slide.inert).length, 1);
    assert.equal(p.timers.size, 0, 'No rotation while a slide is moving');
    p.finish();
    assert.equal(p.slides.filter(slide => !slide.hidden).length, 1);
    assert.equal(p.timers.size, 1);
  }
  assert.equal(p.ids['product-status'].textContent, undefined, 'Automatic changes are not announced');
});

test('hover pauses the whole showcase on every screen, preserving remaining dwell', () => {
  const p = preview();
  p.visible(true);
  for (let index = 0; index < 3; index++) {
    p.buttons[index].emit('click');
    p.finish();
    p.tick(3500);
    p.stage.emit('pointerenter', { pointerType: 'mouse' });
    p.tick(20000);
    assert.equal(p.timers.size, 0);
    p.stage.emit('pointerleave');
    p.tick(6499);
    assert.equal(p.buttons[index].getAttribute('aria-pressed'), 'true');
    p.tick(1);
    assert.equal(p.buttons[index].getAttribute('aria-pressed'), 'false');
    p.finish();
  }
});

test('hover freezes an automatic transition, but manual selection still works', () => {
  const p = preview();
  p.visible(true);
  p.tick(10000);
  p.stage.emit('pointerenter', { pointerType: 'mouse' });
  assert.equal(p.stage.dataset.transitionPaused, 'true');
  p.buttons[0].emit('click');
  assert.equal(p.selected, 'history');
  assert.equal(p.stage.dataset.transitionPaused, 'false');
  p.finish();
  assert.equal(p.timers.size, 0);
  p.stage.emit('pointerleave');
  assert.equal(p.timers.size, 1);
});

test('rapid screen clicks keep the final choice and the matching caption', () => {
  const p = preview();
  p.visible(true);
  p.buttons[0].emit('click');
  p.buttons[1].emit('click');
  p.buttons[2].emit('click');
  p.finish();
  p.finish();
  assert.equal(p.selected, 'language');
  assert.equal(p.ids['screen-caption'].textContent, 'language caption');
  assert.equal(p.ids['product-status'].textContent, 'language');
  assert.equal(p.slides.filter(slide => !slide.hidden).length, 1);
  assert.equal(p.timers.size, 1);
});

test('waits for images and keeps the previous screen if a requested image fails', () => {
  const p = preview();
  p.visible(true);
  p.images[2].complete = false;
  p.buttons[2].emit('click');
  assert.equal(p.selected, 'overview');
  assert.equal(p.timers.size, 0);
  p.images[2].complete = true;
  p.images[2].emit('load');
  assert.equal(p.selected, 'language');
  p.finish();
  p.images[0].complete = false;
  p.buttons[0].emit('click');
  p.images[0].emit('error');
  assert.equal(p.selected, 'language');
  assert.match(p.ids['product-status'].textContent, /could not load/);
  p.tick(10000);
  assert.equal(p.selected, 'overview', 'Skips the unavailable image');
});

test('explicit pause, hidden tabs, offscreen and page navigation suspend autoplay', () => {
  const p = preview();
  p.visible(true);
  for (const [pause, resume] of [
    [() => p.ids['product-playback'].emit('click'), () => p.ids['product-playback'].emit('click')],
    [() => p.visible(false), () => p.visible(true)],
    [() => { p.document.hidden = true; p.document.emit('visibilitychange'); }, () => { p.document.hidden = false; p.document.emit('visibilitychange'); }],
    [() => p.page.emit('pagehide'), () => p.page.emit('pageshow')],
  ]) {
    p.tick(1000);
    pause();
    p.tick(20000);
    assert.equal(p.selected, 'overview');
    assert.equal(p.timers.size, 0);
    resume();
    assert.equal(p.timers.size, 1);
  }
  p.tick(6000);
  assert.equal(p.selected, 'language');
});

test('motion preferences stop animation while manual and keyboard selection remain available', () => {
  const p = preview({ reduced: true });
  p.visible(true);
  p.buttons[1].emit('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(p.selected, 'language');
  assert.equal(p.buttons[2].focused, true);
  assert.equal(p.slides.filter(slide => !slide.hidden).length, 1);
  assert.equal(p.timers.size, 0);
  const q = preview();
  q.visible(true);
  q.tick(10000);
  q.motion(false);
  assert.equal(q.slides.filter(slide => !slide.hidden).length, 1);
  assert.equal(q.timers.size, 0);
  q.motion(true);
  assert.equal(q.timers.size, 1);
});

test('theme changes retain selection and use versioned screenshots for every slide', () => {
  const p = preview();
  p.buttons[0].emit('click');
  p.theme('dark');
  assert.equal(p.selected, 'history');
  assert.ok(p.images.every(image => image.src.endsWith('-dark?v=version')));
});
