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
 *   - `parseAction` checks a whole action against every rule and cap and
 *     builds the one that is carried out, and `actionSummary` describes
 *     exactly that;
 *   - `classifyTarget` describes a target once, in one frozen object, and
 *     `describedCallArgs` is how it reaches the card, the grant and the action;
 *   - `expectationOf` is what the shell must still find true when it acts.
 * The shell sends facts and presses what it is told. It has no copy of any
 * of these rules.
 */
import { asciiLower, cardLine, hasHiddenCharacter, isWellFormedText, revealAllHidden, revealHidden } from './card-text.js';
import { KEY_LIMITS, parseKeys } from './computer-keys.js';
import type { ComputerAction, ComputerExpectation } from '../ports/computer.js';

export { KEY_LIMITS, KEY_MODIFIERS, KEY_NAMES, KEYS_WINDOWS_REASON, parseKeys, type ParsedKeys } from './computer-keys.js';
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

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

// ---------------------------------------------------------------------------
// The app key

const MAX_KEY_LENGTH = 1024;
const MAX_WINDOW_TITLE = 80;
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

/**
 * A space that is not the plain one (U+0020): no-break, en, em, thin, narrow
 * no-break, ideographic and the rest of Unicode's space separators. One of
 * these in a folder or file name reads as a plain space, or as nothing at
 * the end of a name.
 */
function isOddSpace(cp: number): boolean {
  return cp === 0x00a0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/**
 * Part of a key as a person should see it. Letters are shown as they are,
 * whatever the script (the `unusual` flag is what warns about those); a
 * space that is not the plain one is spelled out as `<U+00A0>`, since it
 * can be told from a plain space, or from nothing, in no other way. Display
 * only: identity is the key itself. (A hidden, control or bidi character
 * never gets this far: `appKey` refuses it anywhere in a key.)
 */
function shown(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isOddSpace(cp) ? `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>` : ch;
  }
  return revealAllHidden(out);
}
function fileNameOf(key: string): string {
  return key.slice(key.lastIndexOf('\\') + 1);
}

export interface AppDescription {
  /** The key itself, unchanged: what a grant holds and what is compared. Never show this one. */
  key: string;
  /** The program's file name with its extension, as it is on disk, for display: `EXCEL.EXE`. */
  name: string;
  /** The full path, for display. Show all of it, never cut. */
  path: string;
  /**
   * The path has a character outside plain ASCII somewhere: a letter from
   * another script, a full-width form, a combining mark, an odd space. Such
   * a path can read exactly like another, so the card must say so, and the
   * app is asked about every time.
   */
  unusual: boolean;
}

/**
 * What a card, a summary or a button may call an app: its file name and its
 * full path, both taken from the key and from nothing else, in the form a
 * person should see (`shown`). `null` for anything that is not a valid key.
 * A name the driver or the model supplied (`appName`) is never shown.
 *
 * Identity never rests on how a path looks: two paths that read alike are
 * still two keys, compared byte for byte. This only decides what is
 * displayed, and `unusual` says when the display cannot be trusted to tell
 * them apart.
 */
export function describeApp(key: unknown): AppDescription | null {
  const valid = appKey(key);
  if (valid === null) return null;
  return { key: valid, name: shown(fileNameOf(valid)), path: shown(valid), unusual: !PRINTABLE_ASCII.test(valid) };
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
  return cardLine(title, MAX_WINDOW_TITLE);
}

// ---------------------------------------------------------------------------
// Risk

