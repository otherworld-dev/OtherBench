import type { ReplyNote } from '@otherbench/core/types/notes.js';
import { CLIENT_ID } from '../lib/clientId.js';
import type { CodePanelTab, DeckView, IssueView, WikiView } from './storeTypes.js';

// What the store remembers on this device (localStorage) or in this tab (sessionStorage): read once as it is
// created, and written by its subscriber in store.ts.

/** localStorage key: whether the docked inspector is collapsed. Per device. */
export const INSPECTOR_COLLAPSED_STORAGE_KEY = 'otherbench.inspectorCollapsed';

export function loadInspectorCollapsed(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveInspectorCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // storage blocked or full -- the choice still applies for this session.
  }
}

/** localStorage key: whether the Overview window is showing. Per browser. */
export const OVERVIEW_OPEN_STORAGE_KEY = 'otherbench.overviewOpen';

export function loadOverviewOpen(): boolean {
  try {
    return window.localStorage.getItem(OVERVIEW_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveOverviewOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OVERVIEW_OPEN_STORAGE_KEY, String(open));
  } catch {
    // storage blocked or full -- the choice still applies for this session.
  }
}

/** localStorage key: the Code mode right panel's tab. Per browser. */
export const CODE_PANEL_TAB_STORAGE_KEY = 'otherbench.codePanelTab';

/** The stored tab; Issues for anything missing, unreadable or unknown. */
export function loadCodePanelTab(): CodePanelTab {
  try {
    const raw = window.localStorage.getItem(CODE_PANEL_TAB_STORAGE_KEY);
    return raw === 'deck' || raw === 'wiki' || raw === 'links' || raw === 'files' || raw === 'chat' || raw === 'terminal' ? raw : 'issues';
  } catch {
    return 'issues';
  }
}

export function saveCodePanelTab(tab: CodePanelTab): void {
  try {
    window.localStorage.setItem(CODE_PANEL_TAB_STORAGE_KEY, tab);
  } catch {
    // storage blocked or full -- the tab still applies for this session.
  }
}

/** localStorage key: each chat's (and app home's) Issues view. Per browser. */
export const ISSUE_VIEWS_STORAGE_KEY = 'otherbench.issueViews';

/** The stored views, keeping only well-formed ones. */
export function loadIssueViews(): Record<string, IssueView> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ISSUE_VIEWS_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const views: Record<string, IssueView> = {};
    for (const [owner, v] of Object.entries(parsed as Record<string, Partial<IssueView> | null>)) {
      if (!v || (v.state !== 'open' && v.state !== 'closed')) continue;
      const selected = typeof v.selected === 'number' && Number.isInteger(v.selected) && v.selected > 0 ? v.selected : null;
      views[owner] = { state: v.state, selected };
    }
    return views;
  } catch {
    return {};
  }
}

export function saveIssueViews(views: Record<string, IssueView>): void {
  try {
    window.localStorage.setItem(ISSUE_VIEWS_STORAGE_KEY, JSON.stringify(views));
  } catch {
    // storage blocked or full -- the views still apply for this session.
  }
}

/** localStorage keys: each chat's (and app home's) Deck and Wiki views. Per browser. */
export const DECK_VIEWS_STORAGE_KEY = 'otherbench.deckViews';
export const WIKI_VIEWS_STORAGE_KEY = 'otherbench.wikiViews';

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readViewRecord(key: string): [string, Record<string, unknown>][] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object' && !Array.isArray(e[1]));
  } catch {
    return [];
  }
}

/** The stored Deck views, keeping only well-formed ones. */
export function loadDeckViews(): Record<string, DeckView> {
  const views: Record<string, DeckView> = {};
  for (const [owner, v] of readViewRecord(DECK_VIEWS_STORAGE_KEY)) {
    const raw = v.stackId;
    const stackId = raw === null || raw === 'archived' ? raw : typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    if (stackId === undefined) continue;
    views[owner] = { stackId, selected: positiveIntOrNull(v.selected) };
  }
  return views;
}

/** The stored Wiki views, keeping only well-formed ones. */
export function loadWikiViews(): Record<string, WikiView> {
  const views: Record<string, WikiView> = {};
  for (const [owner, v] of readViewRecord(WIKI_VIEWS_STORAGE_KEY)) {
    if (!Array.isArray(v.expanded)) continue;
    views[owner] = { expanded: v.expanded.filter((n): n is number => positiveIntOrNull(n) !== null), selected: positiveIntOrNull(v.selected) };
  }
  return views;
}

export function saveViews(key: string, views: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(views));
  } catch {
    // storage blocked or full -- the views still apply for this session.
  }
}

/** sessionStorage key: the notes this tab sent that aren't resolved yet. Per tab, so a reload keeps them. */
export const SENT_NOTES_STORAGE_KEY = 'otherbench.sentNotes';

export function loadSentNotes(): Record<string, ReplyNote> {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(SENT_NOTES_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const notes: Record<string, ReplyNote> = {};
    for (const [id, n] of Object.entries(parsed as Record<string, Partial<ReplyNote> | null>)) {
      // Another tab's, copied with its storage when this one was duplicated from it (clientId.ts): not this tab's to bring back.
      if (n?.clientId !== CLIENT_ID) continue;
      if (n.id === id && typeof n.chatId === 'string' && typeof n.text === 'string' && Array.isArray(n.attachments)) notes[id] = n as ReplyNote;
    }
    return notes;
  } catch {
    return {};
  }
}

export function saveSentNotes(notes: Record<string, ReplyNote>): void {
  try {
    window.sessionStorage.setItem(SENT_NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // storage blocked or full -- they're still held for this load.
  }
}
