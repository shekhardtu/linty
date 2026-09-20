export const DOUBLE_PRESS_MS = 400;
const TAP_MS = 250;

/** One gesture interpreter for modifier keys and accelerator shortcuts. */
export class DictationTrigger {
  private actions: { start: () => void; stop: () => void; latch: () => void };
  private down = new Set<string>();
  private first: { source: string; at: number } | null = null;
  private held: { source: string; at: number } | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private latched = false;
  private suppressPressesThrough = -Infinity;

  constructor(actions: { start: () => void; stop: () => void; latch: () => void }) {
    this.actions = actions;
  }

  press(source: string, now = performance.now()) {
    if (this.down.has(source)) return; // Ignore key repeat.
    this.down.add(source);
    // Consume the extra tap if someone still double-presses to finish, even
    // when an empty recording has already returned to idle.
    if (now <= this.suppressPressesThrough) return;
    if (this.latched) {
      this.reset(true);
      this.suppressPressesThrough = now + DOUBLE_PRESS_MS;
      this.actions.stop();
      return;
    }
    if (this.first?.source === source && now - this.first.at <= DOUBLE_PRESS_MS) {
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
    this.actions.start();
  }

  release(source: string, now = performance.now()) {
    if (!this.down.delete(source) || this.latched || this.held?.source !== source) return;
    const pressedAt = this.held.at;
    this.held = null;
    const finish = () => { this.reset(true); this.actions.stop(); };
    if (now - pressedAt >= TAP_MS) finish();
    else this.releaseTimer = setTimeout(finish, Math.max(0, DOUBLE_PRESS_MS - (now - pressedAt)));
  }

  reset(keepPressed = false) {
    // Keep the brief stop guard across async completion/recovery resets. It
    // expires naturally and must not turn a trailing tap into a new recording.
    clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    if (!keepPressed) this.down.clear();
    this.first = this.held = null;
    this.active = this.latched = false;
  }
}
