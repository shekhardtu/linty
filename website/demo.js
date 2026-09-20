/* An illustrated, repeating workflow. No audio recording or speech processing. */
(() => {
  const demo = document.querySelector('.workflow-demo');
  const stage = document.getElementById('demo-stage');
  const track = document.getElementById('demo-track');
  const panels = [...document.querySelectorAll('[data-demo-panel]')];
  const sceneButtons = [...document.querySelectorAll('[data-demo-scene]')];
  const description = document.getElementById('demo-scene-description');
  const sceneStatus = document.getElementById('demo-scene-status');
  const play = document.getElementById('play-demo');
  const playLabel = document.getElementById('demo-play-label');
  let scene = 0;
  let output = panels[scene].querySelector('[data-demo-output]');
  const status = document.getElementById('demo-status');
  const capsule = document.getElementById('demo-capsule');
  const label = document.getElementById('capsule-label');
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const hoverPointer = matchMedia('(hover: hover) and (pointer: fine)');
  let letters = Array.from(output.parentElement.dataset.example);
  const letterInterval = 26;
  const frames = [
    { phase: 'ready', duration: 1200, label: 'Ready when you are', status: 'Hold → Speak → Release', text: 'Your words will appear here.' },
    { phase: 'listening', duration: 2000, label: 'Listening…', status: '1. Hold the key · 2. Speak', text: '' },
    { phase: 'transcribing', duration: 900, label: 'Transcribing…', status: '3. Release the key', text: '' },
    { phase: 'typing', duration: Math.max(1, letters.length) * letterInterval, label: 'Words, right where you need them', status: 'Your words appear…' },
    { phase: 'complete', duration: 4200, label: 'Words, right where you need them', status: 'Text inserted · Repeats automatically', text: letters.join('') },
  ];
  let frame = 0;
  let remaining = frames[frame].duration;
  let timer = null;
  let deadline = 0;
  let userPaused = false;
  let hovered = false;
  let keyboardFocused = false;
  let interactionOverride = false;
  let visible = !('IntersectionObserver' in window);
  let pageActive = true;
  let motionAllowed = !reducedMotion.matches && root.dataset.motion !== 'off';
  let motionPaused = !motionAllowed;
  let revealed = 0;
  let previewOnly = false;

  const selectScene = (index, manual = false) => {
    clearTimeout(timer);
    timer = null;
    scene = (index + panels.length) % panels.length;
    output = panels[scene].querySelector('[data-demo-output]');
    letters = Array.from(output.parentElement.dataset.example);
    const name = panels[scene].dataset.demoPanel;
    frames[0].text = { notes: 'Your words will appear here.', email: 'Your message will appear here.', code: 'Your comment will appear here.' }[name];
    frames[3].duration = Math.max(1, letters.length) * letterInterval;
    frames[4].text = letters.join('');
    // Manual browsing remains useful when autoplay is paused or motion is reduced.
    previewOnly = motionPaused || (manual && isPaused());
    frame = previewOnly ? frames.length - 1 : 0;
    remaining = frames[frame].duration;
    revealed = 0;
    panels.forEach((panel, index) => {
      panel.setAttribute('aria-hidden', String(index !== scene));
      panel.inert = index !== scene;
      sceneButtons[index].setAttribute('aria-pressed', String(index === scene));
    });
    track.style.setProperty('--demo-scene', scene);
    demo.dataset.scene = name;
    description.textContent = panels[scene].dataset.description;
    document.getElementById('demo-detail').textContent = panels[scene].dataset.detail;
    if (manual) sceneStatus.textContent = panels[scene].getAttribute('aria-label');
    renderFrame();
    sync();
  };

  const isPaused = () => userPaused || motionPaused || ((hovered || keyboardFocused) && !interactionOverride);
  const renderFrame = () => {
    const current = frames[frame];
    const typing = current.phase === 'typing';
    if (typing) {
      // Keep revealed text when motion preferences change during this phase.
      revealed = motionAllowed ? Math.max(revealed, Math.floor((current.duration - remaining) / letterInterval)) : letters.length;
    }
    output.textContent = typing ? letters.slice(0, revealed).join('') : current.text;
    output.classList.toggle('placeholder', current.phase === 'ready');
    capsule.classList.toggle('is-recording', current.phase === 'listening');
    demo.dataset.phase = current.phase;
    label.textContent = current.label;
  };
  const sync = () => {
    const paused = isPaused();
    const playing = !paused && visible && pageActive && !document.hidden;
    // Preserve time remaining so every pause resumes at the same point.
    if (!playing && timer !== null) {
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, deadline - performance.now());
    }
    if (playing && timer === null) {
      deadline = performance.now() + remaining;
      const current = frames[frame];
      const typing = current.phase === 'typing' && motionAllowed && revealed < letters.length;
      const nextLetter = letterInterval - ((current.duration - remaining) % letterInterval);
      const delay = typing ? Math.min(remaining, nextLetter) : remaining;
      timer = setTimeout(() => {
        timer = null;
        remaining = Math.max(0, deadline - performance.now());
        if (remaining === 0) {
          if (frame === frames.length - 1) return selectScene(scene + 1);
          frame += 1;
          remaining = frames[frame].duration;
          revealed = 0;
        }
        renderFrame();
        sync();
      }, delay);
    }
    demo.dataset.playing = String(playing);
    playLabel.textContent = paused ? 'Play example' : 'Pause example';
    status.textContent = paused ? 'Example paused' : frames[frame].status;
  };

  play.addEventListener('click', () => {
    if (isPaused()) {
      userPaused = false;
      motionPaused = false;
      // Explicit Play works while the control is hovered or keyboard-focused.
      interactionOverride = true;
      if (previewOnly) {
        previewOnly = false;
        frame = 0;
        remaining = frames[frame].duration;
        revealed = 0;
        renderFrame();
      }
    } else {
      userPaused = true;
    }
    sync();
  });
  stage.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch' || !hoverPointer.matches) return;
    hovered = true;
    interactionOverride = false;
    sync();
  });
  const leave = () => {
    hovered = false;
    if (!keyboardFocused) interactionOverride = false;
    sync();
  };
  stage.addEventListener('pointerleave', leave);
  stage.addEventListener('pointercancel', leave);
  demo.addEventListener('focusin', event => {
    keyboardFocused = event.target.matches(':focus-visible');
    if (keyboardFocused) interactionOverride = false;
    sync();
  });

  sceneButtons.forEach((button, index) => {
    button.addEventListener('click', () => selectScene(index, true));
    button.addEventListener('keydown', event => {
      const directions = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: panels.length - 1 - index };
      if (!(event.key in directions)) return;
      event.preventDefault();
      const next = (index + directions[event.key] + panels.length) % panels.length;
      selectScene(next, true);
      sceneButtons[next].focus();
    });
  });
  document.getElementById('demo-previous').addEventListener('click', () => selectScene(scene - 1, true));
  document.getElementById('demo-next').addEventListener('click', () => selectScene(scene + 1, true));
  let touchStart = null;
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' && event.isPrimary !== false) touchStart = { x: event.clientX, y: event.clientY };
  });
  stage.addEventListener('pointerup', event => {
    if (!touchStart || event.pointerType !== 'touch') return;
    const dx = event.clientX - touchStart.x;
    const dy = event.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) selectScene(scene + (dx < 0 ? 1 : -1), true);
  });
  stage.addEventListener('pointercancel', () => { touchStart = null; });
  demo.addEventListener('focusout', event => {
    if (demo.contains(event.relatedTarget)) return;
    keyboardFocused = false;
    if (!hovered) interactionOverride = false;
    sync();
  });

  const syncMotion = () => {
    const allowed = !reducedMotion.matches && root.dataset.motion !== 'off';
    if (allowed === motionAllowed) return;
    motionAllowed = allowed;
    motionPaused = !allowed;
    renderFrame();
    sync();
  };
  reducedMotion.addEventListener('change', syncMotion);
  new MutationObserver(syncMotion).observe(root, { attributes: true, attributeFilter: ['data-motion'] });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting && entries[0].intersectionRatio >= .2;
      sync();
    }, { threshold: [0, .2] }).observe(demo);
  }
  document.addEventListener('visibilitychange', sync);
  addEventListener('pagehide', () => { pageActive = false; sync(); });
  addEventListener('pageshow', () => { pageActive = true; sync(); });

  selectScene(0);
})();
