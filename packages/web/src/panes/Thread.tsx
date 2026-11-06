import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { flushSync } from 'react-dom';
import { activePath, childrenOf, extendToTip, isCompareSet, siblingsOf } from '@otherbench/core/domain/tree.js';
import { contextLineOf } from '@otherbench/core/domain/context-lines.js';
import type { ApprovalChoice, AskReply } from '@otherbench/core/ports/tool-provider.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { GitBar } from '../code/GitBar.js';
import { Composer } from '../components/Composer.js';
import { FindBar } from '../components/FindBar.js';
import { Gwyn } from '../components/Gwyn.js';
import { ComputerBanner } from '../components/ComputerBanner.js';
import { UnreachableBanner } from '../components/UnreachableBanner.js';
import { ElsewhereWorking } from '../components/ElsewhereWorking.js';
import { BackgroundHelpers } from '../components/BackgroundHelpers.js';
import { WorkspacePrompt } from '../components/WorkspacePrompt.js';
import { Message, userTextPreview } from '../components/Message.js';
import { VariantTabs } from '../components/VariantTabs.js';
import { FactCards } from '../components/AppNoteCards.js';
import { WaitingNotes } from '../components/WaitingNotes.js';
import { api, ApiError } from '../state/api.js';
import { escapeStopsReply } from '../lib/escapeStopsReply.js';
import { findMatches, firstMatchFrom, isFindShortcut, isMacPlatform, messageFindText, stepMatch, type FindMatch } from '../lib/chatFind.js';
import { findRoots, locateMatch, showFindHighlight } from '../lib/findInDom.js';
import { clampWindow, windowFor, type DrawnWindow } from '../lib/threadWindow.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useOtherBenchStore } from '../state/store.js';
import { useStopReply } from '../state/useStopReply.js';
import { DEFAULT_VIEWER, useViewerStore, viewerFor } from '../viewer/state.js';
import { ViewerContext, viewerActionsFor } from '../viewer/ViewerContext.js';
import { ViewerPanel } from '../viewer/ViewerPanel.js';
import { useBrowserAutoOpen } from '../viewer/useBrowserAutoOpen.js';
import { useClaudeAccounts } from '../state/claudeAccounts.js';
import { ConversationStrip } from './ConversationStrip.js';
import { Splitter } from './Splitter.js';

/** How close (px) to the bottom still counts as "following" the thread. */
const NEAR_BOTTOM_PX = 80;

/**
 * How many messages a chat draws when it opens, and how many more each time the reader nears the top. Drawing a
 * 586-message chat whole froze the window for about two seconds; the end of it is what's read.
 */
export const THREAD_WINDOW = 40;
/** How close (px) to the top the reader gets before earlier messages are drawn. */
const DRAW_EARLIER_PX = 600;
/** Find's key: Cmd+F on a Mac, else Ctrl+F. */
const MAC = isMacPlatform();

/** Find in this chat, while its bar is open: what's looked for, and the match shown (by message, and which in it). */
interface FindState {
  chatId: string | null;
  query: string;
  at: { messageId: string; occurrence: number } | null;
}

/** The thread of a chat with no head, or none drawn yet: one array, so it doesn't redraw what depends on it. */
const NO_MESSAGES: CanonMessage[] = [];

/** The path to `headId`, or null when it can't be drawn yet: not loaded, or a parent on the way missing. */
function pathOrNull(messages: CanonMessage[], headId: string): CanonMessage[] | null {
  try {
    return activePath(messages, headId);
  } catch {
    return null;
  }
}