const JETBRAINS = ['idea', 'pycharm', 'webstorm', 'phpstorm', 'clion', 'goland', 'rider', 'rubymine', 'datagrip', 'dataspell', 'rustrover', 'studio', 'aqua', 'fleet', 'writerside', 'gateway', 'mps'];

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
  'quickassist', 'msra', 'mremoteng', 'rdcman',
  // File managers and "Open with": they start any program and open any file.
  'doublecmd', 'dopus', 'openwith',
  // Password managers.
  '1password', 'keepass', 'keepassxc', 'bitwarden', 'lastpass', 'dashlane',
  // Browsers: devtools, javascript: addresses, and Grunt's own pages in a tab. Grunt has its own browser for the web.
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'chromium', 'iexplore',
  // Editors and IDEs with a terminal inside. JetBrains launchers are named per product, with and without "64".
  'code', 'code - insiders', 'vscodium', 'cursor', 'windsurf', 'devenv', 'zed',
  // Editors that run plugins, macros or build commands.
  'notepad++', 'sublime_text',
  ...JETBRAINS.flatMap((product) => [product, `${product}64`]),
]);

/**
 * Families: a name that STARTS with one of these is high-risk too
 * (`python3.12.exe`, `pythonw.exe`, `ubuntu2204.exe`, `conemu64.exe`,
 * `SystemPropertiesAdvanced.exe`, `WindowsSandboxClient.exe`,
 * `TOTALCMD64.EXE`, `AutoHotkeyU64.exe`).
 */
export const HIGH_RISK_FAMILIES: readonly string[] = Object.freeze(['python', 'ubuntu', 'conemu', 'systemproperties', 'windowssandbox', 'totalcmd', 'autohotkey']);

/**
 * Publishers whose every program is asked about each time, by a word in the
 * verified signer (any letter case). JetBrains: all its IDEs have a terminal,
 * and a product that is on no list yet is covered the day it ships.
 */
const HIGH_RISK_SIGNERS: readonly string[] = Object.freeze(['jetbrains']);

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

