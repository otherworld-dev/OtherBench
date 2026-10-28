import type { IssueState } from '../state/store.js';
import type { Mode } from '../state/mode.js';

/**
 * Undocked windows (desktop only): Code mode and the Overview can each have a
 * window of their own (desktop/src-tauri/src/docks.rs), so chat and code can
 * sit on separate screens. Each window knows which it is (its role) and which
 * views are undocked, and so which window holds each mode: Code mode is in the
 * Code window while it is undocked, and everything else is in the main one.
 * Opening something that lives in another window hands it over (`OpenRequest`).
 */

/** The window this page is: the main one, or an undocked view's. */
export type WindowRole = 'main' | 'code' | 'overview';

/** The views that can be undocked, as their windows' labels. */
export type DockView = 'code' | 'overview';

const DOCK_VIEWS: readonly DockView[] = ['code', 'overview'];

/** In the desktop app: as bridge.ts `isDesktop`, which this module doesn't import, so the store can read it as it loads. */
export function inDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * This page's window. An undocked window loads the app with `?view=code` or
 * `?view=overview` and has that label; either is enough, as for quick chat.
 */
export function windowRole(): WindowRole {
  if (typeof window === 'undefined') return 'main';
  const view = new URLSearchParams(window.location.search).get('view');
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  if (view === 'code' || label === 'code') return 'code';
  if (view === 'overview' || label === 'overview') return 'overview';
  return 'main';
}

/** The undockable views in `value` (the shell's list), once each; anything else is dropped. */
export function parseUndocked(value: unknown): DockView[] {
  if (!Array.isArray(value)) return [];
  return DOCK_VIEWS.filter((v) => value.includes(v));
}

/**
 * localStorage key: the undocked views, as the shell last said. Only so a window
 * starts in the right mode before the shell answers; the shell's list wins.
 */
export const UNDOCKED_STORAGE_KEY = 'otherbench.undocked';

/** The undocked views last seen; none outside the desktop app, which has no other windows. */
export function loadUndocked(): DockView[] {
  if (!inDesktopApp()) return [];
  try {
    return parseUndocked(JSON.parse(window.localStorage.getItem(UNDOCKED_STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function saveUndocked(views: readonly DockView[]): void {
  try {
    window.localStorage.setItem(UNDOCKED_STORAGE_KEY, JSON.stringify(views));
  } catch {
    // storage blocked or full -- the shell still knows, and says so on the next start.
  }
}

/**
 * The window holding `mode`: Code mode's own window while it is undocked (and
 * always from inside it, before the shell's word arrives), else the main one.
 */
export function windowForMode(mode: Mode, undocked: readonly DockView[], role: WindowRole): 'main' | 'code' {
  return mode === 'code' && (role === 'code' || undocked.includes('code')) ? 'code' : 'main';
}

/** Something to open in the window that holds it: what the Overview's clicks, the sidebar and notifications ask for. */
export type OpenRequest =
  | { kind: 'chat'; chatId: string }
  | { kind: 'tab'; chatId: string }
  | { kind: 'home'; appId: string }
  | { kind: 'app'; appId: string }
  | { kind: 'issue'; appId: string; n: number; state: IssueState }
  | { kind: 'card'; appId: string; cardId: number };

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** `value` as an `OpenRequest` if it is a well-formed one, else null. */
export function parseOpenRequest(value: unknown): OpenRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  switch (r.kind) {
    case 'chat':
    case 'tab':
      return str(r.chatId) ? { kind: r.kind, chatId: r.chatId } : null;
    case 'home':
    case 'app':
      return str(r.appId) ? { kind: r.kind, appId: r.appId } : null;
    case 'issue':
      return str(r.appId) && int(r.n) && (r.state === 'open' || r.state === 'closed') ? { kind: 'issue', appId: r.appId, n: r.n, state: r.state } : null;
    case 'card':
      return str(r.appId) && int(r.cardId) ? { kind: 'card', appId: r.appId, cardId: r.cardId } : null;
    default:
      return null;
  }
}
