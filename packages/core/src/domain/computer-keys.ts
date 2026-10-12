/**
 * Computer use: the key combinations a `key` action may send. An allowlist:
 * a combination is sent only if every name in it is in the table below and
 * the combination as a whole isn't one that leaves the approved app (Start,
 * the window switcher, Task Manager, a global shortcut). Anything this can't
 * read is refused, never guessed at.
 *
 * This is the only parser. The tool sends the shell `text`, the canonical
 * form written here, and the card shows the same text; the shell presses it
 * and decides nothing. Pure (no Node imports).
 */
import { asciiLower, cardLine } from './card-text.js';

export type ParsedKeys =
  /** `combos` is one combination (phase 1): its modifiers in `KEY_MODIFIERS` order, then its key. `text` is the same, joined with `+`. */
  | { ok: true; combos: string[][]; text: string }
  | { ok: false; reason: string };

/** The modifiers, in the order a canonical combination lists them. */
export const KEY_MODIFIERS: readonly string[] = Object.freeze(['ctrl', 'alt', 'shift']);

type Token = { kind: 'modifier'; name: string } | { kind: 'key'; name: string } | { kind: 'windows' } | { kind: 'never'; name: string };

const TOKENS = new Map<string, Token>();
const keyNames: string[] = [];

function names(token: Token, ...aliases: string[]): void {
  for (const alias of aliases) TOKENS.set(alias, token);
}

function key(name: string, ...aliases: string[]): void {
  keyNames.push(name);
  names({ kind: 'key', name }, name, ...aliases);
}

names({ kind: 'modifier', name: 'ctrl' }, 'ctrl', 'control', 'ctrl_l', 'control_l', 'ctrl_r', 'control_r');
names({ kind: 'modifier', name: 'alt' }, 'alt', 'alt_l', 'alt_r');
names({ kind: 'modifier', name: 'shift' }, 'shift', 'shift_l', 'shift_r');
names(
  { kind: 'windows' },
  'super', 'super_l', 'super_r', 'win', 'win_l', 'win_r', 'windows', 'windows_l', 'windows_r', 'lwin', 'rwin', 'meta', 'meta_l', 'meta_r', 'cmd', 'command',
  'hyper', 'hyper_l', 'hyper_r', 'mod4', 'os', 'os_l', 'os_r', 'logo', 'start'
);
// Known, and never sent: Print Screen opens the snipping overlay, Caps Lock changes what the user types next.
names({ kind: 'never', name: 'Print Screen' }, 'print', 'printscreen', 'print_screen', 'prtsc', 'prtscr', 'sys_req', 'sysrq', 'snapshot');
names({ kind: 'never', name: 'Caps Lock' }, 'caps_lock', 'capslock');

key('return', 'enter', 'kp_enter');
key('tab');
key('escape', 'esc');
key('backspace');
key('space');
key('delete', 'del');
key('insert', 'ins');
key('home');
key('end');
key('page_up', 'pageup', 'prior', 'pgup');
key('page_down', 'pagedown', 'next', 'pgdn');
key('up', 'arrowup');
key('down', 'arrowdown');
key('left', 'arrowleft');
key('right', 'arrowright');
key('menu');
key('minus');
key('equal', 'plus');
key('comma');
key('period');
key('slash');
key('semicolon');
key('apostrophe');
key('bracketleft');
key('bracketright');
key('backslash');
key('grave');
// F1 to F12 only: F13 to F24 are on no ordinary keyboard and exist to be bound to global macros.
for (let n = 1; n <= 12; n++) key(`f${n}`);
for (const letter of 'abcdefghijklmnopqrstuvwxyz') key(letter);
for (const digit of '0123456789') key(digit);

/**
 * Every key name a canonical combination can hold (never a modifier, the
 * Windows key, Print Screen or Caps Lock). The shell's key table must know
 * each of these and `KEY_MODIFIERS`.
 */