/** What the key alone says: its file name, and whether the path is one Grunt can't take at its word. */
function keyRisk(key: string): Risk {
  const stem = exeStem(fileNameOf(key));
  if (stem !== null && GRUNT_STEMS.has(stem)) return 'grunt';
  if (stem === null || isListedStem(stem)) return 'high';
  // A short (8.3) segment hides the real name; a share does not pin what a
  // path names, whatever kind of drive it is said to be on; and a character
  // outside plain ASCII ANYWHERE in the path (a letter from another script,
  // a full-width form, a combining mark, an odd space) can make one path
  // read as another. No list of look-alikes is ever complete, so none is
  // kept: anything that is not plain ASCII asks every time.
  if (/~\d/.test(key) || key.startsWith('\\\\') || !PRINTABLE_ASCII.test(key)) return 'high';
  return 'normal';
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

/** A verified signer that says nothing against the program: a non-empty name with no word from `HIGH_RISK_SIGNERS` in it. */
function isTrustedSigner(signer: unknown): boolean {
  if (typeof signer !== 'string' || signer.trim() === '') return false;
  const lower = asciiLower(signer);
  return !HIGH_RISK_SIGNERS.some((word) => lower.includes(word));
}

function isOpaqueId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !hasHiddenCharacter(value);
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const MAX_WINDOW_ID = 128;
const MAX_STARTED_AT = 64;

/**
 * A target, described once. This one frozen object is the single input to
 * everything that follows: the card (`describeApp(key)`, `title`), the
 * grant's key (`key`), the risk (`risk`, `shellView`) and the action's
 * expectation (`key`, `shellView`, `windowId`, `pid`, `startedAt`). It goes
 * into the described call arguments as it stands (`describedCallArgs`), and
 * every later reader (`isHighRiskApp`, `expectationOf`, the broker) reads
 * those fields and nothing else. Nothing is classified a second time: after
 * approval the driver only checks that the live window still has the same
 * facts, and refuses when it does not.
 */
export type DescribedTarget = Readonly<{
  kind: 'app';
  /** The app's key: the validated path, unchanged. */
  key: string;
  /** `describeApp(key).name`. */
  name: string;
  /** The window title, already one clean bounded line. */
  title: string;
  risk: 'normal' | 'high';
  /**
   * The window is a file dialog or shell file view. `true` also when the
   * driver did not say (not knowing counts as being one). Part of the
   * expectation: the same window must still be, or still not be, one when
   * the action is carried out.
   */
  shellView: boolean;
  windowId: string;
  pid: number;
  startedAt: string;
}>;
/** The older name for a `DescribedTarget`. */
export type ClassifiedApp = DescribedTarget;
export type ClassifiedTarget = Readonly<{ kind: 'refuse'; reason: string }> | DescribedTarget;
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
 * vouched for; a short (8.3) segment, or any character outside plain ASCII,
 * anywhere in the path;
 * a path on a share; a console program; a program not on a fixed disk; an
 * unsigned one, or one signed by a publisher in `HIGH_RISK_SIGNERS`; a file
 * dialog or shell file view (`shellView`), which belongs to an ordinary app's
 * process and can open or run any file; any other fact missing or of the
 * wrong type.
 */
export function classifyTarget(target: unknown): ClassifiedTarget {
  const refuse = (reason: string): ClassifiedTarget => Object.freeze({ kind: 'refuse', reason });
  const t = recordOf(target);
  if (t === null) return refuse(COMPUTER_NO_APP_REASON);
  // The driver's own refusal ("no window there").
  if (typeof t['refuse'] === 'string') return refuse(cardLine(t['refuse'], 200) || COMPUTER_NO_APP_REASON);

  const key = appKey(t['path']);
  if (key === null) return refuse(COMPUTER_NO_APP_REASON);
  const name = shown(fileNameOf(key));
  const said = cardLine(name, 80);
  const byKey = keyRisk(key);
  const byOriginalName = t['originalName'] === undefined ? 'high' : originalNameRisk(t['originalName']);

  if (t['grunt'] === true || byKey === 'grunt' || byOriginalName === 'grunt') return refuse(COMPUTER_GRUNT_REASON);
  if (t['grunt'] !== false) return refuse(COMPUTER_UNCHECKED_REASON);
  if (t['elevated'] === true) return refuse(`${said} is running as administrator, so Grunt can't control it.`);
  if (t['elevated'] !== false) return refuse(COMPUTER_UNCHECKED_REASON);
  if (t['uiAccess'] === true) return refuse(`${said} can control other apps (UI access), so Grunt doesn't control it.`);
  if (t['uiAccess'] !== false) return refuse(COMPUTER_UNCHECKED_REASON);

  const windowId = t['windowId'];
  const pid = t['pid'];
  const startedAt = t['startedAt'];
  if (!isOpaqueId(windowId, MAX_WINDOW_ID) || !isPid(pid) || !isOpaqueId(startedAt, MAX_STARTED_AT)) return refuse(COMPUTER_NO_WINDOW_REASON);

  // Not knowing whether the window is a file view counts as its being one.
  const shellView = t['shellView'] !== false;
  const ordinary =
    byKey === 'normal' &&
    byOriginalName === 'normal' &&
    isTrustedSigner(t['signer']) &&
    t['console'] === false &&
    !shellView &&
    t['location'] === 'fixed' &&
    typeof t['title'] === 'string';
  return Object.freeze({ kind: 'app', key, name, title: windowTitleForCard(t['title']), risk: ordinary ? 'normal' : 'high', shellView, windowId, pid, startedAt });
}

/**
 * The fields `describeCall` adds to a call's arguments, and the ONLY fields
 * a target is ever read back from. The model can send fields with these
 * names; none of them survives: the described arguments are built from the
 * parsed action and the described target alone (`describedCallArgs`).
 */
export const APP_ARG_FIELDS = Object.freeze(['app', 'appName', 'appTitle', 'appRisk', 'appShellView', 'appWindow', 'appPid', 'appStarted'] as const);

/** A described target as call-argument fields. `appName` and `appTitle` are for display only: nothing decides on them. */
export function appArgs(target: DescribedTarget): Record<(typeof APP_ARG_FIELDS)[number], unknown> {
  return {
    app: target.key,
    appName: target.name,
    appTitle: target.title,
    appRisk: target.risk,
    appShellView: target.shellView,
    appWindow: target.windowId,
    appPid: target.pid,
    appStarted: target.startedAt,
  };
}

/**
 * The described arguments of a call that changes something: the action
 * `parseAction` returned and the target `classifyTarget` described, and
 * nothing else. Nothing the model sent is copied across, so a field it
 * forged (`appShellView: false`, another `app`) cannot survive. Frozen: the
 * card, the grant, the risk and the expectation are all read from this one
 * object, which nothing changes between the decision and the action.
 */
export function describedCallArgs(action: ComputerAction, target: DescribedTarget): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...action, ...appArgs(target) });
}

