/* Actual product screenshots: a seamless, left-to-right tour. */
(() => {
  const stage = document.getElementById('the-app');
  const viewport = document.getElementById('product-window');
  const slides = [...document.querySelectorAll('[data-product-slide]')];
  const buttons = [...document.querySelectorAll('[data-screen]')];
  const playback = document.getElementById('product-playback');
  const status = document.getElementById('product-status');
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const hoverPointer = matchMedia('(hover: hover) and (pointer: fine)');
  const images = slides.map(slide => slide.querySelector('img'));
  const dwell = 10000;
  let selected = slides.findIndex(slide => !slide.hidden);
  let visible = !('IntersectionObserver' in window);
  let pageActive = true;
  let hovered = false;
  let keyboardFocused = false;
  let userPaused = false;
  let pending = null;
  let transition = null;
  let timer = null;
  let remaining = dwell;
  let deadline = 0;

  const motionAllowed = () => !reduced.matches && root.dataset.motion !== 'off';
  const canRotate = () => motionAllowed() && visible && pageActive && !document.hidden && !hovered && !keyboardFocused && !userPaused;
  const stopTimer = () => {
    if (timer === null) return;
    remaining = Math.max(0, deadline - performance.now());
    clearTimeout(timer);
    timer = null;
  };
  const render = () => {
    slides.forEach((slide, index) => {
      const active = index === selected;
      slide.hidden = !active;
      slide.inert = !active;
      slide.setAttribute('aria-hidden', String(!active));
      slide.classList.remove('is-entering', 'is-leaving');
      buttons[index].setAttribute('aria-pressed', String(active));
    });
    stage.dataset.productScreen = slides[selected].dataset.productSlide;
    document.getElementById('screen-caption').textContent = slides[selected].dataset.caption;
    document.getElementById('sample-label').textContent = slides[selected].dataset.sample;
  };
  const finishTransition = () => {
    if (!transition) return;
    transition = null;
    render();
    if (pending) showPending();
    sync();
  };
  const sync = () => {
    const enabled = motionAllowed();
    stage.dataset.transitionPaused = String(Boolean(transition && !transition.manual && (hovered || keyboardFocused || userPaused)));
    playback.disabled = !enabled;
    playback.dataset.paused = String(userPaused || !enabled);
    const label = !enabled ? 'Screen slideshow: motion paused' : userPaused ? 'Play screen slideshow' : 'Pause screen slideshow';
    playback.setAttribute('aria-label', label);
    playback.title = label;
    if (transition && (!enabled || !visible || !pageActive || document.hidden)) finishTransition();
    if (!canRotate() || transition || pending) {
      stopTimer();
      return;
    }
    if (timer !== null) return;
    deadline = performance.now() + remaining;
    timer = setTimeout(() => {
      timer = null;
      remaining = dwell;
      // An unavailable image must never replace the readable screen with a blank.
      const next = [1, 2].map(offset => (selected + offset) % slides.length)
        .find(index => images[index].dataset.failed !== 'true');
      if (next !== undefined) select(next);
    }, remaining);
  };
  const showPending = () => {
    if (!pending || transition) return;
    const { index, manual } = pending;
    const image = images[index];
    if (!image.complete || !image.naturalWidth) return;
    pending = null;
    const previous = selected;
    selected = index;
    render();
    if (manual) status.textContent = slides[selected].getAttribute('aria-label');
    if (previous !== selected && motionAllowed() && visible && pageActive && !document.hidden) {
      // Only the outgoing and incoming screens move. Wrapping uses the same
      // direction and distance, with no track rewind or duplicate focus targets.
      transition = { incoming: slides[selected], manual };
      slides[previous].hidden = false;
      slides[previous].classList.add('is-leaving');
      slides[selected].classList.add('is-entering');
    }
    sync();
  };
  const select = (index, manual = false) => {
    if (index < 0 || index >= slides.length) return;
    stopTimer();
    remaining = dwell;
    // Rapid input keeps the most recent choice, without overlapping animations.
    pending = { index, manual };
    if (images[index].dataset.failed === 'true') {
      pending = null;
      if (manual) status.textContent = 'This screenshot could not load. Please try reloading the page.';
      sync();
      return;
    }
    // A click can interrupt an automatic slide that was frozen by hovering.
    if (manual && transition && !transition.manual && (hovered || keyboardFocused || userPaused)) {
      finishTransition();
      return;
    }
    showPending();
  };
  const updateTheme = () => {
    images.forEach((image, index) => {
      const source = image.dataset[root.dataset.theme === 'dark' ? 'dark' : 'light'];
      if (image.getAttribute('src') !== source) {
        delete image.dataset.failed;
        image.src = source;
      }
    });
  };

  buttons.forEach((button, index) => {
    button.addEventListener('click', () => {
      select(index, true);
    });
    button.addEventListener('keydown', event => {
      const target = { ArrowLeft: (index + slides.length - 1) % slides.length, ArrowRight: (index + 1) % slides.length, Home: 0, End: slides.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      buttons[target].focus();
      select(target, true);
    });
  });
  document.querySelectorAll('[data-open-screen]').forEach(link => link.addEventListener('click', () => {
    select(slides.findIndex(slide => slide.dataset.productSlide === link.dataset.openScreen), true);
  }));
  slides.forEach((slide, index) => {
    slide.addEventListener('animationend', event => {
      if (event.target === transition?.incoming && event.animationName === 'product-enter') finishTransition();
    });
    images[index].addEventListener('load', () => {
      delete images[index].dataset.failed;
      if (pending?.index === index) showPending();
    });
    images[index].addEventListener('error', () => {
      images[index].dataset.failed = 'true';
      if (pending?.index !== index) return;
      if (pending.manual) status.textContent = 'This screenshot could not load. Please try reloading the page.';
      pending = null;
      sync();
    });
  });
  stage.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch' || !hoverPointer.matches) return;
    hovered = true;
    sync();
  });
  stage.addEventListener('pointerleave', () => { hovered = false; sync(); });
  stage.addEventListener('pointercancel', () => { hovered = false; sync(); });
  stage.addEventListener('focusin', event => {
    keyboardFocused = event.target.matches(':focus-visible');
    sync();
  });
  stage.addEventListener('focusout', event => {
    if (stage.contains(event.relatedTarget)) return;
    keyboardFocused = false;
    sync();
  });
  playback.addEventListener('click', () => {
    userPaused = !userPaused;
    sync();
  });
  document.addEventListener('visibilitychange', sync);
  addEventListener('pagehide', () => { pageActive = false; sync(); });
  addEventListener('pageshow', () => { pageActive = true; sync(); });
  reduced.addEventListener('change', sync);
  new MutationObserver(records => {
    if (records.some(record => record.attributeName === 'data-theme')) updateTheme();
    sync();
  }).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      sync();
    }).observe(viewport);
  }
  updateTheme();
  render();
  playback.hidden = false;
  sync();
})();
