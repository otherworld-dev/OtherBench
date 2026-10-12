/**
 * Computer use (spec 2026-10-12-computer-use-design section 1): the pure rules
 * the broker, the tool and the web card share. No I/O, no Node APIs (the web
 * app imports this module).
 *
 * Everything that decides or describes is here, once:
 *   - `appKey` checks the one string that names an app (it never repairs one);
 *   - `classifyTarget` turns the facts the shell reports into "refuse" or an
 *     app with a risk;
 *   - `describeApp` is the only source of the name and path a card shows;
 *   - `computerActionOf` builds the action that is sent, and `actionSummary`
 *     describes exactly that;
 *   - `expectationOf` is what the shell must still find true when it acts.
 * The shell sends facts and presses what it is told. It has no copy of any
 * of these rules.
 */
import { cardLine, hasHiddenCharacter, isWellFormedText, revealAllHidden, revealHidden } from './card-text.js';
import { parseKeys } from './computer-keys.js';
import type { ComputerAction, ComputerExpectation } from '../ports/computer.js';

export { KEY_MODIFIERS, KEY_NAMES, KEYS_WINDOWS_REASON, parseKeys, type ParsedKeys } from './computer-keys.js';
export { cardLine } from './card-text.js';

export const COMPUTER_TOOL = 'computer';

export const COMPUTER_ACTIONS = Object.freeze([
  'screenshot',
  'cursor_position',
  'wait',
  'mouse_move',
  'left_click',
  'right_click',
  'double_click',
  'triple_click',
  'scroll',
  'type',
  'key',
] as const);
export type ComputerActionName = (typeof COMPUTER_ACTIONS)[number];

/** Actions that only look. They need no card: the shell's start dialog was the consent to see the screen. */
export const READ_ACTIONS: readonly ComputerActionName[] = Object.freeze<ComputerActionName[]>(['screenshot', 'cursor_position', 'wait']);

export const COMPUTER_OFF_REASON = 'Computer use is turned off for this profile.';
export const COMPUTER_UNATTENDED_REASON = 'Computer use needs someone at the machine; it never runs unattended.';
export const COMPUTER_NO_APP_REASON = "Grunt couldn't tell which app this action would use, so it didn't run it.";
export const COMPUTER_GRUNT_REASON = "That's Grunt's own window. Grunt never controls itself.";
export const COMPUTER_UNCHECKED_REASON = "Grunt couldn't check what kind of window that is, so it didn't use it.";
export const COMPUTER_NO_WINDOW_REASON = "Grunt couldn't pin down which window that is, so it didn't use it.";
export const COMPUTER_BAD_ACTION_REASON = "Grunt can't carry out that action as it was sent, so it didn't run it.";

/** Exactly one of the phase-1 action names: a string, in this spelling and case. */
export function isComputerAction(value: unknown): value is ComputerActionName {
  return typeof value === 'string' && (COMPUTER_ACTIONS as readonly string[]).includes(value);
}

export function isReadAction(value: unknown): boolean {
  return typeof value === 'string' && (READ_ACTIONS as readonly string[]).includes(value);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** ASCII only, so a name's fold never depends on a runtime's Unicode tables (and never makes two names one). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

// ---------------------------------------------------------------------------
// The app key

const MAX_KEY_LENGTH = 1024;
/** Characters no file or folder name has. `:` and `?` also rule out streams and the `\\?\` forms. */
const NOT_IN_A_NAME = /[<>:"/|?*]/;

/**
 * Checks an app's key: the program's canonical final path exactly as the
 * shell resolved it. A valid key comes back unchanged; anything else is
 * `null`. It never trims, folds case or repairs a separator: the shell is the
 * only resolver, and a grant, a card and the act-time expectation all hold
 * this one string and compare it with `===`.
 *
 * Valid: at most 1024 characters; `X:\...` or `\\server\share\...`; at least
 * one name after the root; no `/`; no empty, `.` or `..` segment; no segment
 * ending in a dot or a space; none of `< > : " | ? *` (so no stream and no
 * `\\?\`, `\\.\` or `\??\` form); no hidden, control or bidi character, lone
 * surrogate or U+FFFD.
 */
export function appKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_KEY_LENGTH) return null;
  if (hasHiddenCharacter(raw)) return null;
  let rest: string;
  let least: number;
  if (/^[A-Za-z]:\\/.test(raw)) {
    rest = raw.slice(3);
    least = 1;
  } else if (raw.startsWith('\\\\')) {
    rest = raw.slice(2);
    least = 3;
  } else {
    return null;
  }
  const segments = rest.split('\\');
  if (segments.length < least) return null;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.endsWith('.') || segment.endsWith(' ')) return null;
    if (NOT_IN_A_NAME.test(segment)) return null;
  }
  return raw;
}