/**
 * Whether described call arguments are for something Grunt asks about every
 * time. Read from the described fields alone (`app`, `appRisk`,
 * `appShellView`), never from live state. True unless the call is provably
 * ordinary: a valid key, a risk of exactly `'normal'` from `classifyTarget`,
 * a window that is exactly not a file view, and a key that itself says
 * nothing against it (so described arguments cannot talk a listed program,
 * a share or an odd path down by claiming `'normal'`). Anything missing,
 * malformed or unknown is high risk.
 */
export function isHighRiskApp(args: unknown): boolean {
  const a = recordOf(args);
  if (a === null) return true;
  const key = appKey(a['app']);
  if (key === null || a['appRisk'] !== 'normal' || a['appShellView'] !== false) return true;
  return keyRisk(key) !== 'normal';
}

/**
 * What the shell must still find true when it carries the call out, read
 * from the described arguments: the app, whether its window is a file
 * view, the window and the run of the program the card was about. `null`
 * unless every part is present and well-typed, and then the call must not
 * run: there is no acting without an expectation. Frozen.
 */
export function expectationOf(args: unknown): ComputerExpectation | null {
  const a = recordOf(args);
  if (a === null) return null;
  const app = appKey(a['app']);
  const shellView = a['appShellView'];
  const windowId = a['appWindow'];
  const pid = a['appPid'];
  const startedAt = a['appStarted'];
  if (app === null || typeof shellView !== 'boolean') return null;
  if (!isOpaqueId(windowId, MAX_WINDOW_ID) || !isPid(pid) || !isOpaqueId(startedAt, MAX_STARTED_AT)) return null;
  return Object.freeze({ app, shellView, windowId, pid, startedAt });
}
// ---------------------------------------------------------------------------
// Actions

/**
 * Every cap on a computer action, in one place. `parseAction` enforces all of
 * them before anything is dispatched; the driver's side enforces them again
 * (the fake driver does, so a layer that skipped `parseAction` fails a test).
 */
export const COMPUTER_LIMITS = Object.freeze({
  /** A `key` action's text, in UTF-16 units, measured before it is trimmed or split. */
  keyTextLength: KEY_LIMITS.textLength,
  /** Names in one key combination: up to three modifiers and one key. */
  keysPerCombo: KEY_LIMITS.keysPerCombo,
  /** Key combinations in one `key` action. */
  combosPerKeyAction: KEY_LIMITS.combosPerAction,
  /** A `type` action's text, in characters (code points). */
  typeTextLength: 4000,
  scrollAmountMin: 1,
  scrollAmountMax: 10,
  scrollAmountDefault: 3,
  /** A `wait`, in seconds: a longer one is cut to this. */
  waitMax: 10,
  waitDefault: 1,
  /** A coordinate, whatever the screenshot's size (Windows' own limit). */
  coordinateMax: 32767,
  /** An app key (a program path), in UTF-16 units. */
  appKeyLength: MAX_KEY_LENGTH,
  windowIdLength: MAX_WINDOW_ID,
  startedAtLength: MAX_STARTED_AT,
  /** A window title on a card, in characters. */
  windowTitleLength: MAX_WINDOW_TITLE,
});

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
  if (x > COMPUTER_LIMITS.coordinateMax || y > COMPUTER_LIMITS.coordinateMax) return null;
  if (bounds !== undefined) {
    const { width, height } = bounds;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (x >= width || y >= height) return null;
  }
  return [x, y];
}

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

