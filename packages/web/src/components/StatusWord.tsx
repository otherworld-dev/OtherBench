import type { JSX } from 'react';
import type { ChatStatus } from '../state/chatStatus.js';

/** The word on a chat's row, tab or list entry. */
const STATUS_WORDS: Record<ChatStatus, string> = {
  approve: 'Approve',
  answer: 'Answer',
  plan: 'Review plan',
  generate: 'Generate',
  browser: 'Browser',
  waiting: 'Waiting',
  held: 'Machine off',
  failed: 'Failed',
  'your-turn': 'Your turn',
  done: 'Done',
  left: 'Work left',
  working: 'Replying',
  'waiting-chats': 'Waiting on chats',
  background: 'Background',
};

/** The sentence behind each word, on hover. */
const STATUS_TOOLTIPS: Record<ChatStatus, string> = {
  approve: 'A tool is waiting for your approval',
  answer: 'A question is waiting for your answer',
  plan: 'A plan is waiting for your review',
  generate: 'A prompt is waiting for you to generate',
  browser: 'Needs you in the browser',
  waiting: 'Waiting for you on another machine',
  held: "A message waits for a machine that's off: run it here, wait or cancel it on its send card",
  failed: 'The reply failed',
  'your-turn': 'Finished: over to you',
  done: 'Finished: nothing left, check and archive',
  left: 'Finished this reply, with work still left',
  working: 'Writing a reply',
  'waiting-chats': 'Sent work to other chats: carries on when they reply',
  background: 'Background tasks are running',
};

const PILL = 'rounded-sm px-1.5 font-semibold';
const CARD = `${PILL} bg-[var(--warn)] text-[var(--bg)]`;

/** Amber means it's stopped until you act, solid when a card holds it up; plain text is just getting on with it. */
const STATUS_STYLES: Record<ChatStatus, string> = {
  approve: CARD,
  answer: CARD,
  plan: CARD,
  generate: CARD,
  browser: CARD,
  waiting: CARD,
  held: CARD,
  failed: `${PILL} bg-[var(--danger)] text-[var(--bg)]`,
  'your-turn': `${PILL} text-[var(--warn)] ring-1 ring-inset ring-[var(--warn)]`,
  done: `${PILL} text-[var(--success)] ring-1 ring-inset ring-[var(--success)]`,
  left: `${PILL} text-[var(--warn)] ring-1 ring-inset ring-[var(--warn)]`,
  working: 'text-[var(--accent)]',
  'waiting-chats': 'text-[var(--accent)]',
  background: 'text-[var(--text-muted)]',
};

/**
 * A chat's status in a word. `left` is what the agent said is still left (`ChatHead.agentStatus`): with it a `left`
 * status reads "2 left" and lists the items on hover; without it (a count across chats), "Work left".
 */
export function StatusWord({ status, testId, className = '', left }: { status: ChatStatus; testId: string; className?: string; left?: readonly string[] | undefined }): JSX.Element {
  const items = status === 'left' && left && left.length > 0 ? left : null;
  return (
    <span data-testid={testId} data-status={status} title={items ? items.join('\n') : STATUS_TOOLTIPS[status]} className={`shrink-0 whitespace-nowrap text-[11px] leading-4 ${STATUS_STYLES[status]} ${className}`}>
      {items ? `${items.length} left` : STATUS_WORDS[status]}
    </span>
  );
}
