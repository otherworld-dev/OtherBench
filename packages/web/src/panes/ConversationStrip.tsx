import { useEffect, useMemo, useState, type JSX } from 'react';
import { contextLineOf } from '@otherbench/core/domain/context-lines.js';
import { activePath, childrenOf, extendToTip } from '@otherbench/core/domain/tree.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { PinIcon } from '../components/icons.js';
import { NARROW_BREAKPOINT, useMediaQuery } from '../lib/useMediaQuery.js';
import { setChatPinned } from '../state/chatActions.js';
import { streamStatusText } from '../state/machines.js';
import { useClaudeAccounts } from '../state/claudeAccounts.js';
import { useOtherBenchStore } from '../state/store.js';

const OUTLINE_USER_CHARS = 60;
const OUTLINE_REPLY_CHARS = 80;
export const OUTLINE_OPEN_KEY = 'otherbench.outlineOpen';

/** Whitespace collapsed to one line, cut to `max` chars with an ellipsis. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Text parts only, as one clipped line. */
function oneLine(message: CanonMessage, max: number): string {
  return clip(message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' '), max);
}

/** How a prompt reads in the outline: a /clear or /compact line by what it did. */
function promptLabel(user: CanonMessage): string {
  const line = contextLineOf(user);
  if (line) return line.kind === 'clear' ? 'Context cleared' : 'Context compacted';
  return oneLine(user, OUTLINE_USER_CHARS) || '(attachment)';
}

/** The peek under a prompt; null for none (a /clear has no reply, a compact shows its summary). */
function replyPreview(user: CanonMessage, reply: CanonMessage | null): string | null {
  if (contextLineOf(user)) {
    const summary = reply?.parts.find((p) => p.type === 'context-summary');
    if (summary?.type === 'context-summary') return clip(summary.text, OUTLINE_REPLY_CHARS);
    return reply?.status === 'streaming' ? '…' : null;
  }
  if (!reply) return '(no reply)';
  if (reply.status === 'streaming') return `${oneLine(reply, OUTLINE_REPLY_CHARS)}…`;
  return oneLine(reply, OUTLINE_REPLY_CHARS) || '(no reply)';
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OUTLINE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OUTLINE_OPEN_KEY, open ? '1' : '0');
  } catch {
    // storage unavailable -- the preference just won't persist.
  }
}

/**
 * The pane's header row (spec 2026-10-11-sidebar-layout-design §1): the
 * chat's title and pin toggle, then an outline of the user turns on the
 * chat's CURRENT branch (the same display path Thread renders: head -> root,
 * extended forward through single-child replies), the live stream's status
 * when there's a problem, and in the narrow layout the Inspector button.
 * Collapsed the outline is one row (count + latest prompt); expanded it
 * lists every prompt, each with a one-line peek at the reply, newest at the
 * bottom. Clicking one scrolls the thread to that message (Message gives its
 * article, or a /clear or /compact line, the DOM id `msg-<id>`) and leaves the outline open. Always renders,
 * even before the first message. Scoped to this chat's messages for the same
 * reason Thread is: the store's message pool is cross-chat.
 */
export interface ConversationStripProps {
  chat: Chat;
  /** The pane's viewer toggle, at the row's right end. */
  viewer?: { open: boolean; onToggle: () => void };
}

