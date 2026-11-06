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
  failed: 'Failed',
  'your-turn': 'Your turn',
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
  failed: 'The reply failed',
  'your-turn': 'Finished: over to you',
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
  failed: `${PILL} bg-[var(--danger)] text-[var(--bg)]`,
  'your-turn': `${PILL} text-[var(--warn)] ring-1 ring-inset ring-[var(--warn)]`,
  working: 'text-[var(--accent)]',
  'waiting-chats': 'text-[var(--accent)]',
  background: 'text-[var(--text-muted)]',
};

/** A chat's status in a word. */
export function StatusWord({ status, testId, className = '' }: { status: ChatStatus; testId: string; className?: string }): JSX.Element {
  return (
    <span data-testid={testId} data-status={status} title={STATUS_TOOLTIPS[status]} className={`shrink-0 whitespace-nowrap text-[11px] leading-4 ${STATUS_STYLES[status]} ${className}`}>
      {STATUS_WORDS[status]}
    </span>
  );
}
