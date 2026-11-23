import type { JSX } from 'react';
import { groupLeft, type AgentStatus } from '@otherbench/core/domain/chat-status-tool.js';
import { MarkdownBody } from './MarkdownBody.js';

/**
 * What the reply said about the chat's work (spec 2026-11-15-chat-done-status-design): a green "Done" line, or
 * what's left, grouped by who it waits on so the user can see at a glance whether anything needs them. Read from
 * the reply's own `set_chat_status` call, as the row's word is. A "you" item's `ask` is the question itself, shown
 * in full at reading size: the agent can't leave it in its thinking, which the user doesn't see.
 */
export function ChatStatusCard({ status }: { status: AgentStatus }): JSX.Element {
  if (status.done) {
    return (
      <div data-testid="chat-status-card" data-done="true" className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs font-medium text-[var(--success)]">
        Done: nothing left in this chat
      </div>
    );
  }
  return (
    <div data-testid="chat-status-card" data-done="false" className="my-1 space-y-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      {groupLeft(status.left).map((g) => (
        <div key={g.label} data-who={g.who ?? 'untagged'}>
          {/* Amber only for what waits on the user, or untagged items from older replies: the rest needs nothing from them. */}
          <div className={`font-medium ${g.who === 'me' || g.who === 'parked' ? 'text-[var(--text-muted)]' : 'text-[var(--warn)]'}`}>{g.label}:</div>
          <ul aria-label={g.label} className="mt-0.5 list-disc space-y-0.5 pl-4">
            {g.items.map((item, i) => (
              <li key={i}>
                {item.text}
                {item.ask !== undefined && (
                  <div data-testid="chat-status-ask" className="mt-0.5 mb-1 text-sm text-[var(--text)]">
                    <MarkdownBody text={item.ask} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
