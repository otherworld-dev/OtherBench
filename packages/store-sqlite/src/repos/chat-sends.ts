import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ChatSendStatus } from '@otherbench/core/domain/chat-sends.js';
import type { ChatSend, ChatSendPatch, ChatSendRepo } from '@otherbench/core/ports/store.js';

function toSend(row: Record<string, unknown>): ChatSend {
  return {
    id: row.id as string,
    chainId: row.chain_id as string,
    depth: row.depth as number,
    fromChatId: row.from_chat_id as string,
    fromMessageId: row.from_message_id as string,
    toChatId: row.to_chat_id as string,
    createdChat: row.created_chat === 1,
    text: row.text as string,
    status: row.status as ChatSendStatus,
    toReplyId: (row.to_reply_id as string | null) ?? null,
    replyText: (row.reply_text as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    resumedAs: (row.resumed_as as string | null) ?? null,
    createdAt: row.created_at as number,
    finishedAt: (row.finished_at as number | null) ?? null,
  };
}

const COLUMNS: Record<keyof ChatSendPatch, string> = {
  status: 'status',
  toReplyId: 'to_reply_id',
  replyText: 'reply_text',
  reason: 'reason',
  resumedAs: 'resumed_as',
  finishedAt: 'finished_at',
};

/** Chat-to-chat sends (migration 043). Local: the table has no sync triggers. */
export class SqliteChatSendRepo implements ChatSendRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(s: Omit<ChatSend, 'createdAt' | 'finishedAt'> & { createdAt?: number }): ChatSend {
    const createdAt = s.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO chat_send (id, chain_id, depth, from_chat_id, from_message_id, to_chat_id, created_chat, text, status, to_reply_id, reply_text, reason, resumed_as, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(s.id, s.chainId, s.depth, s.fromChatId, s.fromMessageId, s.toChatId, s.createdChat ? 1 : 0, s.text, s.status, s.toReplyId, s.replyText, s.reason, s.resumedAs, createdAt);
    return this.get(s.id)!;
  }

  get(id: string): ChatSend | null {
    const row = this.db.prepare('SELECT * FROM chat_send WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toSend(row) : null;
  }

  update(id: string, patch: ChatSendPatch): ChatSend {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, column] of Object.entries(COLUMNS) as [keyof ChatSendPatch, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length > 0) this.db.prepare(`UPDATE chat_send SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    const row = this.get(id);
    if (!row) throw new Error(`No chat send ${id}.`);
    return row;
  }

  private where(column: string, value: string): ChatSend[] {
    const rows = this.db.prepare(`SELECT * FROM chat_send WHERE ${column} = ? ORDER BY created_at ASC, rowid ASC`).all(value) as Record<string, unknown>[];
    return rows.map(toSend);
  }

  byFromMessage(messageId: string): ChatSend[] {
    return this.where('from_message_id', messageId);
  }

  byToReply(replyId: string): ChatSend[] {
    return this.where('to_reply_id', replyId);
  }

  byResumedAs(replyId: string): ChatSend[] {
    return this.where('resumed_as', replyId);
  }

  byChain(chainId: string): ChatSend[] {
    return this.where('chain_id', chainId);
  }

  byFromChat(chatId: string): ChatSend[] {
    return this.where('from_chat_id', chatId);
  }

  byToChat(chatId: string): ChatSend[] {
    return this.where('to_chat_id', chatId);
  }

  unresumed(): ChatSend[] {
    const rows = this.db.prepare("SELECT * FROM chat_send WHERE resumed_as IS NULL AND status NOT IN ('queued', 'running') ORDER BY created_at ASC, rowid ASC").all() as Record<string, unknown>[];
    return rows.map(toSend);
  }

  unsettled(): ChatSend[] {
    const rows = this.db.prepare("SELECT * FROM chat_send WHERE status IN ('queued', 'running') ORDER BY created_at ASC, rowid ASC").all() as Record<string, unknown>[];
    return rows.map(toSend);
  }
}
