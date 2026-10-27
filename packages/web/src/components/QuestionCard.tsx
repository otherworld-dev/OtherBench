import { useState, type JSX } from 'react';
import { ANSWER_MAX_CHARS } from '@otherbench/core/domain/thread-tools.js';
import type { AskReply, UserAsk } from '@otherbench/core/types/thread.js';
import { ApiError } from '../state/api.js';
import { answerErrorText, DesktopOnlyNote } from '../lib/desktopOnly.js';

export interface QuestionCardProps {
  ask: Extract<UserAsk, { kind: 'question' }>;
  profileName: string;
  /** Resolves once the server took the answer; rejecting re-enables the card with an error. */
  onAnswer: (askId: string, reply: AskReply) => Promise<void>;
}

interface Choice {
  picked: string[];
  other: boolean;
  otherText: string;
}

const EMPTY: Choice = { picked: [], other: false, otherText: '' };

/** One question's answer as Claude Code takes it: the chosen labels and any typed answer, joined with ", ". */
function answerOf(choice: Choice): string {
  return [...choice.picked, ...(choice.other && choice.otherText.trim() !== '' ? [choice.otherText.trim()] : [])].join(', ');
}

/**
 * The model's multiple-choice questions (spec 2026-10-12-thread-cards-design §7). Option previews aren't shown; "Other" is always offered.
 * Two or more questions go on tabs, one question showing at a time, so their options don't run together.
 */
export function QuestionCard({ ask, profileName, onAnswer }: QuestionCardProps): JSX.Element {
  const [choices, setChoices] = useState<Choice[]>(() => ask.questions.map(() => EMPTY));
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = ask.questions.map((_, i) => answerOf(choices[i] ?? EMPTY));
  const complete = answers.every((a) => a.length > 0);
  const tabbed = ask.questions.length > 1;
  const update = (i: number, next: (c: Choice) => Choice): void => setChoices((prev) => prev.map((c, j) => (j === i ? next(c) : c)));
  const tabId = (i: number): string => `ask-${ask.id}-tab-${i}`;
  const panelId = (i: number): string => `ask-${ask.id}-panel-${i}`;

  /** After a single-select pick, move on to the next question still unanswered, if there is one. */
  function advanceFrom(i: number): void {
    const n = ask.questions.length;
    for (let step = 1; step < n; step++) {
      const j = (i + step) % n;
      if (answers[j] === '') {
        setActive(j);
        return;
      }
    }
  }

  function focusTab(i: number, list: HTMLElement): void {
    setActive(i);
    list.querySelector<HTMLElement>(`#${CSS.escape(tabId(i))}`)?.focus();
  }

  async function send(reply: AskReply): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onAnswer(ask.id, reply);
    } catch (err) {
      console.error(`[otherbench-web] failed to answer ${ask.id}:`, err);
      setPending(false);
      // A 400 carries the server's reason (e.g. an answer over the length limit), so show that.
      setError(err instanceof ApiError && err.status === 400 ? err.message : answerErrorText(err, 'Could not send that answer. Please try again.'));
    }
  }

  return (
    <div role="group" aria-label={`${profileName} asks`} data-testid={`ask-card-${ask.id}`} data-kind="question" className="my-1 space-y-2 rounded-sm border border-l-[3px] border-[var(--accent)] bg-[var(--bg-raised)] px-3 py-2 text-sm">
      <p className="font-medium">{profileName} asks</p>
      {tabbed && (
        <div
          role="tablist"
          aria-label="Questions"
          className="flex flex-wrap gap-1 border-b border-[var(--border)]"
          onKeyDown={(e) => {
            const n = ask.questions.length;
            const to = e.key === 'ArrowRight' ? (active + 1) % n : e.key === 'ArrowLeft' ? (active - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
            if (to === null) return;
            e.preventDefault();
            focusTab(to, e.currentTarget);
          }}
        >
          {ask.questions.map((q, i) => (
            <button
              key={i}
              id={tabId(i)}
              type="button"
              role="tab"
              aria-selected={active === i}
              aria-controls={panelId(i)}
              tabIndex={active === i ? 0 : -1}
              data-answered={answers[i] !== '' ? 'true' : 'false'}
              onClick={() => setActive(i)}
              className={`flex items-center gap-1 rounded-t-sm px-2 py-1 text-xs ${active === i ? 'text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]'}`}
            >
              <span>{q.header || `Question ${i + 1}`}</span>
              {answers[i] !== '' && <span aria-hidden="true" className="text-[var(--accent)]">✓</span>}
            </button>
          ))}
        </div>
      )}
      {ask.questions.map((q, i) => {
        const choice = choices[i] ?? EMPTY;
        const name = `ask-${ask.id}-${i}`;
        const type = q.multiSelect ? 'checkbox' : 'radio';
        const fieldset = (
          <fieldset className="space-y-1">
            <legend className="flex items-center gap-2">
              {q.header && !tabbed && <span className="rounded-full border border-[var(--border)] px-1.5 text-[0.6875rem] text-[var(--text-muted)]">{q.header}</span>}
              <span>{q.question}</span>
            </legend>
            {q.options.map((o) => (
              <label key={o.label} className="flex items-start gap-1.5">
                <input
                  type={type}
                  name={name}
                  disabled={pending}
                  checked={choice.picked.includes(o.label)}
                  onChange={(e) => {
                    update(i, (c) =>
                      q.multiSelect ? { ...c, picked: e.target.checked ? [...c.picked, o.label] : c.picked.filter((l) => l !== o.label) } : { ...c, picked: [o.label], other: false }
                    );
                    if (tabbed && !q.multiSelect) advanceFrom(i);
                  }}
                />
                <span>
                  <span className="font-medium">{o.label}</span>
                  {o.description && <span className="text-xs text-[var(--text-muted)]"> · {o.description}</span>}
                </span>
              </label>
            ))}
            <label className="flex items-center gap-1.5">
              <input type={type} name={name} disabled={pending} checked={choice.other} onChange={(e) => update(i, (c) => (q.multiSelect ? { ...c, other: e.target.checked } : { ...c, picked: [], other: true }))} />
              <span>Other</span>
            </label>
            {choice.other && (
              <input
                type="text"
                aria-label={`Your answer to: ${q.question}`}
                disabled={pending}
                maxLength={ANSWER_MAX_CHARS}
                value={choice.otherText}
                onChange={(e) => update(i, (c) => ({ ...c, otherText: e.target.value }))}
                className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]"
              />
            )}
          </fieldset>
        );
        return tabbed ? (
          <div key={i} role="tabpanel" id={panelId(i)} aria-labelledby={tabId(i)} hidden={active !== i}>
            {fieldset}
          </div>
        ) : (
          <div key={i}>{fieldset}</div>
        );
      })}
      <p className="text-xs text-[var(--text-muted)]">
        {tabbed && !complete ? `Answer all ${ask.questions.length} questions to send. ` : ''}Your answer goes to the model and stays in this chat.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending || !complete} onClick={() => void send({ answers })} className="btn btn-primary px-2 py-1">
          Send answer
        </button>
        <button type="button" disabled={pending} onClick={() => void send({ declined: true })} className="btn px-2 py-1">
          Skip
        </button>
      </div>
      <DesktopOnlyNote />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
