import type { JSX } from 'react';
import type { ChatStatus } from '../state/chatStatus.js';

/** What each dot means, for screen readers. */
export const STATUS_LABELS: Record<ChatStatus, string> = { waiting: 'waiting for you', working: 'replying', ready: 'reply ready', background: 'working in the background' };

/** What each dot means, on hover. */
export const STATUS_TOOLTIPS: Record<ChatStatus, string> = {
  waiting: 'Waiting for you: an approval, question or plan',
  working: 'Replying',
  ready: "Reply ready: you haven't opened it since",
  background: 'Working in the background: no reply running, but its tasks are',
};

/** Each status has its own shape, so a solid dot only ever means a reply ready. */
const STATUS_SHAPES: Record<ChatStatus, string> = {
  waiting: 'h-2.5 w-2.5 bg-[var(--warn)] [clip-path:polygon(50%_0,100%_100%,0_100%)]',
  working: 'h-2 w-2 rounded-full border-[1.5px] border-[var(--accent)] border-t-transparent animate-spin motion-reduce:animate-none',
  ready: 'h-1.5 w-1.5 rounded-full bg-[var(--accent)]',
  background: 'h-2 w-2 rounded-full border-[1.5px] border-[var(--accent)] opacity-70',
};

/**
 * A chat's status as a small mark: an amber triangle while an approval, question or plan waits
 * for the user, a spinning ring while a reply is written, a solid dot once a reply is ready, and
 * a still, open ring while only its background tasks run.
 * Hovering it says which. `hidden` leaves it out of the accessibility tree, for a caller that
 * says it in text; `title` replaces the hover text, e.g. a project heading's counts.
 */
export function StatusDot({
  status,
  testId,
  hidden = false,
  title,
  className = '',
}: {
  status: ChatStatus;
  testId: string;
  hidden?: boolean;
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      data-testid={testId}
      data-status={status}
      title={title ?? STATUS_TOOLTIPS[status]}
      {...(hidden ? { 'aria-hidden': true } : { role: 'img', 'aria-label': STATUS_LABELS[status] })}
      // The padding gives the tooltip something bigger than a few pixels to hover.
      className={`-m-1 inline-flex shrink-0 items-center justify-center p-1 ${className}`}
    >
      <span aria-hidden="true" className={`inline-block shrink-0 ${STATUS_SHAPES[status]}`} />
    </span>
  );
}
