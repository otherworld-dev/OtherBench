import { useState, type JSX } from 'react';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { toast } from '../lib/toasts.js';
import { api } from '../state/api.js';
import { isClaudeLoginChat, useClaudeAccounts } from '../state/claudeAccounts.js';
import { useOtherBenchStore } from '../state/store.js';

/**
 * "Continue on <name>" under a reply a Claude account's usage limit cut off: one button per account
 * other than the one that produced the reply. Only in a Claude-login chat, and only when there is
 * another account to offer.
 */
export function ContinueOnAccount({ message }: { message: CanonMessage }): JSX.Element | null {
  const accounts = useClaudeAccounts((s) => s.accounts);
  const login = useOtherBenchStore((s) => isClaudeLoginChat(s.chats.find((c) => c.id === message.chatId), s.profiles, s.connections));
  const [busy, setBusy] = useState(false);
  if (message.status !== 'error' || message.error?.kind !== 'rate_limit' || !login) return null;
  const producer = message.engineMeta?.account ?? 'main';
  const others = accounts.filter((a) => a.slug !== producer);
  if (others.length === 0) return null;

  async function run(slug: string): Promise<void> {
    setBusy(true);
    try {
      await api.chats.continueOnAccount(message.chatId, { messageId: message.id, account: slug });
    } catch (err) {
      console.error('[otherbench-web] failed to continue on another Claude account:', err);
      toast({ tone: 'error', chatId: message.chatId, text: err instanceof Error ? err.message : "Couldn't continue on that account." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {others.map((a) => (
        <button key={a.slug} type="button" disabled={busy} onClick={() => void run(a.slug)} className="btn px-2 py-0.5 text-xs">
          Continue on {a.name}
        </button>
      ))}
    </div>
  );
}
