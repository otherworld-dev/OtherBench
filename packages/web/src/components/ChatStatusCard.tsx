import { useState, type JSX } from 'react';
import { groupLeft, statusReplyText, type AgentStatus, type StatusAnswer, type StatusGroup, type StatusItem } from '@otherbench/core/domain/chat-status-tool.js';
import { useOtherBenchStore } from '../state/store.js';
import { MarkdownBody } from './MarkdownBody.js';

interface ChatStatusCardProps {
  status: AgentStatus;
  /** The chat the reply is in: where the user's ticks and answers go, into its message box. */
  chatId?: string;
  /** The chat's latest reply: its items can be ticked and answered. An earlier reply's card is only read. */
  active?: boolean;
}

/** Amber only for what the user can do something about, or untagged items from older replies: the rest needs nothing from them yet. */
const headingTone = (g: StatusGroup): string => (g.key === 'now' || g.key === 'untagged' ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]');

/**
 * What the reply said about the chat's work (spec 2026-11-15-chat-done-status-design): a green "Done" line, or what's
 * left. Read from the reply's own `set_chat_status` call, as the row's word is.
 *
 * What needs the user comes first, one line an item: a task has a tick box, a question its answers as buttons, and
 * either opens to its `ask` (the request in full, which the agent can't leave in its thinking). The ticks and answers
 * collect on the card and go into the chat's message box as one message, for the user to add to and send. Everything
 * else (theirs for later, the agent's next steps, parked) folds into one line under it, so the card is as long as
 * what the user has to do. A card with nothing for the user lists its groups in full, as there is nothing to fold under.
 */
export function ChatStatusCard({ status, chatId, active = false }: ChatStatusCardProps): JSX.Element {
  const groups = status.done ? [] : groupLeft(status.left);
  const needs = groups.filter((g) => g.needsUser);
  const rest = groups.filter((g) => !g.needsUser);
  const asked = needs.flatMap((g) => g.items);
  // One thing to do is short enough to show whole; more than one opens on a click.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(asked.length === 1 && asked[0] ? [status.left.indexOf(asked[0])] : []));
  const [restOpen, setRestOpen] = useState(false);
  const [answers, setAnswers] = useState<Readonly<Record<number, StatusAnswer>>>({});
  const prefillComposer = useOtherBenchStore((s) => s.prefillComposer);

  if (status.done) {
    return (
      <div data-testid="chat-status-card" data-done="true" className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs font-medium text-[var(--success)]">
        Done: nothing left in this chat
      </div>
    );
  }

  const canAnswer = active && chatId !== undefined;
  const answered = Object.keys(answers).length;

  function toggleOpen(index: number): void {
    setOpen((now) => {
      const next = new Set(now);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }

  /** Sets the item's answer, or takes it back when it is the one already given. */
  function answer(index: number, given: StatusAnswer): void {
    setAnswers((now) => {
      const { [index]: had, ...others } = now;
      const same = had !== undefined && ('done' in had ? 'done' in given : 'option' in given && had.option === given.option);
      return same ? others : { ...others, [index]: given };
    });
  }

  function reply(): void {
    if (chatId === undefined || answered === 0) return;
    prefillComposer(chatId, statusReplyText(status.left, answers));
    setAnswers({});
  }

  function row(item: StatusItem): JSX.Element {
    const index = status.left.indexOf(item);
    const isOpen = open.has(index);
    const given = answers[index];
    return (
      <li key={index} data-testid="chat-status-item" className="py-0.5">
        <div className="flex items-start gap-2">
          {canAnswer && !item.options && (
            <input
              type="checkbox"
              aria-label={`Done: ${item.text}`}
              checked={given !== undefined}
              onChange={() => answer(index, { done: true })}
              className="mt-1 shrink-0 accent-[var(--accent)]"
            />
          )}
          {item.ask !== undefined ? (
            <button type="button" aria-expanded={isOpen} onClick={() => toggleOpen(index)} className="flex min-w-0 flex-1 items-start gap-1 text-left text-sm text-[var(--text)] hover:text-[var(--accent)]">
              <span aria-hidden="true" className="shrink-0 text-[var(--text-faint)]">{isOpen ? '▾' : '▸'}</span>
              <span className={`[overflow-wrap:anywhere] ${given !== undefined && !item.options ? 'text-[var(--text-muted)] line-through' : ''}`}>{item.text}</span>
            </button>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-[var(--text)] [overflow-wrap:anywhere]">{item.text}</span>
          )}
          {canAnswer && item.options && (
            <span role="group" aria-label={`Answer: ${item.text}`} className="flex shrink-0 flex-wrap justify-end gap-1">
              {item.options.map((option) => {
                const picked = given !== undefined && 'option' in given && given.option === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => answer(index, { option })}
                    className={`rounded-sm px-2 py-0.5 text-xs ring-1 ring-inset ${picked ? 'bg-[var(--accent)] text-[var(--bg)] ring-[var(--accent)]' : 'text-[var(--text)] ring-[var(--border-strong)] hover:ring-[var(--accent)]'}`}
                  >
                    {option}
                  </button>
                );
              })}
            </span>
          )}
        </div>
        {item.ask !== undefined && isOpen && (
          <div data-testid="chat-status-ask" className="mt-0.5 mb-1 ml-5 border-l border-[var(--border)] pl-2 text-sm text-[var(--text)]">
            <MarkdownBody text={item.ask} />
            {!canAnswer && item.options && <div className="text-xs text-[var(--text-muted)]">Answers: {item.options.join(' / ')}</div>}
          </div>
        )}
      </li>
    );
  }

  const plain = (g: StatusGroup): JSX.Element => (
    <div key={g.key} data-group={g.key}>
      <div className={`font-medium ${headingTone(g)}`}>{g.label}:</div>
      <ul aria-label={g.label} className="mt-0.5 list-disc space-y-0.5 pl-4">
        {g.items.map((item, i) => (
          <li key={i}>{item.text}</li>
        ))}
      </ul>
    </div>
  );

  return (
    <div data-testid="chat-status-card" data-done="false" className="my-1 space-y-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      {needs.map((g) => (
        <div key={g.key} data-group={g.key}>
          <div className={`font-medium ${headingTone(g)}`}>
            {g.label}
            {g.key === 'now' ? ` (${g.items.length})` : ''}:
          </div>
          <ul aria-label={g.label} className="mt-0.5">
            {g.items.map(row)}
          </ul>
        </div>
      ))}

      {canAnswer && answered > 0 && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-[var(--text-muted)]">Goes into the message box for you to send.</span>
          <button type="button" data-testid="chat-status-reply" onClick={reply} className="btn px-2 py-0.5 text-xs">
            Reply with {answered === 1 ? 'this' : `these ${answered}`}
          </button>
        </div>
      )}

      {needs.length === 0 ? (
        rest.map(plain)
      ) : (
        rest.length > 0 && (
          <div data-testid="chat-status-rest">
            <button type="button" aria-expanded={restOpen} onClick={() => setRestOpen((v) => !v)} className="flex items-start gap-1 text-left text-[var(--text-muted)] hover:text-[var(--text)]">
              <span aria-hidden="true" className="shrink-0">{restOpen ? '▾' : '▸'}</span>
              <span>Not waiting on you: {rest.map((g) => `${g.items.length} ${g.label.toLowerCase()}`).join(' · ')}</span>
            </button>
            {restOpen && <div className="mt-1 space-y-1 pl-4">{rest.map(plain)}</div>}
          </div>
        )
      )}
    </div>
  );
}
