/* CSS animates visible artwork. Icon frames stop as soon as the response settles. */
(() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  const toggle = document.getElementById('motion-toggle');
  const icons = [...document.querySelectorAll('.app-icon-link[data-icon-motion]')];
  let paused = false;
  let controller;
  const resets = new Set();
  try { paused = localStorage.getItem('linty-site-motion') === 'paused'; } catch {}

  const bindIcons = (enabled) => {
    controller?.abort();
    for (const reset of resets) reset();
    resets.clear();
    if (!enabled || !pointer.matches || document.hidden) return;
    controller = new AbortController();
    const options = { passive: true, signal: controller.signal };
    for (const icon of icons) {
      let bounds;
      let frame = 0;
      let previous = 0;
      let hovered = false;
      let focused = false;
      const current = { x: 0, y: 0, lift: 0, press: 0 };
      const target = { ...current };
      const properties = ['rx', 'ry', 'lift', 'press', 'light-x', 'light-y'];
      const render = () => {
        icon.style.setProperty('--icon-rx', `${(-current.y * 4).toFixed(3)}deg`);
        icon.style.setProperty('--icon-ry', `${(current.x * 4).toFixed(3)}deg`);
        icon.style.setProperty('--icon-lift', current.lift.toFixed(4));
        icon.style.setProperty('--icon-press', current.press.toFixed(4));
        icon.style.setProperty('--icon-light-x', `${(50 + current.x * 30).toFixed(2)}%`);
        icon.style.setProperty('--icon-light-y', `${(40 + current.y * 30).toFixed(2)}%`);
      };
      const tick = time => {
        const elapsed = Math.min(time - (previous || time - 16.67), 32);
        previous = time;
        // Frame-rate-independent damping: quick to respond, softer on release.
        const blend = 1 - Math.exp(-elapsed / (target.lift ? 65 : 100));
        let settled = true;
        for (const key of Object.keys(current)) {
          current[key] += (target[key] - current[key]) * blend;
          if (Math.abs(target[key] - current[key]) > .001) settled = false;
        }
        if (settled) Object.assign(current, target);
        render();
        frame = settled ? 0 : requestAnimationFrame(tick);
        if (settled) previous = 0;
      };
      const animate = () => { if (!frame) frame = requestAnimationFrame(tick); };
      const release = () => {
        hovered = false;
        bounds = null;
        Object.assign(target, { x: 0, y: 0, lift: focused ? 1 : 0, press: 0 });
        animate();
      };
      const clear = () => {
        cancelAnimationFrame(frame);
        frame = previous = 0;
        hovered = focused = false;
        bounds = null;
        Object.assign(current, { x: 0, y: 0, lift: 0, press: 0 });
        Object.assign(target, current);
        for (const property of properties) icon.style.removeProperty(`--icon-${property}`);
      };
      resets.add(clear);
      const move = event => {
        if (event.pointerType === 'touch') return;
        hovered = true;
        bounds ??= icon.getBoundingClientRect();
        target.x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
        target.y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
        target.lift = 1;
        animate();
      };
      icon.addEventListener('pointerenter', move, options);
      icon.addEventListener('pointermove', move, options);
      icon.addEventListener('pointerleave', release, options);
      icon.addEventListener('pointercancel', release, options);
      icon.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' || event.button !== 0) return;
        target.press = 1;
        animate();
      }, options);
      addEventListener('pointerup', () => {
        if (!target.press) return;
        target.press = 0;
        animate();
      }, options);
      icon.addEventListener('focus', () => {
        focused = icon.matches(':focus-visible');
        if (focused) { target.lift = 1; animate(); }
      }, options);
      icon.addEventListener('blur', () => {
        focused = false;
        if (!hovered) release();
      }, options);
    }
    addEventListener('blur', () => { for (const reset of resets) reset(); }, options);
    // Cached hit rectangles must never become stale while the page moves.
    addEventListener('scroll', () => { for (const reset of resets) reset(); }, options);
    addEventListener('resize', () => { for (const reset of resets) reset(); }, options);
  };
  const sync = () => {
    const enabled = !paused && !reduced.matches;
    root.dataset.motion = enabled ? 'on' : 'off';
    root.classList.toggle('document-hidden', document.hidden);
    toggle.disabled = reduced.matches;
    toggle.textContent = reduced.matches ? 'Reduced motion' : paused ? 'Resume motion' : 'Pause motion';
    toggle.setAttribute('aria-label', 'Background motion');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.title = reduced.matches ? 'Reduced motion is enabled in your system settings.' : '';
    bindIcons(enabled);
  };
  toggle.addEventListener('click', () => {
    paused = !paused;
    try { localStorage.setItem('linty-site-motion', paused ? 'paused' : 'on'); } catch {}
    sync();
  });
  reduced.addEventListener('change', sync);
  pointer.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  const artwork = [...document.querySelectorAll('.ambient-artwork')];
  if ('IntersectionObserver' in window) {
    const visibility = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.classList.toggle('is-in-view', entry.isIntersecting);
    });
    artwork.forEach(element => visibility.observe(element));
  }
  sync();
})();
