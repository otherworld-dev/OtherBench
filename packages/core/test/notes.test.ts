import { describe, expect, it } from 'vitest';
import { notePart, notesToParts } from '../src/domain/notes.js';
import type { ReplyNote } from '../src/types/notes.js';

function note(over: Partial<ReplyNote> & { id: string }): ReplyNote {
  return { chatId: 'c1', text: '', attachments: [], path: 'live', replyIds: ['r1'], parentId: null, profileIds: ['p1'], clientId: 'tab1', sentAt: 1, ...over };
}

describe('notesToParts', () => {
  it('joins texts in order and keeps attachments', () => {
    const parts = notesToParts([
      note({ id: 'n1', text: 'a', attachments: [{ attachmentId: 'att1', mime: 'image/png', filename: 'a.png' }] }),
      note({ id: 'n2', text: 'b', attachments: [{ attachmentId: 'att2', mime: 'text/csv', filename: 'x.csv' }] }),
    ]);
    expect(parts).toEqual([
      { type: 'text', text: 'a\n\nb' },
      { type: 'image', attachmentId: 'att1', mime: 'image/png' },
      { type: 'file', attachmentId: 'att2', mime: 'text/csv', filename: 'x.csv' },
    ]);
  });

  it('leaves out the text part when every note is attachment-only', () => {
    const parts = notesToParts([note({ id: 'n1', text: '', attachments: [{ attachmentId: 'att1', mime: 'image/png', filename: 'a.png' }] })]);
    expect(parts).toEqual([{ type: 'image', attachmentId: 'att1', mime: 'image/png' }]);
  });
});

describe('notePart', () => {
  it('copies id, text and attachments', () => {
    const attachments = [{ attachmentId: 'att1', mime: 'image/png', filename: 'a.png' }];
    expect(notePart(note({ id: 'n1', text: 'stop', attachments }))).toEqual({ type: 'user-note', noteId: 'n1', text: 'stop', attachments });
  });
});
