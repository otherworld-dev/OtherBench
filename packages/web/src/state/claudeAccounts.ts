import { create } from 'zustand';
import { MAIN_ACCOUNT_SLUG, type AccountView } from '@otherbench/core/types/claude-accounts.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { formatReset } from '../components/PlanUsageMeter.js';
import { toast } from '../lib/toasts.js';
import { api } from './api.js';

interface ClaudeAccountsState {
  /** Main first. Empty until the first `load`. */
  accounts: AccountView[];
  load(): Promise<void>;
}

/** The Claude accounts this machine can run a chat on (Settings → Claude accounts). */
export const useClaudeAccounts = create<ClaudeAccountsState>((set) => ({
  accounts: [],
  async load() {
    set({ accounts: (await api.claude.accounts.list()).accounts });
  },
}));

/** The account's own colour, for a swatch; null for main and for a slug this machine doesn't have. */
export function accountColour(slug: string | null | undefined): string | null {
  if (!slug || slug === MAIN_ACCOUNT_SLUG) return null;
  return useClaudeAccounts.getState().accounts.find((a) => a.slug === slug)?.colour ?? null;
}

/** The event can fire once per compare variant, so a chat gets one "all at their limit" toast a minute. */
export const EXHAUSTED_TOAST_GAP_MS = 60_000;
const lastExhausted = new Map<string, number>();

/** Toasts for the app events about Claude accounts; any other event is ignored. `chatTitle` is the chat's title if it is loaded. */
export function announceAccountEvent(event: AppEvent, chatTitle: (chatId: string) => string | undefined, now = Date.now()): void {
  const e = event;
  if (e.type === 'claude-account-switched') {
    const reset = e.resetsAt !== null ? ` (resets ${formatReset(e.resetsAt, now)})` : '';
    toast({ tone: 'ok', chatId: e.chatId, text: `${chatTitle(e.chatId) ?? 'A chat'} moved to ${e.to}: ${e.from} hit its limit${reset}` });
  } else if (e.type === 'claude-accounts-exhausted') {
    const last = lastExhausted.get(e.chatId);
    if (last !== undefined && now - last < EXHAUSTED_TOAST_GAP_MS) return;
    lastExhausted.set(e.chatId, now);
    const when = e.resets.map((r) => (r.resetsAt !== null ? `${r.name} resets ${formatReset(r.resetsAt, now)}` : r.name));
    toast({ tone: 'error', chatId: e.chatId, text: `All Claude accounts are at their limit: ${when.join(', ')}` });
  }
}
