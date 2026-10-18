import type { JSX } from 'react';
import type { NoteAttachment, UserNotePart } from '@otherbench/core/types/messages.js';
import { api } from '../state/api.js';
import { AttachmentChip } from './AttachmentChip.js';

/** A note's attachments as read-only chips: in a reply, or waiting above the box. */
export function NoteAttachmentChips({ attachments }: { attachments: NoteAttachment[] }): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <AttachmentChip
          key={a.attachmentId}
          filename={a.filename}
          mime={a.mime}
          previewUrl={api.attachments.previewable(a.mime) ? api.attachments.contentUrl(a.attachmentId) : undefined}
        />
      ))}
    </div>
  );
}

/**
 * A message the user sent while the reply was running, where Claude read it
 * (spec 2026-10-18-send-while-replying-design): the user's words inside the
 * reply, with the reply's output carrying on below.
 */
export function UserNoteBlock({ part }: { part: UserNotePart }): JSX.Element {
  return (
    <div data-testid="user-note" className="my-2 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2">
      <div className="label-caps text-xs text-[var(--text-muted)]">You, while Claude was working</div>
      {part.text.length > 0 && <div className="mt-1 text-sm whitespace-pre-wrap">{part.text}</div>}
      <NoteAttachmentChips attachments={part.attachments} />
    </div>
  );
}
