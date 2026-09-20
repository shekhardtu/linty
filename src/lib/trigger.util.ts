import {
  TRIGGER_KEY_FN,
  MODIFIER_TRIGGER_PREFIX,
  TRIGGER_KEY_OPTIONS,
} from "@/store/slices/settings.slice";

/**
 * Names accepted by the Rust set_trigger_modifier command, keyed by DOM
 * KeyboardEvent.code. Shift keys are deliberately absent — every capitalized
 * keystroke holds Shift, so a Shift trigger would phantom-record constantly.
 */
export const MODIFIER_CAPTURE_CODES: Record<string, string> = {
  MetaLeft: "left-command",
  MetaRight: "right-command",
  AltLeft: "left-option",
  AltRight: "right-option",
  ControlLeft: "left-control",
  ControlRight: "right-control",
};

export const MODIFIER_HOLD_LABELS: Record<string, string> = {
  "left-command": "Left ⌘",
  "right-command": "Right ⌘",
  "left-option": "Left ⌥",
  "right-option": "Right ⌥",
  "left-control": "Left ⌃",
  "right-control": "Right ⌃",
};

/**
 * Shortcuts so universal that capturing one as the trigger would silently
 * hijack it in every app. The picker requires an explicit confirm for these.
 */
export const COMMON_SHORTCUT_USAGE: Record<string, string> = {
  "Command+C": "Copy",
  "Command+V": "Paste",
  "Command+X": "Cut",
  "Command+A": "Select All",
  "Command+Z": "Undo",
  "Command+S": "Save",
  "Command+F": "Find",
  "Command+N": "New",
  "Command+T": "New Tab",
  "Command+W": "Close Window",
  "Command+Q": "Quit",
  "Command+Space": "Spotlight",
  "Command+Tab": "App Switcher",
};

const ACCELERATOR_SYMBOLS: Record<string, string> = {
  Command: "⌘",
  CommandOrControl: "⌘",
  Super: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
};

/** True for triggers handled by the Rust flagsChanged monitor (fn or a bare modifier). */
export function isModifierHoldTrigger(value: string): boolean {
  return value === TRIGGER_KEY_FN || value.startsWith(MODIFIER_TRIGGER_PREFIX);
}

/** The name to pass to set_trigger_modifier for a modifier-hold trigger. */
export function triggerModifierName(value: string): string {
  return value === TRIGGER_KEY_FN
    ? TRIGGER_KEY_FN
    : value.slice(MODIFIER_TRIGGER_PREFIX.length);
}

/** Short human label: "fn key", "Right ⌘", "⌘⇧Space". */
export function formatTriggerLabel(value: string): string {
  const preset = TRIGGER_KEY_OPTIONS.find((o) => o.value === value);
  if (preset) return preset.label;
  if (value.startsWith(MODIFIER_TRIGGER_PREFIX)) {
    return MODIFIER_HOLD_LABELS[triggerModifierName(value)] ?? value;
  }
  return value
    .split("+")
    .map((token) => ACCELERATOR_SYMBOLS[token] ?? token)
    .join("");
}

/** Compact keycap text; prose can still say “fn key”. */
export function formatTriggerKeycap(value: string): string {
  return value === TRIGGER_KEY_FN ? "fn" : formatTriggerLabel(value);
}

/** kbd-style display: "fn (hold)", "⌘⇧Space (hold)". */
export function formatTriggerDisplay(value: string): string {
  const preset = TRIGGER_KEY_OPTIONS.find((o) => o.value === value);
  return preset ? preset.display : `${formatTriggerLabel(value)} (hold)`;
}

/**
 * Map a DOM KeyboardEvent.code to a global-shortcut accelerator key token.
 * Returns null for keys the shortcut plugin can't register.
 */
export function codeToAcceleratorKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const map: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Backquote: "`",
  };
  return map[code] ?? null;
}
