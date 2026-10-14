import { useEffect, useRef, useState, type JSX } from 'react';
import { CHANGES_MAX_CHARS } from '@grunt/core/domain/thread-tools.js';
import type { AskReply, UserAsk } from '@grunt/core/types/thread.js';
import { ApiError } from '../state/api.js';
import { MarkdownBody } from './MarkdownBody.js';
import { answerErrorText, DesktopOnlyNote } from '../lib/desktopOnly.js';

export interface PlanCardProps {
  ask: Extract<UserAsk, { kind: 'plan' }>;
  profileName: string;
  onAnswer: (askId: string, reply: AskReply) => Promise<void>;
}

/** The model's plan, waiting for approval (spec 2026-10-12-thread-cards-design §4, §7). Approving lets it start; each call still asks as usual. */
export function PlanCard({ ask, profileName, onAnswer }: PlanCardProps): JSX.Element {
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const askChangesRef = useRef<HTMLButtonElement>(null);
  // Switching rows unmounts the focused button; hand focus to the control that replaces it (not on first mount).
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    (changing ? noteRef.current : askChangesRef.current)?.focus();
  }, [changing]);

  function setMode(next: boolean): void {
    switched.current = true;
    setChanging(next);
  }

  async function send(reply: AskReply): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onAnswer(ask.id, reply);
    } catch (err) {
      console.error(`[grunt-web] failed to answer plan ${ask.id}:`, err);
      setPending(false);
      // A 400 carries the server's reason (e.g. an answer over the length limit), so show that.
      setError(err instanceof ApiError && err.status === 400 ? err.message : answerErrorText(err, 'Could not send that answer. Please try again.'));
    }
  }

  return (
    <div role="group" aria-label={`${profileName}'s plan`} data-testid={`ask-card-${ask.id}`} data-kind="plan" className="my-1 space-y-2 rounded-sm border border-l-[3px] border-[var(--accent)] bg-[var(--bg-raised)] px-3 py-2 text-sm">
      <p className="font-medium">{profileName} proposes a plan</p>
      <div className="max-h-80 overflow-y-auto rounded-sm bg-[var(--bg-sunken)] px-2 py-1">
        <MarkdownBody text={ask.plan} />
      </div>
      <p className="text-xs text-[var(--text-muted)]">Approving lets it start. Each tool call that changes something still asks as usual.</p>
      {changing ? (
        <div className="space-y-1">
          <textarea
            ref={noteRef}
            aria-label="Changes to the plan"
            value={note}
            maxLength={CHANGES_MAX_CHARS}
            disabled={pending}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            className="w-full resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending || note.trim() === ''} onClick={() => void send({ changes: note.trim() })} className="btn btn-primary px-2 py-1">
              Send changes
            </button>
            <button type="button" disabled={pending} onClick={() => setMode(false)} className="btn px-2 py-1">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => void send({ approve: true })} className="btn btn-primary px-2 py-1">
            Approve plan
          </button>
          <button ref={askChangesRef} type="button" disabled={pending} onClick={() => setMode(true)} className="btn px-2 py-1">
            Ask for changes
          </button>
        </div>
      )}
      <DesktopOnlyNote />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
