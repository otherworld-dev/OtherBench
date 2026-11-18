import type { JSX } from 'react';
import { groupLeft, waitingOnUser, type StatusItem } from '@otherbench/core/domain/chat-status-tool.js';
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

/** A `left` word when nothing left waits on the user: everything is the agent's next step or parked. */
const LEFT_QUIET = `${PILL} text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border-strong)]`;

/** The hover text for what's left: each group's label, then its items. */
function leftTooltip(items: readonly StatusItem[]): string {
  return groupLeft(items).map((g) => `${g.label}:\n${g.items.map((i) => `  ${i}`).join('\n')}`).join('\n');
}

/**
 * A chat's status in a word. `left` is what the agent said is still left (`ChatHead.agentStatus`): with it a `left`
 * status reads "2 for you" (amber) when items wait on the user, else a quiet "2 left" when every item is the agent's
 * or parked, and lists the items on hover; untagged items from older replies keep the amber "2 left". Without it (a
 * count across chats), "Work left".
 */
export function StatusWord({ status, testId, className = '', left }: { status: ChatStatus; testId: string; className?: string; left?: readonly StatusItem[] | undefined }): JSX.Element {
  const items = status === 'left' && left && left.length > 0 ? left : null;
  const yours = items ? waitingOnUser(items) : 0;
  const quiet = items !== null && items.every((i) => i.who === 'me' || i.who === 'parked');
  const word = !items ? STATUS_WORDS[status] : yours > 0 ? `${yours} for you` : `${items.length} left`;
  return (
    <span
      data-testid={testId}
      data-status={status}
      {...(items ? { 'data-for-you': String(yours) } : {})}
      title={items ? leftTooltip(items) : STATUS_TOOLTIPS[status]}
      className={`shrink-0 whitespace-nowrap text-[11px] leading-4 ${quiet ? LEFT_QUIET : STATUS_STYLES[status]} ${className}`}
    >
      {word}
    </span>
  );
}
