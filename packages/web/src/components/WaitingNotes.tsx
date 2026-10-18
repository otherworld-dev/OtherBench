import { useState, type JSX } from 'react';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { NoteAttachmentChips } from './UserNoteBlock.js';

const EMPTY: never[] = [];

/** What a waiting note is waiting for, by the path it took. */
const WAITING_COPY: Record<ReplyNote['path'], string> = {
  live: 'Waiting for Claude to finish its current step',
  wait: 'Sends when the reply finishes',
};

/**
 * The chat's messages sent while a reply runs that haven't gone out yet
 * (spec 2026-10-18-send-while-replying-design), at the end of the thread in
 * send order: each styled as the user's message, faded, with what it waits
 * for and a Take back that returns it to this tab's box. Hidden with none.
 */
export function WaitingNotes({ chatId }: { chatId: string }): JSX.Element | null {
  const notes = useOtherBenchStore((s) => s.chatNotes[chatId] ?? EMPTY);
  if (notes.length === 0) return null;
  return (
    <div data-testid="waiting-notes" className="space-y-2">
      {notes.map((note) => (
        <WaitingNote key={note.id} note={note} />
      ))}
    </div>
  );
}

function WaitingNote({ note }: { note: ReplyNote }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function takeBack(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const taken = await api.notes.withdraw(note.chatId, note.id);
      // Null: Claude had already read it, so it stays where it is and goes on.
      if (taken) useOtherBenchStore.getState().noteTakenBack(taken);
    } catch (err) {
      console.error(`[otherbench-web] failed to take back note ${note.id}:`, err);
      setError("Couldn't take it back. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article data-testid="waiting-note" className="flex items-start gap-2 rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
      <div className="min-w-0 flex-1 opacity-60">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="label-caps">You</span>
          <span>{WAITING_COPY[note.path]}</span>
        </div>
        {note.text.length > 0 && <div className="mt-1 text-sm whitespace-pre-wrap">{note.text}</div>}
        <NoteAttachmentChips attachments={note.attachments} />
      </div>
      {error && (
        <span role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </span>
      )}
      <button
        type="button"
        aria-label="Take back"
        title="Take back"
        disabled={busy}
        onClick={() => void takeBack()}
        className="shrink-0 rounded px-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] disabled:opacity-40"
      >
        ×
      </button>
    </article>
  );
}
