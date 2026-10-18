import type { Part, UserNotePart } from '../types/messages.js';
import type { ReplyNote } from '../types/notes.js';

/** Notes as the parts of one user message: their texts joined in order (left out when all are empty), then each attachment. */
export function notesToParts(notes: ReplyNote[]): Part[] {
  const parts: Part[] = [];
  const text = notes.map((n) => n.text).filter((t) => t.length > 0).join('\n\n');
  if (text.length > 0) parts.push({ type: 'text', text });
  for (const note of notes) {
    for (const a of note.attachments) {
      parts.push(a.mime.startsWith('image/') ? { type: 'image', attachmentId: a.attachmentId, mime: a.mime } : { type: 'file', attachmentId: a.attachmentId, mime: a.mime, filename: a.filename });
    }
  }
  return parts;
}

/** The part a reply keeps for a note Claude read while it was working. */
export function notePart(note: ReplyNote): UserNotePart {
  return { type: 'user-note', noteId: note.id, text: note.text, attachments: note.attachments };
}
