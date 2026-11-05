import { useEffect } from 'react';
import { create } from 'zustand';
import type { AppNotesView, PlacedFact } from '@otherbench/core/domain/app-notes.js';
import { api } from './api.js';

/** How often an open app's notes are read again: another window or machine may change them. */
export const APP_NOTES_POLL_MS = 30_000;

/** A fact filed from a chat, shown as a card in that chat until dismissed. This window only, never saved. */
export interface FactCard {
  id: string;
  appId: string;
  fact: PlacedFact;
  /** 'undone' once taken back. */
  state: 'saved' | 'undone';
}

interface AppNotesState {
  /** appId -> its notes as last read. */
  views: Record<string, AppNotesView>;
  /** appId -> the last read failed. */
  failed: Record<string, boolean>;
  /** chatId -> the facts filed from it. */
  cards: Record<string, FactCard[]>;
  setView: (appId: string, view: AppNotesView) => void;
  setFailed: (appId: string, failed: boolean) => void;
  addCard: (chatId: string, card: FactCard) => void;
  updateCard: (chatId: string, id: string, patch: Partial<Omit<FactCard, 'id'>>) => void;
  dismissCard: (chatId: string, id: string) => void;
}

export const useAppNotesStore = create<AppNotesState>((set) => ({
  views: {},
  failed: {},
  cards: {},
  setView: (appId, view) => set((s) => ({ views: { ...s.views, [appId]: view }, failed: { ...s.failed, [appId]: false } })),
  setFailed: (appId, failed) => set((s) => ({ failed: { ...s.failed, [appId]: failed } })),
  addCard: (chatId, card) => set((s) => ({ cards: { ...s.cards, [chatId]: [...(s.cards[chatId] ?? []), card] } })),
  updateCard: (chatId, id, patch) =>
    set((s) => ({ cards: { ...s.cards, [chatId]: (s.cards[chatId] ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)) } })),
  dismissCard: (chatId, id) => set((s) => ({ cards: { ...s.cards, [chatId]: (s.cards[chatId] ?? []).filter((c) => c.id !== id) } })),
}));

/** appId -> the read in flight, which a second caller joins. */
const loading = new Map<string, Promise<void>>();

/** Reads an app's notes into the store now. */
export function loadAppNotes(appId: string): Promise<void> {
  const inFlight = loading.get(appId);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      useAppNotesStore.getState().setView(appId, await api.appNotes.get(appId));
    } catch (err) {
      console.error(`[otherbench-web] failed to load the notes for app ${appId}:`, err);
      useAppNotesStore.getState().setFailed(appId, true);
    } finally {
      loading.delete(appId);
    }
  })();
  loading.set(appId, run);
  return run;
}

/**
 * An app's notes, loaded when first asked for. With `poll`, read again every
 * `APP_NOTES_POLL_MS` while the caller is mounted (the Notes tab and the home
 * card); without, read once (a model's offer card checking "Saved").
 */
export function useAppNotes(appId: string | null, poll = false): { view: AppNotesView | null; loadFailed: boolean } {
  const view = useAppNotesStore((s) => (appId ? (s.views[appId] ?? null) : null));
  const loadFailed = useAppNotesStore((s) => (appId ? s.failed[appId] === true : false));
  const known = view !== null;
  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      await loadAppNotes(appId);
      if (!cancelled && poll) timer = setTimeout(() => void tick(), APP_NOTES_POLL_MS);
    };
    if (poll || !known) void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `known` only decides the first read for a caller that doesn't poll.
  }, [appId, poll]);
  return { view, loadFailed };
}
