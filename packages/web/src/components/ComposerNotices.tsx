import type { JSX } from 'react';

/** Said above the box when a message sent while a reply ran comes back into it. */
const NOTE_RETURNED = "Not sent: the reply ended before it was read. It's back in the box.";

export interface ComposerNoticesProps {
  uploadError: string | null;
  removeError: string | null;
  autoError: string | null;
  planError: string | null;
  profileError: string | null;
  effortError: string | null;
  accountError: string | null;
  noteFact: string | null;
  appName: string | null;
  sendError: string | null;
  noteReturned: boolean;
  continuesFrom: string | null;
}

/** The lines above the composer's box: what failed, and hints about where the next message goes. */
export function ComposerNotices({
  uploadError,
  removeError,
  autoError,
  planError,
  profileError,
  effortError,
  accountError,
  noteFact,
  appName,
  sendError,
  noteReturned,
  continuesFrom,
}: ComposerNoticesProps): JSX.Element {
  return (
    <>
      {uploadError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {uploadError}
        </div>
      )}

      {removeError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {removeError}
        </div>
      )}

      {autoError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {autoError}
        </div>
      )}

      {planError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {planError}
        </div>
      )}

      {profileError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {profileError}
        </div>
      )}

      {effortError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {effortError}
        </div>
      )}

      {accountError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {accountError}
        </div>
      )}

      {noteFact !== null && (
        <p role="status" data-testid="composer-note-hint" className="mb-1.5 text-xs text-[var(--text-muted)]">
          Enter saves this to {appName ? `${appName}'s` : "the app's"} notes. It isn't sent to the model.
        </p>
      )}

      {sendError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {sendError}
        </div>
      )}

      {noteReturned && (
        <p role="status" className="mb-1.5 text-xs text-[var(--text-muted)]">
          {NOTE_RETURNED}
        </p>
      )}

      {continuesFrom && (
        <p role="status" className="mb-1.5 text-xs text-[var(--text-muted)]">
          Sending continues from {continuesFrom}'s reply, the tab you're on. The other replies stay in the tabs.
        </p>
      )}
    </>
  );
}