/** An action that only looks, in the one form it is carried out in. A wait's `duration` (seconds) is already held to the cap. */
export type ComputerLook = { action: 'screenshot' } | { action: 'cursor_position' } | { action: 'wait'; duration: number };

export type ParsedAction = { ok: true; action: ComputerLook | ComputerAction } | { ok: false; reason: string };

/**
 * Why a `type` action's text can't be typed, or null. Typed text is sent as
 * characters, so a line break is Enter and a tab is Tab, and both are allowed
 * (the card shows them, and the summary counts the lines). Every other
 * control character (C0, DEL, C1: Escape, backspace, NUL...) is refused, and
 * so is a lone surrogate, which is no character at all.
 */
function typedTextProblem(text: string): string | null {
  // In UTF-16 units first, so nothing far over the cap is walked through.
  if (text.length > COMPUTER_LIMITS.typeTextLength * 2) return TOO_MUCH_TO_TYPE;
  let characters = 0;
  for (const ch of text) {
    characters += 1;
    if (characters > COMPUTER_LIMITS.typeTextLength) return TOO_MUCH_TO_TYPE;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) return "Grunt can't type that text: part of it isn't a character (half of a surrogate pair).";
    if ((cp < 0x20 && ch !== '\n' && ch !== '\t') || (cp >= 0x7f && cp <= 0x9f)) {
      return "Grunt can't type that text: it has a control character in it. Only line breaks (\\n) and tabs are typed; use a key action for a key such as Escape or Backspace.";
    }
  }
  return null;
}

const TOO_MUCH_TO_TYPE = `That is too much to type in one action (at most ${COMPUTER_LIMITS.typeTextLength} characters). Send it in parts.`;

/**
 * Compile-time: every action the driver can be sent (`ComputerAction`) is one
 * of the phase-1 names. A hold, press or release added to the port by
 * accident, with no name in `COMPUTER_ACTIONS` and no case in `parseAction`,
 * fails the build here.
 */
export type NoActionOutsideTheList = [Exclude<ComputerAction['action'], ComputerActionName>] extends [never] ? true : never;
const NO_ACTION_OUTSIDE_THE_LIST: NoActionOutsideTheList = true;
void NO_ACTION_OUTSIDE_THE_LIST;

/**
 * Checks a whole action against every rule and cap, and gives back the one
 * form of it that is carried out, or why it isn't. This is the only way an
 * action is built: the tool dispatches exactly what this returns, never the
 * model's own arguments.
 *
 *   - the action is exactly one of `COMPUTER_ACTIONS`;
 *   - a coordinate passes `coordinateOf` (with `bounds`, the last
 *     screenshot's size, when given);
 *   - a scroll has a direction from the four and a whole amount from 1 to 10
 *     (3 when left out);
 *   - typed text is 1 to 4000 characters, well-formed, with no control
 *     character but line breaks and tabs;
 *   - a key passes `parseKeys` (with `reserved`; `null` when the shell has
 *     not reported its shortcuts, which holds back every combination with a
 *     modifier) and is sent as the canonical combination, never as the model
 *     wrote it;
 *   - a wait is a finite number of seconds, zero or more, cut to 10 (1 when
 *     left out).
 *
 * There is no action that holds a key or a button down: every action here
 * presses and releases.
 */
