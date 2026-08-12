import { useMemo, useState, type JSX } from 'react';
import { activePath, siblingsOf } from '@grunt/core/domain/tree.js';
import type { Chat } from '@grunt/core/ports/store.js';
import { Composer } from '../components/Composer.js';
import { Message } from '../components/Message.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';

/**
 * Centre pane: the active branch (head -> root) plus the composer.
 * `siblingsOf` runs for every message on the path, so a compare turn
 * anywhere in history renders its variant count without throwing --
 * switching which variant is active is only wired for the tail message
 * (the current leaf), where "move `head` to this sibling" is unambiguous;
 * an interior sibling's own subtree is a task 27 concern (see Message.tsx's
 * doc comment on the seam this leaves).
 *
 * `messages` in the store is a flat, cross-chat pool (every message loaded
 * or streamed into this session, never scoped or evicted per chat -- see
 * store.ts). `siblingsOf` groups purely by `parentId`, and every chat's
 * first message has `parentId: null` -- so feeding it the WHOLE pool would
 * treat unrelated chats' root messages as compare variants of each other.
 * Scoping to this chat's own messages before any tree computation is what
 * keeps `activePath`/`siblingsOf` chat-local (task 19/20 CRITICAL fix).
 */
export function Thread({ chat }: { chat: Chat | null }): JSX.Element {
  const messages = useGruntStore((s) => s.messages);
  const setHeadMessageId = useGruntStore((s) => s.setHeadMessageId);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const chatId = chat?.id ?? null;
  const chatMessages = useMemo(
    () => (chatId ? Object.values(messages).filter((m) => m.chatId === chatId) : []),
    [messages, chatId]
  );
  const path = useMemo(() => {
    if (!chat?.headMessageId) return [];
    try {
      return activePath(chatMessages, chat.headMessageId);
    } catch {
      return []; // an inconsistent/partially-loaded slice -- render nothing rather than throw.
    }
  }, [chat?.headMessageId, chatMessages]);

  if (!chat) {
    return (
      <main className="flex h-full w-full flex-1 items-center justify-center text-sm text-[var(--text-faint)]">
        Select a chat, or start a new one, to begin.
      </main>
    );
  }

  async function switchSibling(siblingId: string): Promise<void> {
    const previousHeadId = chat!.headMessageId;
    setSwitchError(null);
    setHeadMessageId(chat!.id, siblingId);
    try {
      await api.turns.setHead(chat!.id, siblingId);
    } catch (err) {
      console.error('[grunt-web] failed to persist head after switching variant:', err);
      // The server refused the switch (e.g. a stale/cross-chat id) -- don't
      // leave the client rendering a state the server never accepted. Roll
      // the optimistic update back and say so, rather than only logging it.
      if (previousHeadId) setHeadMessageId(chat!.id, previousHeadId);
      setSwitchError("Couldn't switch to that variant -- the server rejected the change, so it was reverted. Please try again.");
    }
  }

  return (
    <main className="flex h-full w-full flex-1 flex-col overflow-hidden">
      {switchError && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-[var(--danger)] bg-[var(--bg-raised)] px-4 py-2 text-sm text-[var(--danger)]">
          <span>{switchError}</span>
          <button type="button" onClick={() => setSwitchError(null)} className="shrink-0 rounded border border-[var(--danger)] px-2 py-0.5 text-xs">
            Dismiss
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
          {path.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">No messages yet -- say something below.</p>
          ) : (
            path.map((m, i) => {
              let siblings = [m];
              try {
                siblings = siblingsOf(chatMessages, m.id);
              } catch {
                // m not found in chatMessages (shouldn't happen -- it came from activePath over the same set) -- fall back to "no siblings".
              }
              const siblingIndex = Math.max(0, siblings.findIndex((s) => s.id === m.id));
              const isTail = i === path.length - 1;
              return (
                <Message
                  key={m.id}
                  message={m}
                  siblingCount={siblings.length}
                  siblingIndex={siblingIndex}
                  onPrevSibling={isTail && siblingIndex > 0 ? () => void switchSibling(siblings[siblingIndex - 1]!.id) : undefined}
                  onNextSibling={isTail && siblingIndex < siblings.length - 1 ? () => void switchSibling(siblings[siblingIndex + 1]!.id) : undefined}
                />
              );
            })
          )}
        </div>
      </div>
      <Composer chat={chat} />
    </main>
  );
}
