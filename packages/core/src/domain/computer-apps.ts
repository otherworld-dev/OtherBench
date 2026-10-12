/**
 * Computer use (spec 2026-10-12-computer-use-design §1): the pure rules the
 * broker, the tool and the web card share. No I/O, no Node APIs (the web
 * app imports this module).
 */

export const COMPUTER_TOOL = 'computer';

export const COMPUTER_ACTIONS = [
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
] as const;
export type ComputerActionName = (typeof COMPUTER_ACTIONS)[number];

/** Actions that only look. They need no card: the shell's start dialog was the consent to see the screen. */
export const READ_ACTIONS: readonly ComputerActionName[] = ['screenshot', 'cursor_position', 'wait'];

export const COMPUTER_OFF_REASON = 'Computer use is turned off for this profile.';
export const COMPUTER_UNATTENDED_REASON = 'Computer use needs someone at the machine; it never runs unattended.';
export const COMPUTER_NO_APP_REASON = "Grunt couldn't tell which app this action would use, so it didn't run it.";

export function isComputerAction(value: unknown): value is ComputerActionName {
  return typeof value === 'string' && (COMPUTER_ACTIONS as readonly string[]).includes(value);
}

export function isReadAction(value: unknown): boolean {
  return typeof value === 'string' && (READ_ACTIONS as readonly string[]).includes(value);
}

/**
 * Programs that can run commands or change system settings. "Allow for this
 * chat" and "Always allow" act as "Allow once" for them: no grant is stored,
 * and none is matched. The list is a list: an IDE's terminal or a password
 * manager is just another app to it (spec §10).
 */
export const HIGH_RISK_PROGRAMS: ReadonlySet<string> = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'windowsterminal.exe',
  'wt.exe',
  'conhost.exe',
  'openconsole.exe',
  'wsl.exe',
  'wslhost.exe',
  'bash.exe',
  'mintty.exe',
  'explorer.exe',
  'systemsettings.exe',
  'regedit.exe',
  'mmc.exe',
  'taskmgr.exe',
  'control.exe',
  'rundll32.exe',
]);

/**
 * An app's grant key: its full program path, trimmed, lower-cased, with `/`
 * turned into `\` and repeated separators collapsed (a UNC path keeps its
 * leading `\\`). The desktop shell's `app_key` (computer.rs) must match it.
 */
export function appKey(path: string): string {
  const unified = path.trim().replace(/\//g, '\\');
  const unc = unified.startsWith('\\\\');
  const collapsed = unified.replace(/\\{2,}/g, '\\');
  return (unc ? `\\${collapsed}` : collapsed).toLowerCase();
}

/** The program's file name, lower-cased: `excel.exe`. */
export function programName(path: string): string {
  const key = appKey(path);
  return key.slice(key.lastIndexOf('\\') + 1);
}

export function isHighRiskProgram(path: string): boolean {
  return HIGH_RISK_PROGRAMS.has(programName(path));
}

/** Whether described call arguments name a high-risk app, by program name or by the risk the tool worked out. */
export function isHighRiskApp(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a['appRisk'] === 'high') return true;
  return typeof a['app'] === 'string' && isHighRiskProgram(a['app']);
}

const WINDOWS_KEY_NAMES: ReadonlySet<string> = new Set([
  'super', 'super_l', 'super_r', 'win', 'win_l', 'win_r', 'windows', 'lwin', 'rwin', 'meta', 'meta_l', 'meta_r', 'cmd', 'command', 'hyper', 'hyper_l', 'hyper_r',
]);

/** True when an xdotool-style key string (`ctrl+s`, `super+r`, `ctrl+a ctrl+c`) uses the Windows key anywhere. */
export function isBlockedKeyCombo(keys: string): boolean {
  return keys.split(/[\s+]+/).some((k) => WINDOWS_KEY_NAMES.has(k.trim().toLowerCase()));
}

/** `args.coordinate` as whole pixels, or null unless it is exactly two finite, non-negative numbers. */
export function coordinateOf(args: unknown): [number, number] | null {
  if (typeof args !== 'object' || args === null) return null;
  const c = (args as Record<string, unknown>)['coordinate'];
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [x, y] = c as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  return [Math.round(x), Math.round(y)];
}

/** One short line saying what an action does, for cards, the banner and audit summaries. */
export function actionSummary(args: unknown): string {
  const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const action = typeof a['action'] === 'string' ? a['action'] : '?';
  const c = coordinateOf(a);
  const at = c ? ` at ${c[0]}, ${c[1]}` : '';
  const text = typeof a['text'] === 'string' ? a['text'] : '';
  switch (action) {
    case 'left_click':
      return `click${at}`;
    case 'right_click':
      return `right-click${at}`;
    case 'double_click':
      return `double-click${at}`;
    case 'triple_click':
      return `triple-click${at}`;
    case 'mouse_move':
      return c ? `move the mouse to ${c[0]}, ${c[1]}` : 'move the mouse';
    case 'scroll':
      return `scroll ${String(a['scroll_direction'] ?? '')} ${String(a['scroll_amount'] ?? '')}${at}`.replace(/\s+/g, ' ').trim();
    case 'type': {
      const flat = text.replace(/\s+/g, ' ');
      return `type "${flat.length > 40 ? `${flat.slice(0, 40)}…` : flat}"`;
    }
    case 'key':
      return `press ${text}`;
    case 'screenshot':
      return 'take a screenshot';
    case 'cursor_position':
      return 'read the cursor position';
    case 'wait':
      return `wait ${typeof a['duration'] === 'number' ? a['duration'] : 1} s`;
    default:
      return action;
  }
}
