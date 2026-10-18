import type { NoteAttachment } from './messages.js';

export type NotePath = 'live' | 'wait';

/** A message the user sent while a reply was running (spec 2026-10-18-send-while-replying-design). */
export interface ReplyNote {
  id: string;
  chatId: string;
  text: string;
  attachments: NoteAttachment[];
  path: NotePath;
  /** live: the one reply it went into. wait: every reply running in the chat when it was sent. */
  replyIds: string[];
  /** What a turn made from it uses (wait path, and a live note's follow-on parent is the reply). */
  parentId: string | null;
  profileIds: string[];
  /** The browser tab that sent it: only that tab puts it back in the box. */
  clientId: string;
  sentAt: number;
}

export type NoteOutcome = 'folded' | 'turn' | 'returned' | 'removed';