export const KEY_NAMES: readonly string[] = Object.freeze(keyNames);

/** Names a Tauri accelerator uses that a `key` action doesn't (Grunt's own shortcuts are written that way). */
const ACCELERATOR_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['commandorcontrol', 'ctrl'],
  ['commandorctrl', 'ctrl'],
  ['cmdorcontrol', 'ctrl'],
  ['cmdorctrl', 'ctrl'],
  ['option', 'alt'],
  ['backquote', 'grave'],
  ['`', 'grave'],
  ['quote', 'apostrophe'],
  ["'", 'apostrophe'],
  ['-', 'minus'],
  ['=', 'equal'],
  [',', 'comma'],
  ['.', 'period'],
  ['/', 'slash'],
  [';', 'semicolon'],
  ['[', 'bracketleft'],
  [']', 'bracketright'],
  ['\\', 'backslash'],
  ...Array.from('abcdefghijklmnopqrstuvwxyz', (letter): [string, string] => [`key${letter}`, letter]),
  ...Array.from('0123456789', (digit): [string, string] => [`digit${digit}`, digit]),
]);

/**
 * The caps on a `key` action, enforced here before anything is looked up or
 * sent: the text's length (checked before it is split), the names in one
 * combination (three modifiers and one key), and one combination per action.
 */
export const KEY_LIMITS = Object.freeze({ textLength: 64, keysPerCombo: 4, combosPerAction: 1 });

export const KEYS_WINDOWS_REASON = 'Key combinations with the Windows key are never sent.';
const ONE_COMBO_REASON = 'Grunt sends one key combination per action. Send each one as its own action.';
const NO_TEXT_REASON = 'A key action needs one key combination as its text, such as "ctrl+s" or "Return".';

const refuse = (reason: string): ParsedKeys => ({ ok: false, reason });

interface Combo {
  modifiers: Set<string>;
  keys: string[];
  windows: boolean;
  never: string | null;
}

/** The tokens of one combination, or the first token that isn't a known name. */
function comboOf(tokens: readonly string[], aliases?: ReadonlyMap<string, string>): Combo | { unknown: string } {
  const combo: Combo = { modifiers: new Set(), keys: [], windows: false, never: null };
  for (const raw of tokens) {
    const lower = asciiLower(raw);
    const token = TOKENS.get(aliases?.get(lower) ?? lower);
    if (token === undefined) return { unknown: raw };
    if (token.kind === 'modifier') combo.modifiers.add(token.name);
    else if (token.kind === 'key') combo.keys.push(token.name);
    else if (token.kind === 'windows') combo.windows = true;
    else combo.never = token.name;
  }
  return combo;
}

function canonicalText(combo: Combo): string {
  return [...KEY_MODIFIERS.filter((m) => combo.modifiers.has(m)), ...combo.keys].join('+');
}

/**
 * One of Grunt's own global shortcuts as a canonical combination; `null` when
 * it reserves nothing a `key` action could send (blank, or it needs a key that
 * is never sent anyway); `undefined` when it can't be read.
 */
function reservedCombo(entry: unknown): string | null | undefined {
  if (typeof entry !== 'string') return undefined;
  if (entry.trim() === '') return null;
  const combo = comboOf(
    entry.split('+').map((token) => token.trim()),
    ACCELERATOR_ALIASES
  );
  if ('unknown' in combo) return undefined;
  if (combo.windows || combo.never !== null || combo.keys.length === 0) return null;
  if (combo.keys.length > 1) return undefined;
  return canonicalText(combo);
}

/**
 * Reads the text of a `key` action. `reserved` is Grunt's own global
 * shortcuts as the shell registered them (`ComputerDriver.reservedKeys()`):
 * the model may not press them. While one of them can't be read, no
 * combination is sent at all. `null` means the shell has not said what they
 * are: until it does, no combination with a modifier is sent (every global
 * shortcut has one), and a key on its own still is. Leaving `reserved` out
 * means there are none to hold back (the broker and the summary, which only
 * ever run after the tool has checked against the real list).
 */
