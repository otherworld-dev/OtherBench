import { useState, type JSX } from 'react';
import { nextAskAt, suggestsHandover } from '@otherbench/core/domain/handover.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { toast } from '../lib/toasts.js';
import { api } from '../state/api.js';
import { useFeatures } from '../state/features.js';
import { handoverTarget, pendingHandovers } from '../state/handover.js';
import { useOtherBenchStore } from '../state/store.js';

const BUSY = "Wait for this chat to finish what it's doing first.";

/**
 * The fresh chat card under a big Claude Code chat's latest reply (spec
 * 2026-11-06-fresh-chat-handover-design): it never blocks anything, and nothing
 * waits on it. The cheap checks come first, so the many replies that get no card
 * never look through the message pool.
 */
export function HandoverCard({ message }: { message: CanonMessage }): JSX.Element | null {
  const contextTokens = useOtherBenchStore((s) => s.chats.find((c) => c.id === message.chatId)?.contextTokens ?? null);
  const handoverAskAt = useOtherBenchStore((s) => s.chats.find((c) => c.id === message.chatId)?.handoverAskAt ?? null);
  const handoverSuggest = useOtherBenchStore((s) => s.chats.find((c) => c.id === message.chatId)?.handoverSuggest !== false);
  const handoverEnabled = useFeatures((f) => f.handoverEnabled);
  const handoverThresholdTokens = useFeatures((f) => f.handoverThresholdTokens);
  if (message.role !== 'assistant' || message.status === 'streaming' || contextTokens === null) return null;
  if (!suggestsHandover({ contextTokens, handoverAskAt, handoverSuggest }, { handoverEnabled, handoverThresholdTokens })) return null;
  return <HandoverCardBody message={message} contextTokens={contextTokens} />;
}

function HandoverCardBody({ message, contextTokens }: { message: CanonMessage; contextTokens: number }): JSX.Element | null {
  const chatId = message.chatId;
  const target = useOtherBenchStore((s) => handoverTarget(message, s.messages));
  const busy = useOtherBenchStore(
    (s) => Object.values(s.appRunningTurns).includes(chatId) || (s.appBackgroundChats[chatId] ?? 0) > 0 || (s.chatNotes[chatId] ?? []).length > 0
  );
  const [sending, setSending] = useState(false);
  if (target === null) return null;

  async function start(messageId: string): Promise<void> {
    setSending(true);
    pendingHandovers.add(chatId);
    try {
      await api.chats.handover(chatId, { messageId });
    } catch (err) {
      pendingHandovers.delete(chatId);
      console.error('[otherbench-web] failed to start a fresh chat:', err);
      toast({ tone: 'error', chatId, text: err instanceof Error ? err.message : "Couldn't start a fresh chat." });
    } finally {
      setSending(false);
    }
  }

  function save(body: { handoverAskAt: number } | { handoverSuggest: false }): void {
    api.chats.patch(chatId, body).catch((err: unknown) => {
      console.error('[otherbench-web] failed to save the fresh chat choice:', err);
      toast({ tone: 'error', chatId, text: "Couldn't save that. Please try again." });
    });
  }

  return (
    <div data-testid="handover-card" className="mt-2 space-y-2 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2 text-xs">
      <p>This chat is re-reading ~{Math.round(contextTokens / 1000)}k tokens a call. Start a fresh chat with a summary?</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary px-2 py-1"
          disabled={busy || sending}
          {...(busy ? { title: BUSY } : {})}
          onClick={() => void start(target)}
        >
          Start fresh chat
        </button>
        <button type="button" className="btn px-2 py-1" onClick={() => save({ handoverAskAt: nextAskAt(contextTokens) })}>
          Not now
        </button>
        <button type="button" className="ml-auto text-[var(--text-muted)] underline hover:text-[var(--text)]" onClick={() => save({ handoverSuggest: false })}>
          Don&apos;t ask again for this chat
        </button>
      </div>
    </div>
  );
}