function fileNameOf(key: string): string {
  return key.slice(key.lastIndexOf('\\') + 1);
}

export interface AppDescription {
  /** The program's file name with its extension, as it is on disk: `EXCEL.EXE`. */
  name: string;
  /** The key itself: the full path. Show all of it, never cut. */
  path: string;
  /** The file name has a character outside plain ASCII, which can pass for another (say so on the card). */
  unusual: boolean;
}

/**
 * What a card, a summary or a button may call an app: its file name and its
 * full path, both taken from the key and from nothing else. `null` for
 * anything that isn't a valid key. A name the driver or the model supplied
 * (`appName`) is never shown.
 */
export function describeApp(key: unknown): AppDescription | null {
  const valid = appKey(key);
  if (valid === null) return null;
  const name = fileNameOf(valid);
  return { name, path: valid, unusual: !PRINTABLE_ASCII.test(name) };
}

/**
 * A path that did NOT come out of `describeApp` (a stored grant's, say), for
 * display: every hidden, control or bidi character spelled out as `<U+202E>`.
 */
export function pathForCard(path: unknown): string {
  return typeof path === 'string' ? revealAllHidden(path) : '';
}

/**
 * A window's title for a card: one clean line of at most 80 characters. The
 * app sets its own title, so the card labels it as that and never puts it in
 * the headline, the summary or a button.
 */
export function windowTitleForCard(title: unknown): string {
  return cardLine(title, 80);
}

// ---------------------------------------------------------------------------
// Risk

const JETBRAINS = ['idea', 'pycharm', 'webstorm', 'phpstorm', 'clion', 'goland', 'rider', 'rubymine', 'datagrip', 'dataspell', 'rustrover', 'studio', 'aqua', 'fleet', 'writerside'];

/**
 * Programs Grunt asks about every time ("Allow once" only: no grant is stored
 * for them and none is matched), by file name without `.exe`, lower case.
 * They can run commands, change the system, hold credentials, reach another
 * machine, or host content and terminals Grunt can't see into. The list
 * lives here and nowhere else.
 */
