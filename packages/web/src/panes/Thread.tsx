import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { activePath, childrenOf, extendForward, siblingsOf } from '@grunt/core/domain/tree.js';
import type { ApprovalChoice } from '@grunt/core/ports/tool-provider.js';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { Composer } from '../components/Composer.js';
import { Message } from '../components/Message.js';
import { VariantTabs } from '../components/VariantTabs.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';

/** How close (px) to the bottom still counts as "following" the thread. */
const NEAR_BOTTOM_PX = 80;

/**
 * Centre pane: the active branch (head -> root), extended forward through
 * any run of single-child replies, plus the composer. An unresolved compare
 * turn (more than one child at the effective tail, none kept yet) renders as
 * an open `VariantTabs` strip right where the reply would otherwise go; a
 * RESOLVED compare turn (one sibling already kept, task 27's "Keep this
 * one") renders as an ordinary message with a "⤺ N other variants" chip that
 * reopens the same tab strip in place, letting the user pick a different
 * variant without losing the others -- they're never deleted, only unselected.
 *
 * `messages` in the store is a flat, cross-chat pool (every message loaded
 * or streamed into this session, never scoped or evicted per chat -- see
 * store.ts). `siblingsOf`/`childrenOf`/`extendForward` all group purely by
 * `parentId`, and every chat's first message has `parentId: null` -- so
 * feeding any of them the WHOLE pool would treat unrelated chats' root
 * messages as compare variants of each other. Scoping to this chat's own
 * messages before any tree computation is what keeps them chat-local (task
 * 19/20 CRITICAL fix) -- every tree call below runs against `chatMessages`,
 * never the raw `messages` map.
 */
