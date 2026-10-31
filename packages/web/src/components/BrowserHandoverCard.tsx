import { useState, type JSX } from 'react';
import type { AskReply, UserAsk } from '@otherbench/core/types/thread.js';
import { answerErrorText, DesktopOnlyNote } from '../lib/desktopOnly.js';
import { oneLine } from '../viewer/browser.js';

export interface BrowserHandoverCardProps {
  ask: Extract<UserAsk, { kind: 'browser' }>;
  profileName: string;
  onAnswer: (askId: string, reply: AskReply) => Promise<void>;
}

/** The model has stopped at something only a person can clear (an "are you human" check, a sign-in) and is waiting. */
export function BrowserHandoverCard({ ask, profileName, onAnswer }: BrowserHandoverCardProps): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(reply: AskReply): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onAnswer(ask.id, reply);
    } catch (err) {
      console.error(`[otherbench-web] failed to answer ${ask.id}:`, err);
      setPending(false);
      setError(answerErrorText(err, 'Could not send that. Please try again.'));
    }
  }

  return (
    <div role="group" aria-label={`${profileName} needs you in the browser`} data-testid={`ask-card-${ask.id}`} data-kind="browser" className="my-1 space-y-2 rounded-sm border border-l-[3px] border-[var(--accent)] bg-[var(--bg-raised)] px-3 py-2 text-sm">
      <p className="font-medium">
        {profileName} needs you on <bdi>{oneLine(ask.site)}</bdi>
      </p>
      {/* The reason can repeat what a page said: <bdi> keeps its direction from spilling out. */}
      <p className="whitespace-pre-wrap">
        <bdi>{oneLine(ask.reason)}</bdi>
      </p>
      <p className="text-xs text-[var(--text-muted)]">
        {ask.window ? 'Use the browser window that has opened, or the Browser panel here.' : 'Use the Browser panel here.'} The model can read what you enter on the page, except passwords. It waits about 10 minutes.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={() => void send({ approve: true })} className="btn btn-primary px-2 py-1">
          I'm done
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