export const HIGH_RISK_STEMS: readonly string[] = Object.freeze([
  // Shells and terminals.
  'cmd', 'powershell', 'pwsh', 'powershell_ise', 'windowsterminal', 'wt', 'conhost', 'openconsole', 'wsl', 'wslhost', 'bash', 'sh', 'zsh', 'fish', 'nu',
  'mintty', 'git-bash', 'git-cmd', 'msys2', 'mingw32', 'mingw64', 'ucrt64', 'clang64', 'alacritty', 'wezterm', 'wezterm-gui', 'kitty', 'hyper', 'tabby',
  'cmder', 'far', 'putty', 'plink', 'mobaxterm', 'securecrt', 'ssh', 'sftp', 'telnet', 'ftp', 'debian', 'kali', 'busybox',
  // Script and installer hosts.
  'wscript', 'cscript', 'mshta', 'msiexec', 'regsvr32', 'rundll32', 'appinstaller', 'wusa',
  // Interpreters, and hosts that run somebody else's program under their own name.
  'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'java', 'javaw', 'dotnet', 'electron', 'msedgewebview2', 'wwahost', 'dllhost', 'applicationframehost', 'sihost',
  // Explorer, Start, Search and the other shell surfaces.
  'explorer', 'startmenuexperiencehost', 'searchhost', 'searchapp', 'shellexperiencehost', 'textinputhost', 'pickerhost',
  // Settings and admin tools.
  'systemsettings', 'regedit', 'mmc', 'taskmgr', 'control', 'msconfig', 'perfmon', 'resmon', 'eventvwr', 'netplwiz', 'useraccountcontrolsettings',
  'optionalfeatures', 'rstrui', 'computerdefaults', 'sechealthui',
  // Accessibility input: an on-screen keyboard has a Windows key.
  'osk', 'tabtip', 'magnify', 'narrator', 'voiceaccess', 'atbroker', 'utilman',
  // Credentials and the lock screen.
  'credentialuibroker', 'consent', 'logonui', 'lockapp',
  // Remote desktop and VM clients: another machine in a window.
  'mstsc', 'msrdc', 'vmconnect', 'vmware', 'vmplayer', 'virtualbox', 'virtualboxvm', 'anydesk', 'teamviewer', 'rustdesk', 'parsecd', 'vncviewer',
  // Password managers.
  '1password', 'keepass', 'keepassxc', 'bitwarden', 'lastpass', 'dashlane',
  // Browsers: devtools, javascript: addresses, and Grunt's own pages in a tab. Grunt has its own browser for the web.
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'chromium', 'iexplore',
  // Editors and IDEs with a terminal inside. JetBrains launchers are named per product, with and without "64".
  'code', 'code - insiders', 'vscodium', 'cursor', 'windsurf', 'devenv',
  ...JETBRAINS.flatMap((product) => [product, `${product}64`]),
]);

/**
 * Families: a name that STARTS with one of these is high-risk too
 * (`python3.12.exe`, `pythonw.exe`, `ubuntu2204.exe`, `conemu64.exe`,
 * `SystemPropertiesAdvanced.exe`).
 */
export const HIGH_RISK_FAMILIES: readonly string[] = Object.freeze(['python', 'ubuntu', 'conemu', 'systemproperties']);

const HIGH_RISK_STEM_SET: ReadonlySet<string> = new Set(HIGH_RISK_STEMS);
/** Grunt's own programs. A window of one is refused outright, whatever the shell said about whose it is. */
const GRUNT_STEMS: ReadonlySet<string> = new Set(['grunt', 'grunt-desktop']);

function isListedStem(stem: string): boolean {
  return HIGH_RISK_STEM_SET.has(stem) || HIGH_RISK_FAMILIES.some((family) => stem.startsWith(family));
}

/**
 * A program file name's stem (`EXCEL.EXE` gives `excel`), or `null` when the
 * name can't be vouched for: not text, a character outside plain ASCII, no
 * `.exe`, nothing before it, a stem ending in a dot or space, or an
 * 8.3-looking short name (`POWERS~1.EXE`), which hides the real one.
 */
function exeStem(name: unknown): string | null {
  if (typeof name !== 'string' || !PRINTABLE_ASCII.test(name)) return null;
  const lower = asciiLower(name);
  if (!lower.endsWith('.exe')) return null;
  const stem = lower.slice(0, -4);
  if (stem === '' || stem.endsWith('.') || stem.endsWith(' ') || /~\d/.test(stem)) return null;
  return stem;
}

/**
 * Whether a program's file name (with extension, any letter case) is one
 * Grunt asks about every time. True for every name on the list or in a
 * family, for Grunt's own, and for any name that can't be vouched for
 * (see `exeStem`): unknown is never ordinary.
 */
export function isHighRiskProgramName(name: string): boolean {
  const stem = exeStem(name);
  return stem === null || GRUNT_STEMS.has(stem) || isListedStem(stem);
}

type Risk = 'normal' | 'high' | 'grunt';

/** What the key alone says: its file name, and whether any part of the path is a short (8.3) name. */
function keyRisk(key: string): Risk {
  const stem = exeStem(fileNameOf(key));
  if (stem !== null && GRUNT_STEMS.has(stem)) return 'grunt';
  if (stem === null || isListedStem(stem)) return 'high';
  return /~\d/.test(key) ? 'high' : 'normal';
}