export function Thread({ chat }: { chat: Chat | null }): JSX.Element {
  const messages = useGruntStore((s) => s.messages);
  const extras = useGruntStore((s) => s.extras);
  const models = useGruntStore((s) => s.models);
  const setHeadMessageId = useGruntStore((s) => s.setHeadMessageId);
  const resetMessageForRetry = useGruntStore((s) => s.resetMessageForRetry);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Which turn's tab strip has been manually reopened from its "⤺ N other
  // variants" chip, identified by the shared `parentId` of its sibling set
  // (there is at most one shared parent per turn, so this alone disambiguates).
  const [reopenedParentId, setReopenedParentId] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

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

  const displayPath = useMemo(() => {
    if (path.length === 0) return [];
    const tail = path[path.length - 1]!;
    return [...path, ...extendForward(chatMessages, tail.id)];
  }, [path, chatMessages]);

  const tailId = displayPath.at(-1)?.id ?? null;

  // Auto-follow: stay pinned to the bottom while the user is already there,
  // but never yank the view while they've scrolled up to read. `nearBottom`
  // is updated ONLY by scroll events, so at content-change time it still
  // reflects where the user was BEFORE the change.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastChatIdRef = useRef<string | null>(null);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    setShowJump(!near);
  }, []);

  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Runs after every change to this chat's rendered content (messages incl.
  // streamed deltas and parts, plus extras such as pending approval cards).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastChatIdRef.current !== chatId) {
      // Opening a chat starts at the bottom.
      lastChatIdRef.current = chatId;
      nearBottomRef.current = true;
      setShowJump(false);
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [chatId, chatMessages, extras, displayPath]);

  const openVariants = useMemo(() => (tailId ? childrenOf(chatMessages, tailId) : []), [chatMessages, tailId]);

  if (!chat) {
    return (
      <main className="flex h-full w-full flex-1 items-center justify-center text-sm text-[var(--text-faint)]">
        Select a chat, or start a new one, to begin.
      </main>
    );
  }

  async function keepVariant(messageId: string): Promise<void> {
    const previousHeadId = chat!.headMessageId;
    setSwitchError(null);
    setHeadMessageId(chat!.id, messageId);
    setReopenedParentId(null); // collapses the tab strip back automatically
    try {
      await api.turns.setHead(chat!.id, messageId);
    } catch (err) {
      console.error('[grunt-web] failed to keep variant:', err);
      // The server refused the switch (e.g. a stale/cross-chat id) -- don't
      // leave the client rendering a state the server never accepted. Roll
      // the optimistic update back and say so, rather than only logging it.
      if (previousHeadId) setHeadMessageId(chat!.id, previousHeadId);
      setSwitchError("Couldn't keep that variant -- the server rejected the change, so it was reverted. Please try again.");
    }
  }

  /**
   * The other half of the approval round trip whose request arrives over
   * SSE (state/store.ts's `applyTurnEvent`, folded by reducer.ts into
   * `extras[messageId].pendingApprovals`): sends the human's choice to the
   * server, which both records/executes it AND streams back the matching
   * `approval-resolved` event that removes this prompt from state -- so
   * there is nothing to do here on success beyond letting that arrive;
   * `ApprovalPrompt` itself handles a failed request by re-enabling its
   * buttons (this just needs to let the rejection propagate back to it).
   */
  async function resolveApproval(requestId: string, choice: ApprovalChoice): Promise<void> {
    await api.approvals.resolve(requestId, choice);
  }

  async function retryVariant(variant: CanonMessage): Promise<void> {
    setRetryingIds((s) => new Set(s).add(variant.id));
    // Optimistic, local-only: clears the failed attempt's parts/error so the
    // retried stream's deltas build on a clean slate rather than appending
    // onto stale content -- mirrors what the server does to the same row
    // (TurnRunner.retry).
    resetMessageForRetry(variant.id);
    try {
      await api.turns.retry(variant.id);
    } catch (err) {
      console.error(`[grunt-web] failed to retry ${variant.id}:`, err);
    } finally {
      setRetryingIds((s) => {
        const next = new Set(s);
        next.delete(variant.id);
        return next;
      });
    }
  }

  return (
    <main className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      {switchError && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-[var(--danger)] bg-[var(--bg-raised)] px-4 py-2 text-sm text-[var(--danger)]">
          <span>{switchError}</span>
          <button type="button" onClick={() => setSwitchError(null)} className="shrink-0 rounded border border-[var(--danger)] px-2 py-0.5 text-xs">
            Dismiss
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} data-testid="thread-scroll" className="absolute inset-0 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
            {displayPath.length === 0 ? (
              <p className="text-sm text-[var(--text-faint)]">No messages yet -- say something below.</p>
            ) : (
              displayPath.map((m) => {
                let siblings = [m];
                try {
                  siblings = siblingsOf(chatMessages, m.id);
                } catch {
                  // m not found in chatMessages (shouldn't happen -- it came from the same set) -- fall back to "no siblings".
                }
                const isReopened = siblings.length > 1 && m.parentId !== null && m.parentId === reopenedParentId;
                if (isReopened) {
                  return (
                    <VariantTabs
                      key={`turn-${m.parentId}`}
                      variants={siblings}
                      extras={extras}
                      models={models}
                      keptId={m.id}
                      onKeep={(id) => void keepVariant(id)}
                      onRetry={(v) => void retryVariant(v)}
                      retryingIds={retryingIds}
                      onClose={() => setReopenedParentId(null)}
                      onResolveApproval={resolveApproval}
                    />
                  );
                }
                return (
                  <Message
                    key={m.id}
                    message={m}
                    otherVariantsCount={siblings.length > 1 ? siblings.length - 1 : 0}
                    onReopenVariants={siblings.length > 1 ? () => setReopenedParentId(m.parentId) : undefined}
                    pendingApprovals={extras[m.id]?.pendingApprovals ?? []}
                    onResolveApproval={resolveApproval}
                  />
                );
              })
            )}

            {openVariants.length > 1 && (
              <VariantTabs
                key={`turn-open-${tailId}`}
                variants={openVariants}
                extras={extras}
                models={models}
                keptId={null}
                onKeep={(id) => void keepVariant(id)}
                onRetry={(v) => void retryVariant(v)}
                retryingIds={retryingIds}
                onResolveApproval={resolveApproval}
              />
            )}
          </div>
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-muted)] shadow hover:text-[var(--text)]"
          >
            <span aria-hidden="true">↓</span> Jump to latest
          </button>
        )}
      </div>
      <Composer key={chat.id} chat={chat} parentId={tailId} />
    </main>
  );
}
