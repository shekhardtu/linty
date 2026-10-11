export const DOUBLE_PRESS_MS = 400;
const TAP_MS = 250;

/**
 * One gesture interpreter for modifier keys and accelerator shortcuts.
 * Times are wall-clock milliseconds: native fn events carry the key's own
 * timestamp, so a webview that runs late never distorts hold or double-press
 * timing. The native session applies the same rules (`dictation.rs`).
 */
export class DictationTrigger {
  private actions: { start: (source: string) => void; stop: () => void; latch: () => void };
  private down = new Set<string>();
  private first: { source: string; at: number } | null = null;
  private held: { source: string; at: number } | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private latched = false;

  constructor(actions: { start: (source: string) => void; stop: () => void; latch: () => void }) {
    this.actions = actions;
  }

  press(source: string, now = Date.now()) {
    if (this.down.has(source)) return; // Ignore key repeat.
    this.down.add(source);
    if (this.latched) {
      this.reset(true);
      this.actions.stop();
      return;
    }
    // Wall-clock gaps are clamped: a backward clock step must not turn a hold
    // into a tap or stretch the double-press window.
    const sinceFirst = this.first ? now - this.first.at : -1;
    if (this.first?.source === source && sinceFirst >= 0 && sinceFirst <= DOUBLE_PRESS_MS) {
      clearTimeout(this.releaseTimer);
      this.first = null;
      this.held = null;
      if (this.active) {
        this.latched = true;
        this.actions.latch();
      }
      return;
    }
    if (this.active) return;
    this.active = true;
    this.first = this.held = { source, at: now };
    this.actions.start(source);
  }

  release(source: string, now = Date.now()) {
    if (!this.down.delete(source) || this.latched || this.held?.source !== source) return;
    const held = Math.max(0, now - this.held.at);
    this.held = null;
    const finish = () => { this.reset(true); this.actions.stop(); };
    if (held >= TAP_MS) finish();
    else this.releaseTimer = setTimeout(finish, Math.min(DOUBLE_PRESS_MS, DOUBLE_PRESS_MS - held));
  }

  reset(keepPressed = false) {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    if (!keepPressed) this.down.clear();
    this.first = this.held = null;
    this.active = this.latched = false;
  }
}
