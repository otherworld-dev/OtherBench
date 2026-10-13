import type { JSX } from 'react';
import type { ChatStatus } from '../state/chatStatus.js';

/** What each dot means, for screen readers. */
export const STATUS_LABELS: Record<ChatStatus, string> = { waiting: 'waiting for approval', working: 'replying', ready: 'reply ready' };

const STATUS_STYLES: Record<ChatStatus, string> = {
  waiting: 'bg-[var(--warn)]',
  working: 'animate-pulse bg-[var(--accent)]',
  ready: 'bg-[var(--accent)]',
};

/**
 * A chat's status as a small dot: amber while a tool call waits for approval,
 * pulsing while a reply is written, solid once a reply is ready. `hidden`
 * leaves it out of the accessibility tree, for a caller that says it in text.
 */
export function StatusDot({ status, testId, hidden = false, className = '' }: { status: ChatStatus; testId: string; hidden?: boolean; className?: string }): JSX.Element {
  return (
    <span
      data-testid={testId}
      data-status={status}
      {...(hidden ? { 'aria-hidden': true } : { role: 'img', 'aria-label': STATUS_LABELS[status] })}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLES[status]} ${className}`}
    />
  );
}
