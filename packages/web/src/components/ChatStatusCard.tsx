import type { JSX } from 'react';
import type { AgentStatus } from '@otherbench/core/domain/chat-status-tool.js';

/**
 * What the reply said about the chat's work (spec 2026-11-15-chat-done-status-design): a green "Done" line, or
 * what's left. Read from the reply's own `set_chat_status` call, as the row's word is.
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
    <div data-testid="chat-status-card" data-done="false" className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <div className="font-medium text-[var(--warn)]">Left:</div>
      <ul aria-label="Still left" className="mt-0.5 list-disc space-y-0.5 pl-4">
        {status.left.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
