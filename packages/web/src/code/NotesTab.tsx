import type { JSX } from 'react';
import { hasAppNotesContent, validateAppNotes, type AppNotesMirror } from '@otherbench/core/domain/app-notes.js';
import type { App } from '@otherbench/core/ports/store.js';
import { MemoryNote } from '../components/MemoryNote.js';
import { openInBrowser } from '../desktop/bridge.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { api } from '../state/api.js';
import { useAppNotes, useAppNotesStore } from '../state/appNotes.js';
import { useOtherBenchStore } from '../state/store.js';

/** One line on where the Collectives copy stands; null when there's nothing to say. */
export function mirrorLine(mirror: AppNotesMirror): { text: string; failed: boolean; url?: string } | null {
  switch (mirror.state) {
    case 'off':
      return { text: 'Not copied to Collectives: Nextcloud is turned off (Settings → Features).', failed: false };
    case 'not-configured':
      return { text: "Not copied to Collectives: Nextcloud isn't set up on this machine.", failed: false };
    case 'no-page':
      return { text: "Not copied to Collectives: set this app's wiki page in its settings to copy them there.", failed: false };
    case 'nothing':
      return null;
    case 'pending':
      return { text: 'Copying to Collectives…', failed: false };
    case 'mirrored':
      return mirror.url ? { text: 'Copied to Collectives.', failed: false, url: mirror.url } : { text: 'Copied to Collectives.', failed: false };
    case 'failed':
      return { text: `Couldn't copy to Collectives ${formatRelativeTime(mirror.at)} (tried again every 10 minutes): ${mirror.error}`, failed: true };
  }
}

/**
 * The Code panel's Notes tab (spec 2026-11-05-app-notes-design): the app's
 * standing facts, who last changed them, Edit (the whole page) and History,
 * and where their Collectives copy stands. Facts are also added from a chat
 * with `#`, or by saving a model's offer.
 */
export function NotesTab({ app }: { app: App }): JSX.Element {
  const { view, loadFailed } = useAppNotes(app.id, true);
  const setView = useAppNotesStore((s) => s.setView);
  const chats = useOtherBenchStore((s) => s.chats);

  if (!view) {
    return <p className="text-sm text-[var(--text-faint)]">{loadFailed ? "Couldn't load the notes." : 'Loading…'}</p>;
  }

  const { notes, mirror } = view;
  const from = notes.sourceChatId ? chats.find((c) => c.id === notes.sourceChatId)?.title : null;
  const updatedLine = notes.updatedAt === 0 ? 'Not saved yet.' : `Updated ${formatRelativeTime(notes.updatedAt)}${from ? ` from “${from}”` : ''}.`;
  const copy = mirrorLine(mirror);

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)]">
        Facts every chat on {app.name} starts with. Type <code>#</code> and a fact in a chat to add one.
      </p>
      <MemoryNote
        key={app.id}
        testIdPrefix="app-notes"
        label="App notes"
        emptyText="No notes yet."
        body={notes.body}
        updatedLine={updatedLine}
        validate={validateAppNotes}
        hasContent={hasAppNotesContent}
        save={async (draft) => setView(app.id, await api.appNotes.save(app.id, draft))}
        loadVersions={async () => (await api.appNotes.versions(app.id)).map((v) => ({ ...v, createdBy: 'user' as const }))}
        loadVersion={(id) => api.appNotes.version(app.id, id)}
        restore={async (id) => setView(app.id, await api.appNotes.restore(app.id, id))}
        versionAuthor={(v) => (v.sourceChatId ? (chats.find((c) => c.id === v.sourceChatId)?.title ?? 'a chat') : 'You')}
      >
        {copy && (
          <p data-testid="app-notes-mirror" className={`text-xs ${copy.failed ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
            {copy.text}
            {copy.url && (
              <>
                {' '}
                <button type="button" onClick={() => openInBrowser(copy.url!)} className="underline hover:text-[var(--text)]">
                  Open
                </button>
              </>
            )}
          </p>
        )}
      </MemoryNote>
    </div>
  );
}