/**
 * What the name the program was BUILT with says (VERSIONINFO
 * OriginalFilename): a renamed copy of a shell still carries it. `null`
 * (the image has none) says nothing; anything that isn't text is high.
 */
function originalNameRisk(original: unknown): Risk {
  if (original === null) return 'normal';
  if (typeof original !== 'string' || !PRINTABLE_ASCII.test(original)) return 'high';
  let stem = asciiLower(original).trim();
  if (stem.endsWith('.mui')) stem = stem.slice(0, -4);
  if (stem.endsWith('.exe')) stem = stem.slice(0, -4);
  if (stem === '') return 'high';
  if (GRUNT_STEMS.has(stem)) return 'grunt';
  return isListedStem(stem) ? 'high' : 'normal';
}

function isOpaqueId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !hasHiddenCharacter(value);
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const MAX_WINDOW_ID = 128;
const MAX_STARTED_AT = 64;

export type ClassifiedApp = {
  kind: 'app';
  /** The app's key: the validated path, unchanged. */
  key: string;
  /** `describeApp(key).name`. */
  name: string;
  /** The window title, already one clean bounded line. */
  title: string;
  risk: 'normal' | 'high';
  windowId: string;
  pid: number;
  startedAt: string;
};
export type ClassifiedTarget = { kind: 'refuse'; reason: string } | ClassifiedApp;

/**
 * Decides what a target the driver reported is: something Grunt never
 * touches (a refusal, with no card), or an app with a risk. The ONLY place
 * that is decided, and it fails closed: a missing or wrong-typed fact is a
 * refusal or high risk, never an ordinary app.
 *
 * Refused: no valid path; a Grunt window or program; an elevated process;
 * one with UI access; a flag for any of those that isn't a boolean; no
 * window, pid or start time to bind the action to.
 *
 * High risk (asked about every time): a name on the list or in a family, by
 * file name or by the name the program was built with; a name that can't be
 * vouched for; a short (8.3) segment anywhere in the path; a console
 * program; a program not on a fixed disk; an unsigned one; any other fact
 * missing or of the wrong type.
 */
export function classifyTarget(target: unknown): ClassifiedTarget {
  const refuse = (reason: string): ClassifiedTarget => ({ kind: 'refuse', reason });
  const t = recordOf(target);
  if (t === null) return refuse(COMPUTER_NO_APP_REASON);
  // The driver's own refusal ("no window there").
  if (typeof t['refuse'] === 'string') return refuse(cardLine(t['refuse'], 200) || COMPUTER_NO_APP_REASON);

  const key = appKey(t['path']);
  if (key === null) return refuse(COMPUTER_NO_APP_REASON);
  const name = fileNameOf(key);
  const shown = cardLine(name, 80);
  const byKey = keyRisk(key);
  const byOriginalName = t['originalName'] === undefined ? 'high' : originalNameRisk(t['originalName']);

  if (t['grunt'] === true || byKey === 'grunt' || byOriginalName === 'grunt') return refuse(COMPUTER_GRUNT_REASON);
  if (t['grunt'] !== false) return refuse(COMPUTER_UNCHECKED_REASON);
  if (t['elevated'] === true) return refuse(`${shown} is running as administrator, so Grunt can't control it.`);
  if (t['elevated'] !== false) return refuse(COMPUTER_UNCHECKED_REASON);
  if (t['uiAccess'] === true) return refuse(`${shown} can control other apps (UI access), so Grunt doesn't control it.`);
  if (t['uiAccess'] !== false) return refuse(COMPUTER_UNCHECKED_REASON);

  const windowId = t['windowId'];
  const pid = t['pid'];
  const startedAt = t['startedAt'];
  if (!isOpaqueId(windowId, MAX_WINDOW_ID) || !isPid(pid) || !isOpaqueId(startedAt, MAX_STARTED_AT)) return refuse(COMPUTER_NO_WINDOW_REASON);

  const ordinary =
    byKey === 'normal' &&
    byOriginalName === 'normal' &&
    typeof t['signer'] === 'string' &&
    t['signer'].trim() !== '' &&
    t['console'] === false &&
    t['location'] === 'fixed' &&
    typeof t['title'] === 'string';
  return { kind: 'app', key, name, title: windowTitleForCard(t['title']), risk: ordinary ? 'normal' : 'high', windowId, pid, startedAt };
}

