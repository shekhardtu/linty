import React from 'react';
import { createRoot } from 'react-dom/client';
import { fixture } from '../ui.fixture.mjs';
import { CapsulePanel } from '../../src/components/CapsulePanel.component.tsx';
import { useAppStore } from '../../src/store/app.store.ts';
import '../../src/styles/capsule.css';

// Development-only: this page uses the actual component with in-memory Tauri IPC.
fixture({ theme: 'dark' });
createRoot(document.getElementById('root')).render(React.createElement(CapsulePanel));

const phrase = [0, .002, .006, .018, .055, .09, .038, .012, .004, 0, 0, .003, .009, .032, .075, .046, .016, .004, .001, 0, 0, 0];
const presets = {
  quiet: { levels: [0, .0001, .0002, .00015, .00008, .0003, .0001], description: 'A quiet room stays close to the baseline.' },
  background: { levels: [.001, .0014, .0018, .0024, .0019, .0028, .0021, .0015, .0012], description: 'Low, steady noise leaves most of the height available for your voice.' },
  soft: { levels: phrase.map(level => level * .18), description: 'Soft speech has a small, distinct rhythm without filling the pill.' },
  speech: { levels: phrase, description: 'A natural speaking rhythm, with space between phrases.' },
  emphasis: { levels: phrase.map(level => level * 3), description: 'Louder syllables rise higher, with breathing room at the edges.' },
};
const microphoneButton = document.getElementById('microphone');
const note = document.getElementById('mic-note');
const description = document.getElementById('input-description');
let preset = 'speech', gain = 1, generation = 0, audioTimer, frame = 0;
let timers = [], microphone, inputEpoch = 0, microphonePending = false;
let mode = 'idle', handsFree = true;

function cancelSequence() {
  timers.forEach(clearTimeout);
  timers = [];
}

function stopMicrophone() {
  inputEpoch++;
  microphonePending = false;
  if (microphone) {
    microphone.stream.getTracks().forEach(track => track.stop());
    void microphone.context.close();
    microphone = undefined;
  }
  microphoneButton.textContent = 'Use my microphone';
  microphoneButton.setAttribute('aria-pressed', 'false');
  note.textContent = 'Synthetic input. The microphone is off.';
}

function updateSelection() {
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(!microphone && !microphonePending && button.dataset.preset === preset));
  }
  description.textContent = microphone ? 'Your live input, shown locally with the same visual response as Linty.' : presets[preset].description;
  document.querySelector('.placement-hint').textContent = mode === 'recording'
    ? handsFree ? 'Hands-free listening · drag the pill to reposition' : 'Hold-to-talk mode · position stays fixed'
    : 'Position stays fixed while processing and completing';
}

function startMeter() {
  clearInterval(audioTimer);
  audioTimer = setInterval(() => {
    let rms;
    if (microphone) {
      microphone.analyser.getFloatTimeDomainData(microphone.samples);
      rms = Math.sqrt(microphone.samples.reduce((sum, value) => sum + value * value, 0) / microphone.samples.length);
    } else {
      const levels = presets[preset].levels;
      rms = levels[frame++ % levels.length];
    }
    window.__QA__.emit('capsule-amplitude', rms * gain);
    // Read the component's rendered target, rather than reimplementing its curve.
    requestAnimationFrame(() => {
      if (mode !== 'recording') return;
      const bar = document.querySelector('.capsule-wave span:last-child');
      if (bar) document.getElementById('wave-height').textContent = (20 * new DOMMatrix(bar.style.transform).d).toFixed(1);
    });
  }, 70);
}

function state(next) {
  clearInterval(audioTimer);
  mode = next;
  if (next !== 'recording') {
    stopMicrophone();
    document.getElementById('wave-height').textContent = '—';
  }
  window.__QA__.emit('capsule-state', {
    state: next, generation: next === 'recording' ? ++generation : generation,
    hands_free: handsFree, error: 'Paste failed · open Linty',
  });
  if (next === 'recording') startMeter();
  updateSelection();
}

