import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { activePath, childrenOf, extendToTip, isCompareSet, siblingsOf } from '@otherbench/core/domain/tree.js';
import { contextLineOf } from '@otherbench/core/domain/context-lines.js';
import type { ApprovalChoice, AskReply } from '@otherbench/core/ports/tool-provider.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { GitBar } from '../code/GitBar.js';
import { Composer } from '../components/Composer.js';
import { ComputerBanner } from '../components/ComputerBanner.js';
import { UnreachableBanner } from '../components/UnreachableBanner.js';
import { ElsewhereWorking } from '../components/ElsewhereWorking.js';
import { BackgroundHelpers } from '../components/BackgroundHelpers.js';
import { WorkspacePrompt } from '../components/WorkspacePrompt.js';
import { Message } from '../components/Message.js';
import { VariantTabs } from '../components/VariantTabs.js';
import { WaitingNotes } from '../components/WaitingNotes.js';
import { api, ApiError } from '../state/api.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useOtherBenchStore } from '../state/store.js';
import { DEFAULT_VIEWER, useViewerStore, viewerFor } from '../viewer/state.js';
import { ViewerContext, viewerActionsFor } from '../viewer/ViewerContext.js';
import { ViewerPanel } from '../viewer/ViewerPanel.js';
import { useBrowserAutoOpen } from '../viewer/useBrowserAutoOpen.js';
import { ConversationStrip } from './ConversationStrip.js';
import { Splitter } from './Splitter.js';

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
 * Every other sibling set (a reply added by Regenerate, a user message
 * re-sent through Edit) is a branch: the message shows a `‹ 2 / 3 ›`
 * switcher, and switching moves the head to that branch's tip (`extendToTip`)
 * so the whole conversation below it changes with it.
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
  const messages = useOtherBenchStore((s) => s.messages);
  const extras = useOtherBenchStore((s) => s.extras);
  const models = useOtherBenchStore((s) => s.models);
  const setHeadMessageId = useOtherBenchStore((s) => s.setHeadMessageId);
  const markKept = useOtherBenchStore((s) => s.markKept);
  const registerMessage = useOtherBenchStore((s) => s.registerMessage);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const resetMessageForRetry = useOtherBenchStore((s) => s.resetMessageForRetry);
  const viewer = useViewerStore((s) => viewerFor(s.viewers, chat?.id ?? ''));
  const setViewerOpen = useViewerStore((s) => s.setOpen);
  const setViewerShare = useViewerStore((s) => s.setShare);
  const [draftShare, setDraftShare] = useState<number | null>(null);
  const viewerActions = useMemo(() => (chat ? viewerActionsFor(chat.id) : null), [chat?.id]);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Which turn's tab strip has been manually reopened from its "⤺ N other
  // variants" chip, identified by the shared `parentId` of its sibling set
  // (there is at most one shared parent per turn, so this alone disambiguates).
  const [reopenedParentId, setReopenedParentId] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [composerProfileId, setComposerProfileId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // The tab showing in an unresolved compare strip at the tail: sending
  // continues from it (#821), rather than parenting the new message on the
  // user message beside the variants.
  const [shownVariantId, setShownVariantId] = useState<string | null>(null);

  const chatId = chat?.id ?? null;
  const chatMessages = useMemo(
    () => (chatId ? Object.values(messages).filter((m) => m.chatId === chatId) : []),
    [messages, chatId]
  );
  useBrowserAutoOpen(chatId, chatMessages, viewer.open);
  // The viewer bar's Browser button: shown once the model has used the browser in this chat.
  const browserUsed = useMemo(() => chatMessages.some((m) => m.parts.some((p) => p.type === 'tool-call' && p.name === 'browser')), [chatMessages]);
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
    return [...path, ...extendToTip(chatMessages, tail.id)];
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

  // Messages sent while a reply runs, waiting at the end of the thread.
  const waitingNotes = useOtherBenchStore((s) => (chatId ? s.chatNotes[chatId] : undefined));

  // Runs after every change to this chat's rendered content (messages incl.
  // streamed deltas and parts, plus extras such as pending approval cards
  // and waiting notes).
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
  }, [chatId, chatMessages, extras, displayPath, waitingNotes]);

  // The scroller changes size without a scroll event (e.g. the conversation
  // strip opening above it), which would leave a pinned thread's newest
  // messages below the fold. Re-pin when we were following the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatId]);

  const openVariants = useMemo(() => (tailId ? childrenOf(chatMessages, tailId) : []), [chatMessages, tailId]);
  const openCompare = openVariants.length > 1 && isCompareSet(openVariants);
  const sendUnder = openCompare ? (openVariants.find((v) => v.id === shownVariantId) ?? openVariants[0]!) : null;
  // Regenerate and Edit would race a running reply, so they wait for the chat to be quiet.
  const chatStreaming = useMemo(() => chatMessages.some((m) => m.status === 'streaming'), [chatMessages]);

  if (!chat) {
    return (
      <section aria-label="No chat open" className="flex h-full w-full flex-1 items-center justify-center text-sm text-[var(--text-faint)]">
        Select a chat, or start a new one, to begin.
      </section>
    );
  }

  /** Moves the head to `messageId`, optimistically, rolling back (with a message) if the server refuses. */
  async function moveHead(messageId: string, failure: string): Promise<boolean> {
    const previousHeadId = chat!.headMessageId;
    setSwitchError(null);
    setHeadMessageId(chat!.id, messageId);
    try {
      await api.turns.setHead(chat!.id, messageId);
    } catch (err) {
      console.error('[otherbench-web] failed to move head:', err);
      if (previousHeadId) setHeadMessageId(chat!.id, previousHeadId);
      setSwitchError(failure);
      return false;
    }
    // The server records landing on a compare variant as keeping it; mirror that.
    const target = chatMessages.find((m) => m.id === messageId);
    if (target?.role === 'assistant' && target.parentId && isCompareSet(childrenOf(chatMessages, target.parentId))) {
      markKept(messageId, Date.now());
    }
    return true;
  }

  /** Branch switcher: head goes to the tip of `target`'s branch, so everything below it is shown. */
  function selectBranch(target: CanonMessage, siblings: CanonMessage[]): void {
    const text = `Branch ${siblings.findIndex((x) => x.id === target.id) + 1} of ${siblings.length}`;
    const tip = extendToTip(chatMessages, target.id).at(-1) ?? target;
    setEditingId(null);
    void moveHead(tip.id, "Couldn't switch branch -- the server rejected the change, so it was reverted. Please try again.").then((ok) => {
      // Only once the switch stuck; the alternating non-breaking space makes a
      // repeat of identical words a real content change, so it is announced again.
      if (ok) setAnnouncement((prev) => (prev.endsWith('\u00a0') ? text : `${text}\u00a0`));
    });
  }

  async function regenerate(reply: CanonMessage): Promise<void> {
    setSwitchError(null);
    try {
      const result = await api.turns.regenerate(chat!.id, reply.id);
      const by = reply.producedBy;
      if (by) {
        registerMessage(
          buildAssistantStub(chat!, result.assistantMessageId, result.userMessageId, { id: by.profileId, name: by.profileName, connectionId: by.connectionId, modelId: by.modelId }, true)
        );
      }
      // The server already moved its head; mirror that here.
      setHeadMessageId(chat!.id, result.assistantMessageId);
    } catch (err) {
      console.error('[otherbench-web] failed to regenerate:', err);
      setSwitchError("Couldn't regenerate that reply. Please try again.");
    }
  }

  /**
   * The profile an edited message is re-sent with: the one that answered the
   * original (what Regenerate uses too), else the composer picker's current
   * choice, else the chat's own profile, else the first available.
   */
  function editProfile(original: CanonMessage): { id: string; name: string; connectionId: string; modelId: string } | null {
    // Prefer the reply on the displayed path (the kept variant of a compare turn), else any reply.
    const next = displayPath[displayPath.findIndex((d) => d.id === original.id) + 1];
    const onPath = next && next.parentId === original.id && next.producedBy ? next : null;
    const answeredBy = (onPath ?? childrenOf(chatMessages, original.id).find((c) => c.producedBy))?.producedBy?.profileId ?? null;
    for (const wanted of [answeredBy, composerProfileId, chat!.profileId]) {
      const found = wanted ? profiles.find((p) => p.id === wanted && p.archivedAt === null) : undefined;
      if (found) return found;
    }
    return profiles.find((p) => p.archivedAt === null) ?? null;
  }

  async function saveEdit(original: CanonMessage, parts: Part[]): Promise<void> {
    const profile = editProfile(original);
    if (!profile) {
      setSwitchError('No profile is available to send the edited message with.');
      return;
    }
    setEditBusy(true);
    setSwitchError(null);
    try {
      const result = await api.turns.create(chat!.id, { parentId: original.parentId, parts, profileIds: [profile.id] });
      registerMessage(buildUserStub(chat!, result.userMessageId, original.parentId, result.userParts ?? parts));
      for (const id of result.assistantMessageIds) registerMessage(buildAssistantStub(chat!, id, result.userMessageId, profile));
      // Same head rule as Composer: head lands on the new USER message and the
      // thread walks into its lone reply.
      setHeadMessageId(chat!.id, result.userMessageId);
      void api.turns.setHead(chat!.id, result.userMessageId).catch((err: unknown) => console.error('[otherbench-web] failed to persist head:', err));
      setEditingId(null);
    } catch (err) {
      console.error('[otherbench-web] failed to send edited message:', err);
      setSwitchError("Couldn't send the edited message. Please try again.");
    } finally {
      setEditBusy(false);
    }
  }

  async function keepVariant(messageId: string): Promise<void> {
    setReopenedParentId(null); // collapses the tab strip back automatically
    // If the server refuses (e.g. a stale/cross-chat id), moveHead rolls the
    // optimistic head back and says so rather than only logging it.
    await moveHead(messageId, "Couldn't keep that variant -- the server rejected the change, so it was reverted. Please try again.");
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
    try {
      await api.approvals.resolve(requestId, choice);
    } catch (err) {
      // 404: the server no longer knows this request (its turn ended, was
      // cancelled or the server restarted). Retrying can never work, so drop
      // the dead card instead of leaving it up with a retry error.
      if (err instanceof ApiError && err.status === 404) {
        useOtherBenchStore.getState().dropApproval(requestId);
        return;
      }
      throw err;
    }
  }

  /** Answers a question or plan card; a 404 (already settled, turn ended, server restarted) drops the dead card. */
  async function answerAsk(askId: string, reply: AskReply): Promise<void> {
    try {
      await api.asks.answer(askId, reply);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        useOtherBenchStore.getState().dropAsk(askId);
        return;
      }
      throw err;
    }
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
      console.error(`[otherbench-web] failed to retry ${variant.id}:`, err);
    } finally {
      setRetryingIds((s) => {
        const next = new Set(s);
        next.delete(variant.id);
        return next;
      });
    }
  }

  const share = draftShare ?? viewer.share;
  return (
    <ViewerContext.Provider value={viewerActions}>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-1">
        {/* A section, not <main>: the pane grid around it is the page's one main region, and may hold several threads. */}
        <section aria-label={chat.title} style={{ flex: viewer.open ? `${1 - share} 1 0` : '1 1 0' }} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          {switchError && (
            <div role="alert" className="flex items-center justify-between gap-3 border-b border-[var(--danger)] bg-[var(--bg-raised)] px-4 py-2 text-sm text-[var(--danger)]">
              <span>{switchError}</span>
              <button type="button" onClick={() => setSwitchError(null)} className="btn btn-danger shrink-0 px-2 py-0.5">
                Dismiss
              </button>
            </div>
          )}
          <ConversationStrip chat={chat} viewer={{ open: viewer.open, onToggle: () => setViewerOpen(chat.id, !viewer.open) }} />
          {/* An app chat's git bar (spec 2026-10-20-code-tab-design, Goals 2 and 6), never a Chat mode chat's. It gets the chat's whole
              tree, every branch and variant this window holds (GET /chats/:id/messages sends all of it), not just the path shown. */}
          {chat.appId !== null && <GitBar chat={chat} messages={chatMessages} />}
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
                    const compare = isCompareSet(siblings);
                    const isReopened = compare && siblings.length > 1 && m.parentId !== null && m.parentId === reopenedParentId;
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
                          onAnswerAsk={answerAsk}
                        {...(extras[m.id]?.progressByCall ? { progressByCall: extras[m.id]?.progressByCall } : {})}
                        />
                      );
                    }
                    return (
                      <Message
                        key={m.id}
                        message={m}
                        framed
                        otherVariantsCount={compare ? siblings.length - 1 : 0}
                        onReopenVariants={compare ? () => setReopenedParentId(m.parentId) : undefined}
                        pendingApprovals={extras[m.id]?.pendingApprovals ?? []}
                        onResolveApproval={resolveApproval}
                        pendingAsks={extras[m.id]?.pendingAsks ?? []}
                        onAnswerAsk={answerAsk}
                        branch={
                          !compare && siblings.length > 1
                            ? {
                                index: siblings.findIndex((x) => x.id === m.id),
                                total: siblings.length,
                                onSelect: (delta) => {
                                  const target = siblings[siblings.findIndex((x) => x.id === m.id) + delta];
                                  if (target) selectBranch(target, siblings);
                                },
                                disabled: chatStreaming || editBusy,
                              }
                            : undefined
                        }
                        actionsDisabled={chatStreaming || editBusy}
                        onRegenerate={
                          // A compact's reply can't be redone in place (the server refuses it): /compact is sent again instead.
                          m.role === 'assistant' && m.parentId !== null && !compare && contextLineOf(messages[m.parentId] ?? m)?.kind !== 'compact'
                            ? () => void regenerate(m)
                            : undefined
                        }
                        onEdit={m.role === 'user' ? () => setEditingId(m.id) : undefined}
                        editing={
                          editingId === m.id
                            ? {
                                onSave: (parts) => void saveEdit(m, parts),
                                onCancel: () => setEditingId(null),
                                busy: editBusy || chatStreaming,
                                profileName: editProfile(m)?.name,
                                compareNote: isCompareSet(childrenOf(chatMessages, m.id)),
                              }
                            : undefined
                        }
                      />
                    );
                  })
                )}

                {openCompare && (
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
                    onAnswerAsk={answerAsk}
                    onActiveChange={setShownVariantId}
                  />
                )}

                <WaitingNotes chatId={chat.id} />
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
          <div data-testid="branch-announcer" role="status" aria-live="polite" className="sr-only">
            {announcement}
          </div>
          <ComputerBanner chat={chat} />
          <UnreachableBanner chat={chat} />
          <ElsewhereWorking chat={chat} />
          <BackgroundHelpers chatId={chat.id} onResolveApproval={resolveApproval} />
          <WorkspacePrompt chat={chat} />
          <Composer
            key={chat.id}
            chat={chat}
            parentId={sendUnder?.id ?? tailId}
            continuesFrom={sendUnder ? (sendUnder.producedBy?.profileName ?? 'the reply shown') : null}
            onPrimaryProfileChange={setComposerProfileId}
          />
        </section>
        {viewer.open && (
          <>
            <Splitter
              direction="row"
              sizes={[1 - share, share]}
              index={0}
              onResize={(sizes) => setDraftShare(sizes[1]! / (sizes[0]! + sizes[1]!))}
              onCommit={(sizes) => {
                setDraftShare(null);
                setViewerShare(chat.id, sizes[1]! / (sizes[0]! + sizes[1]!));
              }}
              onReset={() => {
                setDraftShare(null);
                setViewerShare(chat.id, DEFAULT_VIEWER.share);
              }}
            />
            <div style={{ flex: `${share} 1 0` }} className="min-h-0 min-w-0">
              <ViewerPanel chat={chat} browserUsed={browserUsed} />
            </div>
          </>
        )}
      </div>
    </ViewerContext.Provider>
  );
}