/**
 * The fields `describeCall` adds to a call's arguments. The model's own
 * copies of them are thrown away first; these always come from `appArgs`.
 */
export const APP_ARG_FIELDS = Object.freeze(['app', 'appName', 'appTitle', 'appRisk', 'appWindow', 'appPid', 'appStarted'] as const);

/** The described-call fields for a classified app. `appName` is for convenience only: nothing reads it back (see `describeApp`). */
export function appArgs(app: ClassifiedApp): Record<(typeof APP_ARG_FIELDS)[number], unknown> {
  return { app: app.key, appName: app.name, appTitle: app.title, appRisk: app.risk, appWindow: app.windowId, appPid: app.pid, appStarted: app.startedAt };
}

/**
 * Whether described call arguments are for an app Grunt asks about every
 * time. True unless the call is provably ordinary: a valid key, a risk of
 * exactly `'normal'` from `classifyTarget`, and a key that itself says
 * nothing against it (so a call can't talk a listed program down by claiming
 * `'normal'`). Anything missing, malformed or unknown is high risk.
 */
export function isHighRiskApp(args: unknown): boolean {
  const a = recordOf(args);
  if (a === null) return true;
  const key = appKey(a['app']);
  if (key === null || a['appRisk'] !== 'normal') return true;
  return keyRisk(key) !== 'normal';
}

/**
 * What the shell must still find true when it carries the call out, from the
 * described arguments: the app, the window and the run of the program the
 * card was about. `null` unless every part is present and well-typed, and
 * then the call must not run: there is no acting without an expectation.
 */
export function expectationOf(args: unknown): ComputerExpectation | null {
  const a = recordOf(args);
  if (a === null) return null;
  const app = appKey(a['app']);
  const windowId = a['appWindow'];
  const pid = a['appPid'];
  const startedAt = a['appStarted'];
  if (app === null || !isOpaqueId(windowId, MAX_WINDOW_ID) || !isPid(pid) || !isOpaqueId(startedAt, MAX_STARTED_AT)) return null;
  return { app, windowId, pid, startedAt };
}

// ---------------------------------------------------------------------------
// Actions

/** Windows' own limit on a screen coordinate; no screenshot is wider. */
const MAX_COORDINATE = 32767;

/**
 * `args.coordinate` as whole pixels (rounded DOWN, so a point inside the
 * last pixel stays inside), or null unless it is exactly two finite,
 * non-negative numbers no greater than 32767 and, when `bounds` (the last
 * screenshot's size) is given, inside it.
 */
export function coordinateOf(args: unknown, bounds?: { width: number; height: number }): [number, number] | null {
  const a = recordOf(args);
  if (a === null) return null;
  const c = a['coordinate'];
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [rawX, rawY] = c as unknown[];
  if (typeof rawX !== 'number' || typeof rawY !== 'number' || !Number.isFinite(rawX) || !Number.isFinite(rawY) || rawX < 0 || rawY < 0) return null;
  const x = Math.floor(rawX);
  const y = Math.floor(rawY);
  if (x > MAX_COORDINATE || y > MAX_COORDINATE) return null;
  if (bounds !== undefined) {
    const { width, height } = bounds;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (x >= width || y >= height) return null;
  }
  return [x, y];
}

const MAX_WAIT_S = 10;

/** How long a `wait` waits: its `duration` held between 0 and 10 seconds, to a tenth; 1 when it isn't a finite number. */
export function waitSeconds(duration: unknown): number {
  if (typeof duration !== 'number' || !Number.isFinite(duration)) return 1;
  return Math.round(Math.min(MAX_WAIT_S, Math.max(0, duration)) * 10) / 10;
}

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const DEFAULT_SCROLL_AMOUNT = 3;

