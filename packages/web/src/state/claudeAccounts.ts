import { create } from 'zustand';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Connection, Profile } from '@otherbench/core/types/config.js';
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

/**
 * Reloads the accounts after a switch, or when every account is out: the
 * server has just held an account, so its "Limited until" (on the Overview)
 * changes. Any other event is ignored.
 */
export function reloadOnAccountEvent(event: AppEvent): void {
  if (event.type !== 'claude-account-switched' && event.type !== 'claude-accounts-exhausted') return;
  useClaudeAccounts.getState().load().catch((err: unknown) => console.error('[otherbench-web] failed to load the Claude accounts:', err));
}

/** Whether a chat gets an account picker: with an account besides main to pick, or still naming one (a removed account, say) to be put back. */
export function showsAccountPicker(accounts: AccountView[], chosen: string | null | undefined): boolean {
  return accounts.length > 1 || (accounts.length > 0 && !!chosen);
}

/** True when the chat's profile runs through Claude Code on the Claude login (a `claude_code` connection with no endpoint). */
export function isClaudeLoginChat(chat: Pick<Chat, 'profileId'> | undefined, profiles: Profile[], connections: Connection[]): boolean {
  const profile = profiles.find((p) => p.id === chat?.profileId);
  const connection = connections.find((c) => c.id === profile?.connectionId);
  return connection?.kind === 'claude_code' && !connection.baseUrl;
}