for (const button of document.querySelectorAll('[data-preset]')) {
  button.onclick = () => {
    cancelSequence(); stopMicrophone();
    preset = button.dataset.preset;
    frame = 0;
    // Preserve the waveform when changing examples so the difference is visible.
    if (mode !== 'recording') state('recording');
    updateSelection();
  };
}
for (const button of document.querySelectorAll('[data-state]')) {
  button.onclick = () => { cancelSequence(); state(button.dataset.state); };
}
document.getElementById('strength').oninput = event => {
  gain = Number(event.target.value) / 100;
  document.getElementById('strength-value').textContent = `${event.target.value}%`;
};
document.getElementById('hands-free').onchange = event => {
  handsFree = event.target.checked;
  if (mode === 'recording') window.__QA__.emit('capsule-state', { state: mode, generation, hands_free: handsFree });
  endDrag(); updateSelection();
};

microphoneButton.onclick = async () => {
  cancelSequence();
  if (microphone || microphonePending) {
    stopMicrophone(); state('recording');
    return;
  }
  stopMicrophone();
  const epoch = inputEpoch;
  microphonePending = true;
  microphoneButton.textContent = 'Cancel microphone';
  note.textContent = 'Allow microphone access to compare your own voice.';
  updateSelection();
  let stream, context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (epoch !== inputEpoch || document.hidden) { stream.getTracks().forEach(track => track.stop()); return; }
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    await context.resume();
    if (epoch !== inputEpoch || document.hidden) { stream.getTracks().forEach(track => track.stop()); await context.close(); return; }
    microphone = { stream, context, analyser, samples: new Float32Array(analyser.fftSize) };
    microphonePending = false;
    microphoneButton.textContent = 'Stop microphone';
    microphoneButton.setAttribute('aria-pressed', 'true');
    note.textContent = 'Microphone on. Audio stays in this tab; no recording is saved.';
    state('recording');
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') await context.close();
    if (epoch !== inputEpoch) return;
    stopMicrophone(); updateSelection();
    note.textContent = 'Microphone unavailable. You can still compare the input examples.';
  }
};

document.getElementById('play').onclick = () => {
  cancelSequence(); state('recording');
  timers = [setTimeout(() => state('transcribing'), 2800), setTimeout(() => state('correcting'), 4000), setTimeout(() => state('done'), 5000)];
};
document.getElementById('fast').onclick = () => {
  cancelSequence(); state('recording');
  timers = [setTimeout(() => state('transcribing'), 1400), setTimeout(() => state('done'), 1430)];
};
document.getElementById('theme').onclick = () => useAppStore.getState().setTheme(useAppStore.getState().theme === 'light' ? 'dark' : 'light');

// Simulate native window dragging within the preview surface. The component
// still invokes Tauri's drag command through the fixture bridge.
const root = document.getElementById('root');
const surface = document.querySelector('.preview');
let placement = { x: 0, y: 0 }, drag;
function place(x, y) {
  const limitX = Math.max(0, (surface.clientWidth - root.offsetWidth) / 2);
  const limitY = Math.max(0, (surface.clientHeight - root.offsetHeight) / 2 - 8);
  placement = { x: Math.max(-limitX, Math.min(limitX, x)), y: Math.max(-limitY, Math.min(limitY, y)) };
  root.style.setProperty('--drag-x', `${placement.x}px`);
  root.style.setProperty('--drag-y', `${placement.y}px`);
}
root.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || !event.target.closest('.capsule-pill.is-draggable') || event.target.closest('button')) return;
  drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...placement } };
  root.setPointerCapture(event.pointerId);
  root.classList.add('is-dragging');
}, { capture: true });
root.addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId || mode !== 'recording' || !handsFree) return;
  place(drag.origin.x + event.clientX - drag.x, drag.origin.y + event.clientY - drag.y);
});
function endDrag() { drag = undefined; root.classList.remove('is-dragging'); }
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);
root.addEventListener('lostpointercapture', endDrag);
document.getElementById('reset-position').onclick = () => place(0, 0);
window.addEventListener('resize', () => place(placement.x, placement.y));

// The real stop button works in the preview too.
window.addEventListener('click', event => {
  if (event.target.closest('#root button[aria-label="Finish dictation"]')) {
    cancelSequence(); state('transcribing');
    timers = [setTimeout(() => state('done'), 1000)];
  }
});
function suspend() { cancelSequence(); clearInterval(audioTimer); stopMicrophone(); updateSelection(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else if (mode === 'recording') startMeter(); });
window.addEventListener('pagehide', suspend);
// Wait for the capsule's IPC listeners rather than relying on a startup delay.
const ready = setInterval(() => {
  if (!window.__QA__.calls.includes('plugin:event|listen')) return;
  clearInterval(ready); state('recording');
}, 50);