/**
 * The action the driver is sent, built from validated values only, or
 * `null` when the arguments don't make one (the looking actions make none:
 * the driver has its own calls for those).
 *
 *   - a coordinate must pass `coordinateOf` (with `bounds`, when given);
 *   - a scroll needs a direction from the four and a whole amount from 1 to
 *     10 (3 when left out);
 *   - typed text must be non-empty and well-formed (no lone surrogate);
 *   - a key must pass `parseKeys` (with `reserved`), and is sent as the
 *     canonical combination, never as the model wrote it.
 */
export function computerActionOf(args: unknown, options: { bounds?: { width: number; height: number }; reserved?: readonly unknown[] } = {}): ComputerAction | null {
  const a = recordOf(args);
  if (a === null) return null;
  const action = a['action'];
  switch (action) {
    case 'mouse_move':
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      const coordinate = coordinateOf(a, options.bounds);
      return coordinate ? { action, coordinate } : null;
    }
    case 'scroll': {
      const coordinate = coordinateOf(a, options.bounds);
      const direction = SCROLL_DIRECTIONS.find((d) => d === a['scroll_direction']);
      const amount = a['scroll_amount'] ?? DEFAULT_SCROLL_AMOUNT;
      if (!coordinate || direction === undefined) return null;
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 10) return null;
      return { action, coordinate, scroll_direction: direction, scroll_amount: amount };
    }
    case 'type': {
      const text = a['text'];
      return isWellFormedText(text) && text.length > 0 ? { action, text } : null;
    }
    case 'key': {
      const parsed = parseKeys(a['text'], options.reserved);
      return parsed.ok ? { action, text: parsed.text } : null;
    }
    default:
      return null;
  }
}

/**
 * The text a `type` action will type, in full, for the card to show in its
 * own box: line breaks and tabs kept, every hidden or bidi character spelled
 * out as `<U+202E>`. `null` for any other call. Only the card shows this: no
 * summary, banner, event or audit ever holds typed text.
 */
export function typedTextForCard(args: unknown): string | null {
  const a = recordOf(args);
  if (a === null || a['action'] !== 'type' || typeof a['text'] !== 'string') return null;
  return revealHidden(a['text']);
}

const VERBS: Readonly<Record<Exclude<ComputerActionName, 'screenshot' | 'cursor_position' | 'wait'>, string>> = {
  mouse_move: 'move the mouse',
  left_click: 'click',
  right_click: 'right-click',
  double_click: 'double-click',
  triple_click: 'triple-click',
  scroll: 'scroll',
  type: 'type',
  key: 'press',
};

/**
 * One short line saying what an action does, for the card's summary, the
 * banner and the indicator. It is made from the action `computerActionOf`
 * builds, so it says what will be sent and holds no value that wasn't
 * validated: an action that doesn't validate reads `click ?`, and a name
 * that isn't an action reads `?`. It never holds typed text, only how much
 * of it there is (`typedTextForCard` is where a card shows the text).
 */
export function actionSummary(args: unknown): string {
  const a = recordOf(args);
  const name = a?.['action'];
  if (a === null || !isComputerAction(name)) return '?';
  if (name === 'screenshot') return 'take a screenshot';
  if (name === 'cursor_position') return 'read the cursor position';
  if (name === 'wait') return `wait ${waitSeconds(a['duration'])} s`;

  const action = computerActionOf(a);
  if (action === null) return `${VERBS[name]} ?`;
  switch (action.action) {
    case 'mouse_move':
      return `move the mouse to ${action.coordinate[0]}, ${action.coordinate[1]}`;
    case 'scroll':
      return `scroll ${action.scroll_direction} ${action.scroll_amount} at ${action.coordinate[0]}, ${action.coordinate[1]}`;
    case 'type': {
      const characters = Array.from(action.text).length;
      const lines = action.text.split(/\r\n|\r|\n/).length;
      return `type ${characters} ${characters === 1 ? 'character' : 'characters'}${lines > 1 ? ` (${lines} lines)` : ''}`;
    }
    case 'key':
      return `press ${action.text}`;
    default:
      return `${VERBS[action.action]} at ${action.coordinate[0]}, ${action.coordinate[1]}`;
  }
}