export function parseKeys(text: unknown, reserved: readonly unknown[] | null = []): ParsedKeys {
  if (typeof text !== 'string') return refuse(NO_TEXT_REASON);
  // The length first, on the text as it came: nothing longer is trimmed, split or searched.
  if (text.length > KEY_LIMITS.textLength) return refuse(`That is too long to be one key combination (at most ${KEY_LIMITS.textLength} characters).`);
  const trimmed = text.replace(/^ +| +$/g, '');
  if (trimmed === '') return refuse(NO_TEXT_REASON);
  // Only ASCII whitespace separates combinations, so this and the shell can
  // never disagree about where one ends; any other odd character makes its
  // token unknown below.
  if (/[ \t\n\r]/.test(trimmed)) return refuse(ONE_COMBO_REASON);

  const tokens = trimmed.split('+');
  if (tokens.length > KEY_LIMITS.keysPerCombo) {
    return refuse(`A key combination is at most ${KEY_LIMITS.keysPerCombo} keys: up to three modifiers and one key.`);
  }
  for (const token of tokens) {
    if (!/^[A-Za-z0-9_]+$/.test(token)) {
      return refuse(token === '' ? `"${cardLine(trimmed, 40)}" isn't a key combination Grunt can read.` : `"${cardLine(token, 40)}" isn't a key name Grunt knows.`);
    }
  }
  const combo = comboOf(tokens);
  if ('unknown' in combo) return refuse(`"${combo.unknown}" isn't a key name Grunt knows.`);
  if (combo.windows) return refuse(KEYS_WINDOWS_REASON);
  if (combo.never !== null) return refuse(`Grunt never sends ${combo.never}.`);
  if (combo.keys.length === 0) return refuse('Grunt never sends a modifier key on its own. Add the key it goes with, as in "ctrl+s".');
  if (combo.keys.length > 1) return refuse('A key combination is one key with its modifiers, as in "ctrl+shift+s".');

  const canonical = canonicalText(combo);
  const pressed = combo.keys[0];
  const ctrl = combo.modifiers.has('ctrl');
  const alt = combo.modifiers.has('alt');
  if (ctrl && alt) {
    return refuse(`Grunt never sends ${canonical}: ctrl+alt combinations belong to Windows and to global shortcuts, not to the app.`);
  }
  // Start (ctrl+escape), Task Manager (ctrl+shift+escape), the window switchers
  // (alt+tab, alt+escape), the window menu (alt+space), and alt with a function
  // key: alt+f4 closes the window, after which the keyboard is some other app's.
  const functionKey = pressed !== undefined && /^f[0-9]+$/.test(pressed);
  if ((pressed === 'escape' && (ctrl || alt)) || (alt && (pressed === 'tab' || pressed === 'space' || functionKey))) {
    return refuse(`Grunt never sends ${canonical}: it leaves the app this action was approved for.`);
  }

  if (reserved === null) {
    if (combo.modifiers.size > 0) {
      return refuse("Grunt doesn't know its own shortcuts yet, so it sends no key combination with a modifier. A single key such as Return still works.");
    }
    return { ok: true, combos: [[...combo.keys]], text: canonical };
  }
  for (const entry of reserved) {
    const held = reservedCombo(entry);
    if (held === undefined) {
      return refuse(`Grunt couldn't read one of its own shortcuts ("${cardLine(entry, 40)}"), so it sends no key combinations until that is fixed.`);
    }
    if (held === canonical) return refuse(`Grunt never sends ${canonical}: it's one of Grunt's own shortcuts.`);
  }
  return { ok: true, combos: [[...KEY_MODIFIERS.filter((m) => combo.modifiers.has(m)), ...combo.keys]], text: canonical };
}
