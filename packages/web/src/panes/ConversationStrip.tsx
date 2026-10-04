import { useMemo, useState, type JSX } from 'react';
import { activePath, childrenOf, extendToTip } from '@grunt/core/domain/tree.js';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { useGruntStore } from '../state/store.js';

const OUTLINE_USER_CHARS = 60;
const OUTLINE_REPLY_CHARS = 80;
export const OUTLINE_OPEN_KEY = 'grunt.outlineOpen';

/** Text parts only, whitespace collapsed to one line, cut to `max` chars with an ellipsis. */
function oneLine(message: CanonMessage, max: number): string {
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
 * A slim strip above the chat: an outline of the user turns on the chat's
 * CURRENT branch (the same display path Thread renders: head -> root,
 * extended forward through single-child replies), each with a one-line peek
 * at the reply. Collapsed it is one row (count + latest prompt); expanded it
 * lists every prompt, newest at the bottom. Clicking one scrolls the thread
 * to that message (Message gives its article the DOM id `msg-<id>`) and
 * leaves the strip open. Renders nothing until the chat has a user message.
 * Scoped to this chat's messages for the same reason Thread is: the store's
 * message pool is cross-chat.
 */
export function ConversationStrip({ chat }: { chat: Chat }): JSX.Element | null {
  const messages = useGruntStore((s) => s.messages);
  const [open, setOpen] = useState(readOpen);

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
  if (!latest) return null;

  function toggle(): void {
    const next = !open;
    setOpen(next);
    writeOpen(next);
  }

  return (
    <section aria-label="Conversation" className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-[var(--border)] bg-[var(--bg-raised)] text-sm">
      <div className="flex shrink-0 items-center gap-2 px-4 py-1">
        <span className="shrink-0 text-xs font-medium text-[var(--text-muted)]">
          Conversation · {turns.length} prompt{turns.length === 1 ? '' : 's'}
        </span>
        {!open && <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-faint)]">{oneLine(latest.user, OUTLINE_USER_CHARS) || '(attachment)'}</span>}
        {open && <span className="flex-1" />}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? 'Hide conversation outline' : 'Show conversation outline'}
          className="shrink-0 rounded px-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
        >
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      </div>
      {open && (
        <ul data-testid="outline-list" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2">
          {turns.map(({ user, reply }) => {
            const preview = !reply ? '(no reply)' : reply.status === 'streaming' ? `${oneLine(reply, OUTLINE_REPLY_CHARS)}…` : oneLine(reply, OUTLINE_REPLY_CHARS) || '(no reply)';
            return (
              <li key={user.id}>
                <button
                  type="button"
                  data-testid={`outline-${user.id}`}
                  aria-label={`Go to: ${oneLine(user, OUTLINE_USER_CHARS) || '(attachment)'}`}
                  onClick={() => document.getElementById(`msg-${user.id}`)?.scrollIntoView({ block: 'start' })}
                  className="block w-full rounded px-1 py-0.5 text-left hover:bg-[var(--bg-sunken)]"
                >
                  <span className="block truncate text-sm">{oneLine(user, OUTLINE_USER_CHARS) || '(attachment)'}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{preview}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