/** A drawn message in this thread's scroller. Not by `document.getElementById`: two panes can show the same chat. */
function drawnMessage(scroller: HTMLElement | null, messageId: string): HTMLElement | null {
  if (!scroller) return null;
  const id = `msg-${messageId}`;
  return Array.from(scroller.querySelectorAll<HTMLElement>('[id^="msg-"]')).find((el) => el.id === id) ?? null;
}

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
 * `messages` in the store is a flat, cross-chat pool (the messages of every
 * chat in use and of the few viewed last; the rest are forgotten on a chat
 * switch and loaded again when they next show -- see messagePool.ts).
 * `siblingsOf`/`childrenOf`/`extendForward` all group purely by
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
  // The chat's running replies, for Escape (the section's onKeyDown) as well as the composer's Stop.
  const replies = useStopReply(chat?.id ?? null);
  const resetMessageForRetry = useOtherBenchStore((s) => s.resetMessageForRetry);
  const viewer = useViewerStore((s) => viewerFor(s.viewers, chat?.id ?? ''));
  const setViewerOpen = useViewerStore((s) => s.setOpen);
  const setViewerShare = useViewerStore((s) => s.setShare);
  const [draftShare, setDraftShare] = useState<number | null>(null);
  const chatId = chat?.id ?? null;
  const viewerActions = useMemo(() => (chatId ? viewerActionsFor(chatId) : null), [chatId]);
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

  const chatMessages = useMemo(
    () => (chatId ? Object.values(messages).filter((m) => m.chatId === chatId) : []),
    [messages, chatId]
  );
  useBrowserAutoOpen(chatId, chatMessages, viewer.open);
  // The viewer bar's Browser button: shown once the model has used the browser in this chat.
  const browserUsed = useMemo(() => chatMessages.some((m) => m.parts.some((p) => p.type === 'tool-call' && p.name === 'browser')), [chatMessages]);
  // The head last drawn for this chat. The head can move to a message the store hasn't loaded yet (a message sent
  // while a reply ran goes out on the server, and the chat's new head arrives before its messages): until they
  // arrive the thread keeps showing the path to this one, rather than going blank for a moment, which scrolled a
  // long chat to the top. Only the head is kept, so it changes once per new message, not with every streamed chunk.
  const headId = chat?.headMessageId ?? null;
  const freshPath = useMemo(() => (headId === null ? null : pathOrNull(chatMessages, headId)), [chatMessages, headId]);
  const [drawnHead, setDrawnHead] = useState<{ chatId: string | null; headId: string } | null>(null);
  if (freshPath !== null && headId !== null && (drawnHead?.chatId !== chatId || drawnHead.headId !== headId)) setDrawnHead({ chatId, headId });
  const heldHeadId = freshPath === null && headId !== null && drawnHead?.chatId === chatId ? drawnHead.headId : null;
  const heldPath = useMemo(() => (heldHeadId === null ? null : pathOrNull(chatMessages, heldHeadId)), [chatMessages, heldHeadId]);
  const path = headId === null ? NO_MESSAGES : (freshPath ?? heldPath ?? NO_MESSAGES);

  const displayPath = useMemo(() => {
    if (path.length === 0) return [];
    const tail = path[path.length - 1]!;
    return [...path, ...extendToTip(chatMessages, tail.id)];
  }, [path, chatMessages]);

  const tailId = displayPath.at(-1)?.id ?? null;

  // Which messages are drawn (lib/threadWindow.ts). Where they start is fixed once a chat is drawn, so a message
  // arriving at the end doesn't take one off the top under a reader who has scrolled up, and moved earlier only as
  // they near the top or go to an older message. They run to the end of the chat, unless find or the outline went
  // to a message far back: then only the messages round it are drawn (`end`), more as the reader nears the bottom.
  const [drawnFrom, setDrawnFrom] = useState<({ chatId: string | null } & DrawnWindow) | null>(null);
  const latestStart = Math.max(0, displayPath.length - THREAD_WINDOW);
  const drawn: DrawnWindow = drawnFrom?.chatId === chatId ? clampWindow(drawnFrom, displayPath.length, THREAD_WINDOW) : { start: latestStart, end: null };
  const { start, end } = drawn;
  if (displayPath.length > 0 && drawnFrom?.chatId !== chatId) setDrawnFrom({ chatId, start, end: null });
  // The window as last committed, for the scroll handler and the layout effects below (see the effect after drawLater).
  const startRef = useRef(start);
  const endRef = useRef(end);
  const drawEarlierRef = useRef<() => void>(() => undefined);
  const drawLaterRef = useRef<() => void>(() => undefined);
  /** Draws whatever it takes for message `index` on the path to be drawn. */
  const drawTo = (index: number): void => {
    const next = windowFor(drawn, Math.min(index, displayPath.length - 1), displayPath.length, THREAD_WINDOW);
    if (next.start !== start || next.end !== end) setDrawnFrom({ chatId, ...next });
  };

  // Auto-follow: stay pinned to the bottom while the user is already there,
  // but never yank the view while they've scrolled up to read. `nearBottom`
  // is updated ONLY by scroll events, so at content-change time it still
  // reflects where the user was BEFORE the change.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastChatIdRef = useRef<string | null>(null);
  // The scroller's height when last measured. A scroll event can land after the thread has shrunk (the message box
  // grew in the same frame as a streamed delta was pinned) but before the ResizeObserver re-pins it; judged on the
  // gap alone that read as the user scrolling away, and left a long chat stuck short of its bottom.
  const lastClientHeightRef = useRef<number | null>(null);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const resized = lastClientHeightRef.current !== null && lastClientHeightRef.current !== el.clientHeight;
    lastClientHeightRef.current = el.clientHeight;
    if (resized && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Messages left undrawn below: the bottom of what's drawn isn't the latest, so it's never followed.
    const near = endRef.current === null && below <= NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    setShowJump(!near);
    if (el.scrollTop < DRAW_EARLIER_PX && startRef.current > 0) drawEarlierRef.current();
    if (below < DRAW_EARLIER_PX && endRef.current !== null) drawLaterRef.current();
  }, []);

  // Drawing earlier messages puts them above the reader. The message that was first is noted with where it sat, and
  // after drawing the view moves by however far it was pushed down, so what's being read stays put. Relative, not a
  // scrollTop worked out beforehand: the browser's own scroll anchoring may already have moved it, and a wheel scroll
  // may still be gliding.
  const keepPlaceRef = useRef<{ id: string; y: number } | null>(null);
  const drawEarlier = (): void => {
    const first = displayPath[start];
    const el = first ? document.getElementById(`msg-${first.id}`) : null;
    keepPlaceRef.current = first && el ? { id: first.id, y: el.getBoundingClientRect().top } : null;
    setDrawnFrom({ chatId, start: Math.max(0, start - THREAD_WINDOW), end });
  };
  // Drawing later messages puts them below the reader, so nothing they're reading moves.
  const drawLater = (): void => {
    if (end !== null) setDrawnFrom({ chatId, start, end: end + THREAD_WINDOW });
  };
  // Declared before the layout effects that read these, so they see this render's window. A scroll event comes
  // between commits, so the handler always sees the window that is on screen.
  useLayoutEffect(() => {
    startRef.current = start;
    endRef.current = end;
    drawEarlierRef.current = drawEarlier;
    drawLaterRef.current = drawLater;
  });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = keepPlaceRef.current;
    keepPlaceRef.current = null;
    const kept = before ? document.getElementById(`msg-${before.id}`) : null;
    if (!el || !before || !kept) return;
    el.scrollTop += kept.getBoundingClientRect().top - before.y;
  }, [start]);

  // A prompt picked in the conversation outline: draw back to it first if it's earlier than what's drawn, then go there.
  // The draw is committed at once (flushSync), so the message is on the page to scroll to straight after.
  const goTo = (messageId: string): void => {
    const at = displayPath.findIndex((m) => m.id === messageId);
    flushSync(() => {
      if (at !== -1) drawTo(at);
    });
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ block: 'start' });
    if (endRef.current !== null) {
      nearBottomRef.current = false;
      setShowJump(true);
    }
  };

  const openVariants = useMemo(() => (tailId ? childrenOf(chatMessages, tailId) : []), [chatMessages, tailId]);
  const openCompare = openVariants.length > 1 && isCompareSet(openVariants);
  const sendUnder = openCompare ? (openVariants.find((v) => v.id === shownVariantId) ?? openVariants[0]!) : null;

  // Find in this chat (Ctrl+F in the pane). It searches every message on the thread's path, drawn or not, and the
  // reply on show in a compare turn waiting at the end (lib/chatFind.ts); going to a match draws to it as the outline
  // does, without drawing everything between (lib/threadWindow.ts), then scrolls to it and highlights it
  // (lib/findInDom.ts). The bar belongs to the chat it was opened on, so switching chats in the pane closes it.
  const searchPath = useMemo(() => (sendUnder ? [...displayPath, sendUnder] : displayPath), [displayPath, sendUnder]);
  const [find, setFind] = useState<FindState | null>(null);
  const findOpen = find !== null && find.chatId === chatId;
  const findQuery = findOpen ? find.query : '';
  const matches = useMemo(() => findMatches(searchPath, findQuery), [searchPath, findQuery]);
  const findAt = findOpen ? find.at : null;
  const findIndex = findAt ? matches.findIndex((m) => m.messageId === findAt.messageId && m.occurrence === findAt.occurrence) : -1;
  const findTarget = findIndex >= 0 ? matches[findIndex] : undefined;
  // A long user message is drawn folded; one whose match is past the fold is drawn open.
  const findMessage = findTarget ? searchPath[findTarget.index] : undefined;
  const findPreview = findMessage?.role === 'user' ? userTextPreview(messageFindText(findMessage)) : null;
  const unfoldId = findTarget && findPreview !== null && findTarget.start + findQuery.length > findPreview.length ? findTarget.messageId : null;
  const sectionRef = useRef<HTMLElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findReturnRef = useRef<HTMLElement | null>(null);
  const lastFindQueryRef = useRef('');
  // This thread's find highlight, told apart from another pane's on the same chat.
  const [findOwner] = useState(() => ({}));

  /** The first message on the path at least partly in view, for find to start from as a browser's does. */
  const firstInView = (): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const top = el.getBoundingClientRect().top;
    const seen = Array.from(el.querySelectorAll('[id^="msg-"]')).find((node) => node.getBoundingClientRect().bottom > top);
    const at = seen ? searchPath.findIndex((m) => `msg-${m.id}` === seen.id) : -1;
    return Math.max(0, at);
  };
  /**
   * Shows `match` of `query`: the find state and the draw are committed at once (flushSync), so the message is on
   * the page, unfolded if the match is past its fold, to highlight and scroll to straight after.
   */
  const showMatch = (query: string, match: FindMatch): void => {
    flushSync(() => {
      setFind({ chatId, query, at: { messageId: match.messageId, occurrence: match.occurrence } });
      // A compare reply at the end is drawn whenever the end of the path is.
      drawTo(match.index);
    });
    const el = scrollRef.current;
    const article = drawnMessage(el, match.messageId);
    if (!el || !article) return;
    const range = locateMatch(findRoots(article), query, match.occurrence);
    showFindHighlight(findOwner, range);
    // jsdom has no layout for a Range; there the message is scrolled to instead.
    const box = range && typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    if (box && (box.width > 0 || box.height > 0)) {
      const view = el.getBoundingClientRect();
      // Left where it is when it's already in view (clear of the find bar), else put a third of the way down.
      if (box.top < view.top + 48 || box.bottom > view.bottom - 16) el.scrollTop += box.top - view.top - el.clientHeight / 3;
    } else {
      article.scrollIntoView({ block: 'center' });
    }
    // Moving off the bottom stops the thread following new text before the scroll event says so.
    nearBottomRef.current = endRef.current === null && el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    if (!nearBottomRef.current) setShowJump(true);
  };
  const search = (query: string): void => {
    lastFindQueryRef.current = query;
    const found = query === findQuery ? matches : findMatches(searchPath, query);
    const first = found[firstMatchFrom(found, firstInView())];
    if (first) {
      showMatch(query, first);
      return;
    }
    setFind({ chatId, query, at: null });
    showFindHighlight(findOwner, null);
  };
  const stepFind = (delta: 1 | -1): void => {
    const next = matches[stepMatch(matches.length, findIndex, delta)];
    if (next) showMatch(findQuery, next);
  };
  const openFind = (): void => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
      return;
    }
    findReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    search(lastFindQueryRef.current);
  };
  const closeFind = (): void => {
    setFind(null);
    showFindHighlight(findOwner, null);
    const back = findReturnRef.current;
    (back?.isConnected ? back : sectionRef.current)?.focus();
  };
  useLayoutEffect(() => {
    if (!findOpen) showFindHighlight(findOwner, null);
  }, [findOpen, findOwner]);
  useEffect(() => () => showFindHighlight(findOwner, null), [findOwner]);

  // Jump to latest from messages drawn far back draws the end of the chat afresh (committed at once), then goes to its bottom.
  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = true;
    setShowJump(false);
    if (end !== null) flushSync(() => setDrawnFrom({ chatId, start: latestStart, end: null }));
    el.scrollTop = el.scrollHeight;
  };

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
      lastClientHeightRef.current = el.clientHeight;
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatId]);

  // Regenerate and Edit would race a running reply, so they wait for the chat to be quiet.
  const chatStreaming = useMemo(() => chatMessages.some((m) => m.status === 'streaming'), [chatMessages]);

  // A chat on another Claude account is tinted in that account's colour; the accounts load once, when one is needed.
  const accounts = useClaudeAccounts((s) => s.accounts);
  const loadAccounts = useClaudeAccounts((s) => s.load);
  const pinned = chat?.claudeAccount ?? null;
  useEffect(() => {
    if (pinned && pinned !== 'main' && accounts.length === 0) loadAccounts().catch((err: unknown) => console.error('[otherbench-web] failed to load the Claude accounts:', err));
  }, [pinned, accounts.length, loadAccounts]);
  const tint = pinned && pinned !== 'main' ? (accounts.find((a) => a.slug === pinned)?.colour ?? 'var(--accent)') : null;

  if (!chat) {
    return (
      <section aria-label="No chat open" className="flex h-full w-full flex-1 flex-col items-center justify-center gap-4 text-sm text-[var(--text-faint)]">
        <Gwyn mood="peek" className="h-28 w-28" />
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
      // eslint-disable-next-line react-hooks/purity -- runs after the server's answer, never in render; the compiler assumes the branch switcher's onSelect, built inside the messages' .map, may run while rendering.
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
        <section
          ref={sectionRef}
          aria-label={chat.title}
          {...(tint ? { 'data-account': pinned } : {})}
          style={{ flex: viewer.open ? `${1 - share} 1 0` : '1 1 0', ...(tint ? { '--account-colour': tint } : {}) }}
          // Focusable (not by Tab), so a click on the thread's text keeps Ctrl+F in this chat.
          tabIndex={-1}
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden outline-none"
          // Ctrl+F (Cmd+F on a Mac) in this chat finds in it; anywhere else it stays the browser's.
          // Escape anywhere in this chat stops its running reply, as Stop does (lib/escapeStopsReply.ts).
          onKeyDown={(e) => {
            if (isFindShortcut(e, MAC)) {
              e.preventDefault();
              openFind();
              return;
            }
            // The section itself only has focus from a click on the thread's text: Escape there (to drop a selection,
            // say) doesn't stop the reply, as before the section took focus.
            if (e.target === e.currentTarget) return;
            if (!replies.canStop || !escapeStopsReply({ key: e.key, defaultPrevented: e.defaultPrevented, isComposing: e.nativeEvent.isComposing, target: e.target })) return;
            e.preventDefault();
            void replies.stop();
          }}
        >
          {switchError && (
            <div role="alert" className="flex items-center justify-between gap-3 border-b border-[var(--danger)] bg-[var(--bg-raised)] px-4 py-2 text-sm text-[var(--danger)]">
              <span>{switchError}</span>
              <button type="button" onClick={() => setSwitchError(null)} className="btn btn-danger shrink-0 px-2 py-0.5">
                Dismiss
              </button>
            </div>
          )}
          <ConversationStrip chat={chat} viewer={{ open: viewer.open, onToggle: () => setViewerOpen(chat.id, !viewer.open) }} onGoTo={goTo} />
          {/* An app chat's git bar (spec 2026-10-20-code-tab-design, Goals 2 and 6), never a Chat mode chat's. It gets the chat's whole
              tree, every branch and variant this window holds (GET /chats/:id/messages sends all of it), not just the path shown. */}
          {chat.appId !== null && <GitBar chat={chat} messages={chatMessages} />}
          <div className="relative min-h-0 flex-1">
            {findOpen && (
              <FindBar query={findQuery} current={findIndex} total={matches.length} onQueryChange={search} onStep={stepFind} onClose={closeFind} inputRef={findInputRef} />
            )}
            <div ref={scrollRef} onScroll={onScroll} data-testid="thread-scroll" className="absolute inset-0 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
                {displayPath.length === 0 && chat.headMessageId !== null ? (
                  // The chat has messages, they just haven't arrived: Gwyn waits with you, held back a moment so a quick load never flashes him.
                  <div role="status" className="gwyn-appear flex flex-col items-center gap-3 pt-16 text-sm text-[var(--text-faint)]" style={{ '--gwyn-delay': '300ms' } as CSSProperties}>
                    <Gwyn mood="loading" className="h-24 w-24" />
                    Opening the chat…
                  </div>
                ) : displayPath.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 pt-16 text-sm text-[var(--text-faint)]">
                    <Gwyn mood="wave" className="h-24 w-24" />
                    No messages yet -- say something below.
                  </div>
                ) : (
                  <>
                  {start > 0 && (
                    <div className="flex justify-center">
                      <button type="button" onClick={drawEarlier} className="btn px-3 py-1 text-xs">
                        Show earlier messages ({start} more)
                      </button>
                    </div>
                  )}
                  {displayPath.slice(start, end ?? undefined).map((m) => {
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
                        />
                      );
                    }
                    return (
                      <Message
                        key={m.id}
                        message={m}
                        framed
                        showAllText={m.id === unfoldId}
                        otherVariantsCount={compare ? siblings.length - 1 : 0}
                        onReopenVariants={compare ? () => setReopenedParentId(m.parentId) : undefined}
                        pendingApprovals={extras[m.id]?.pendingApprovals ?? []}
                        onResolveApproval={resolveApproval}
                        pendingAsks={extras[m.id]?.pendingAsks ?? []}
                        onAnswerAsk={answerAsk}
                        {...(extras[m.id]?.progressByCall ? { progressByCall: extras[m.id]?.progressByCall } : {})}
                        {...(extras[m.id]?.thinkingSince !== undefined ? { thinkingSince: extras[m.id]?.thinkingSince } : {})}
                        {...(extras[m.id]?.thinkingTokens !== undefined ? { thinkingTokens: extras[m.id]?.thinkingTokens } : {})}
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
                  })}
                  {end !== null && (
                    <div className="flex justify-center">
                      <button type="button" onClick={drawLater} className="btn px-3 py-1 text-xs">
                        Show later messages ({displayPath.length - end} more)
                      </button>
                    </div>
                  )}
                  </>
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
                <FactCards chatId={chat.id} />
              </div>
            </div>
            {showJump && (
              <button
                type="button"
                onClick={jumpToLatest}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[3px] border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-muted)] shadow hover:text-[var(--text)]"
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