export function ConversationStrip({ chat, viewer }: ConversationStripProps): JSX.Element {
  const messages = useOtherBenchStore((s) => s.messages);
  const streamStatus = useOtherBenchStore((s) => s.streamStatus);
  const machines = useOtherBenchStore((s) => s.machines);
  const overlayOpen = useOtherBenchStore((s) => s.inspectorOverlayOpen);
  const setOverlayOpen = useOtherBenchStore((s) => s.setInspectorOverlayOpen);
  // In Code mode the overlay is the Code panel, whose Chat tab holds the Inspector (spec 2026-10-20-code-tab-design).
  const codeMode = useOtherBenchStore((s) => s.mode === 'code');
  const isNarrow = useMediaQuery(NARROW_BREAKPOINT);
  const [open, setOpen] = useState(readOpen);
  const accountName = useClaudeAccounts((s) => (chat.claudeAccount && chat.claudeAccount !== 'main' ? (s.accounts.find((a) => a.slug === chat.claudeAccount)?.name ?? chat.claudeAccount) : null));
  const [pinError, setPinError] = useState<string | null>(null);
  useEffect(() => setPinError(null), [chat.id]);

  const turns = useMemo(() => {
    const chatMessages = Object.values(messages).filter((m) => m.chatId === chat.id);
    if (!chat.headMessageId) return [];
    let path: CanonMessage[];
    try {
      path = activePath(chatMessages, chat.headMessageId);
      const tail = path[path.length - 1];
      if (tail) path = [...path, ...extendToTip(chatMessages, tail.id)];
    } catch {
      return []; // inconsistent/partially-loaded slice -- show nothing rather than throw.
    }
    const out: { user: CanonMessage; reply: CanonMessage | null }[] = [];
    path.forEach((m, i) => {
      if (m.role !== 'user') return;
      const next = path[i + 1];
      // On the path the reply is simply the next message; at an unresolved
      // compare tail there is none yet, so peek at the first assistant child.
      const reply = next?.role === 'assistant' ? next : (childrenOf(chatMessages, m.id).find((c) => c.role === 'assistant') ?? null);
      out.push({ user: m, reply });
    });
    return out;
  }, [messages, chat.id, chat.headMessageId]);

  const latest = turns.at(-1);
  const status = streamStatusText(streamStatus, chat, machines);

  function toggle(): void {
    const next = !open;
    setOpen(next);
    writeOpen(next);
  }

  async function togglePin(): Promise<void> {
    const pinned = !chat.pinned;
    setPinError(null);
    try {
      await setChatPinned(chat.id, pinned);
    } catch (err) {
      console.error(`[otherbench-web] failed to ${pinned ? 'pin' : 'unpin'} chat ${chat.id}:`, err);
      setPinError(pinned ? "Couldn't pin the chat" : "Couldn't unpin the chat");
    }
  }

  return (
    <section aria-label="Conversation" className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-[var(--border)] bg-[var(--bg-raised)] text-sm">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1">
        <span title={chat.title} className="min-w-0 shrink truncate text-sm font-medium">
          {chat.title}
        </span>
        {accountName && (
          <span aria-label="Claude account" className="shrink-0 rounded border border-[var(--account-colour,var(--border))] px-1.5 text-[0.6875rem] text-[var(--text-muted)]">
            {accountName}
          </span>
        )}
        {/* Archived chats can't be pinned, here as in the sidebar row and its menu. */}
        {chat.archivedAt === null && (
          <button
            type="button"
            onClick={() => void togglePin()}
            aria-label={chat.pinned ? 'Unpin chat' : 'Pin chat'}
            title={chat.pinned ? 'Unpin chat' : 'Pin chat'}
            className={`shrink-0 rounded p-1 hover:bg-[var(--bg-sunken)] ${chat.pinned ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
          >
            <PinIcon filled={chat.pinned} />
          </button>
        )}
        {latest ? (
          <>
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              · {turns.length} prompt{turns.length === 1 ? '' : 's'}
            </span>
            {open ? (
              <span className="flex-1" />
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-faint)]">{promptLabel(latest.user)}</span>
            )}
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-label={open ? 'Hide conversation outline' : 'Show conversation outline'}
              className="shrink-0 rounded px-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
            >
              <span aria-hidden="true">{open ? '▴' : '▾'}</span>
            </button>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {/* These truncate rather than push the buttons out of a narrow pane. */}
        {pinError && (
          <span role="alert" title={pinError} className="min-w-0 truncate text-xs text-[var(--danger)]">
            {pinError}
          </span>
        )}
        {status && (
          <span data-testid="stream-status" title={status} className="min-w-0 truncate text-xs text-[var(--text-muted)]">
            {status}
          </span>
        )}
        {viewer && (
          <button
            type="button"
            aria-pressed={viewer.open}
            title={viewer.open ? 'Hide the viewer' : 'Show the viewer: files, images and pages from this chat'}
            onClick={viewer.onToggle}
            className="btn shrink-0 px-2 py-0.5"
          >
            Viewer
          </button>
        )}
        {isNarrow && (
          <button type="button" onClick={() => setOverlayOpen(!overlayOpen)} aria-expanded={overlayOpen} className="btn shrink-0 px-2 py-0.5">
            {codeMode ? 'Panel' : 'Inspector'}
          </button>
        )}
      </div>
      {open && latest && (
        <ul data-testid="outline-list" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2">
          {turns.map(({ user, reply }) => {
            const preview = replyPreview(user, reply);
            return (
              <li key={user.id}>
                <button
                  type="button"
                  data-testid={`outline-${user.id}`}
                  aria-label={`Go to: ${promptLabel(user)}`}
                  onClick={() => document.getElementById(`msg-${user.id}`)?.scrollIntoView({ block: 'start' })}
                  className="block w-full rounded px-1 py-0.5 text-left hover:bg-[var(--bg-sunken)]"
                >
                  <span className="block truncate text-sm">{promptLabel(user)}</span>
                  {preview !== null && <span className="block truncate text-xs text-[var(--text-muted)]">{preview}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
