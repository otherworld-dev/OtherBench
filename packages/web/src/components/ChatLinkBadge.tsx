import { Fragment, type JSX } from 'react';
import type { Part } from '@otherbench/core/types/messages.js';
import { useOtherBenchStore } from '../state/store.js';

type ChatLinkPart = Extract<Part, { type: 'chat-link' }>;

/**
 * The line over a message another chat's agent wrote (spec 2026-11-06-chat-to-chat-design): "From <chat>" on a
 * message a chat was sent, "Replies from <chat>, <chat>" on the one that brings the replies back. Each name opens
 * that chat.
 */
export function ChatLinkBadge({ part }: { part: ChatLinkPart }): JSX.Element {
  const open = useOtherBenchStore((s) => s.setActiveChatId);
  return (
    <div data-testid="chat-link" className="mb-1 text-xs text-[var(--text-muted)]">
      {part.kind === 'from' ? 'From ' : 'Replies from '}
      {part.chats.map((c, i) => (
        <Fragment key={c.chatId}>
          {i > 0 && ', '}
          <button type="button" onClick={() => open(c.chatId)} className="font-medium text-[var(--accent)] hover:underline">
            {c.title}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
