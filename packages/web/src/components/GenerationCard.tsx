import { useEffect, useRef, useState, type JSX } from 'react';
import { GENERATION_PROMPT_MAX_CHARS } from '@otherbench/core/domain/thread-tools.js';
import type { AskReply, UserAsk } from '@otherbench/core/types/thread.js';
import { ApiError } from '../state/api.js';
import { answerErrorText, DesktopOnlyNote } from '../lib/desktopOnly.js';

export interface GenerationCardProps {
  ask: Extract<UserAsk, { kind: 'generation' }>;
  profileName: string;
  onAnswer: (askId: string, reply: AskReply) => Promise<void>;
}

/** A media tool's prompt, shown before anything reaches the backend: generate it as is, edit it first, or cancel. */
export function GenerationCard({ ask, profileName, onAnswer }: GenerationCardProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(ask.prompt);
  const [negative, setNegative] = useState(ask.negativePrompt ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  // Switching rows unmounts the focused button; hand focus to the control that replaces it (not on first mount).
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    (editing ? promptRef.current : editRef.current)?.focus();
  }, [editing]);

  async function send(reply: AskReply): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onAnswer(ask.id, reply);
    } catch (err) {
      console.error(`[otherbench-web] failed to answer generation ${ask.id}:`, err);
      setPending(false);
      // A 400 carries the server's reason (e.g. a prompt over the length limit), so show that.
      setError(err instanceof ApiError && err.status === 400 ? err.message : answerErrorText(err, 'Could not send that answer. Please try again.'));
    }
  }

  // Unedited, both go back exactly as shown. A negative prompt emptied in the editor goes back as none.
  const negativePrompt = ask.negativePrompt === null ? null : negative.trim() === '' ? null : negative;
  const noun = ask.media === 'video' ? 'a video' : 'an image';
  const field = 'w-full resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]';

  return (
    <div role="group" aria-label={`${profileName} wants to generate ${noun}`} data-testid={`ask-card-${ask.id}`} data-kind="generation" className="my-1 space-y-2 rounded-sm border border-l-[3px] border-[var(--accent)] bg-[var(--bg-raised)] px-3 py-2 text-sm">
      <p className="font-medium">
        {profileName} wants to generate {noun}
      </p>
      <div className="space-y-1">
        <span className="label-caps text-[var(--text-muted)]">Prompt</span>
        {editing ? (
          <textarea ref={promptRef} aria-label="Prompt" value={prompt} maxLength={GENERATION_PROMPT_MAX_CHARS} disabled={pending} rows={4} onChange={(e) => setPrompt(e.target.value)} className={field} />
        ) : (
          <p className="whitespace-pre-wrap rounded-sm bg-[var(--bg-sunken)] px-2 py-1">{prompt}</p>
        )}
      </div>
      {ask.negativePrompt !== null && (
        <div className="space-y-1">
          <span className="label-caps text-[var(--text-muted)]">Negative prompt</span>
          {editing ? (
            <textarea aria-label="Negative prompt" value={negative} maxLength={GENERATION_PROMPT_MAX_CHARS} disabled={pending} rows={2} onChange={(e) => setNegative(e.target.value)} className={field} />
          ) : (
            <p className="whitespace-pre-wrap rounded-sm bg-[var(--bg-sunken)] px-2 py-1">{negative}</p>
          )}
        </div>
      )}
      <p className="text-xs text-[var(--text-muted)]">{ask.settings}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending || prompt.trim() === ''} onClick={() => void send({ generate: { prompt, negativePrompt } })} className="btn btn-primary px-2 py-1">
          Generate
        </button>
        {!editing && (
          <button
            ref={editRef}
            type="button"
            disabled={pending}
            onClick={() => {
              switched.current = true;
              setEditing(true);
            }}
            className="btn px-2 py-1"
          >
            Edit
          </button>
        )}
        <button type="button" disabled={pending} onClick={() => void send({ declined: true })} className="btn px-2 py-1">
          Cancel
        </button>
      </div>
      <DesktopOnlyNote />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