export function parseAction(args: unknown, options: { bounds?: { width: number; height: number }; reserved?: readonly unknown[] | null } = {}): ParsedAction {
  const no = (reason: string): ParsedAction => ({ ok: false, reason });
  const a = recordOf(args);
  const action = a?.['action'];
  if (a === null || !isComputerAction(action)) {
    return no(`"${cardLine(action, 40)}" isn't a computer action Grunt can do. Use one of: ${COMPUTER_ACTIONS.join(', ')}.`);
  }
  switch (action) {
    case 'screenshot':
    case 'cursor_position':
      return { ok: true, action: { action } };
    case 'wait': {
      const duration = a['duration'] ?? COMPUTER_LIMITS.waitDefault;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        return no(`A wait needs "duration": a number of seconds from 0 to ${COMPUTER_LIMITS.waitMax}.`);
      }
      return { ok: true, action: { action, duration: Math.round(Math.min(duration, COMPUTER_LIMITS.waitMax) * 10) / 10 } };
    }
    case 'mouse_move':
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click':
    case 'scroll': {
      const coordinate = coordinateOf(a, options.bounds);
      if (coordinate === null) {
        const inside = options.bounds !== undefined && coordinateOf(a) !== null;
        return no(
          inside
            ? 'That point is outside the last screenshot. Take a screenshot and use a point inside it.'
            : `A ${action} action needs "coordinate": [x, y], two numbers in the last screenshot's pixels.`
        );
      }
      if (action !== 'scroll') return { ok: true, action: { action, coordinate } };
      const direction = SCROLL_DIRECTIONS.find((d) => d === a['scroll_direction']);
      if (direction === undefined) return no('A scroll action needs "scroll_direction": up, down, left or right.');
      const amount = a['scroll_amount'] ?? COMPUTER_LIMITS.scrollAmountDefault;
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < COMPUTER_LIMITS.scrollAmountMin || amount > COMPUTER_LIMITS.scrollAmountMax) {
        return no(`"scroll_amount" is a whole number from ${COMPUTER_LIMITS.scrollAmountMin} to ${COMPUTER_LIMITS.scrollAmountMax}.`);
      }
      return { ok: true, action: { action, coordinate, scroll_direction: direction, scroll_amount: amount } };
    }
    case 'type': {
      const text = a['text'];
      if (typeof text !== 'string' || text.length === 0) return no('A type action needs "text": the text to type.');
      const problem = typedTextProblem(text);
      return problem === null ? { ok: true, action: { action, text } } : no(problem);
    }
    case 'key': {
      const parsed = parseKeys(a['text'], options.reserved);
      return parsed.ok ? { ok: true, action: { action, text: parsed.text } } : no(parsed.reason);
    }
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

const VERBS: Readonly<Record<ComputerActionName, string>> = {
  screenshot: 'take a screenshot',
  cursor_position: 'read the cursor position',
  wait: 'wait',
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
 * banner and the indicator. It is made from the action `parseAction`
 * returns, so it says what will be carried out and holds no value that
 * wasn't validated: an action that doesn't pass reads `click ?`, and a name
 * that isn't an action reads `?`. It never holds typed text, only how much
 * of it there is (`typedTextForCard` is where a card shows the text).
 */
export function actionSummary(args: unknown): string {
  const name = recordOf(args)?.['action'];
  if (!isComputerAction(name)) return '?';
  const parsed = parseAction(args);
  if (!parsed.ok) return `${VERBS[name]} ?`;
  const action = parsed.action;
  switch (action.action) {
    case 'screenshot':
    case 'cursor_position':
      return VERBS[action.action];
    case 'wait':
      return `wait ${action.duration} s`;
    case 'mouse_move':
      return `move the mouse to ${action.coordinate[0]}, ${action.coordinate[1]}`;
    case 'scroll':
      return `scroll ${action.scroll_direction} ${action.scroll_amount} at ${action.coordinate[0]}, ${action.coordinate[1]}`;
    case 'type': {
      const characters = Array.from(action.text).length;
      const lines = action.text.split('\n').length;
      return `type ${characters} ${characters === 1 ? 'character' : 'characters'}${lines > 1 ? ` (${lines} lines)` : ''}`;
    }
    case 'key':
      return `press ${action.text}`;
    default:
      return `${VERBS[action.action]} at ${action.coordinate[0]}, ${action.coordinate[1]}`;
  }
}
