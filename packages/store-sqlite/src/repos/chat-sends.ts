import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ChatSendStatus } from '@otherbench/core/domain/chat-sends.js';
import type { ChatSend, ChatSendPatch, ChatSendRepo, NewChatSend } from '@otherbench/core/ports/store.js';

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
    toNode: (row.to_node as string | null) ?? null,
    fromNode: (row.from_node as string | null) ?? null,
    toAppId: (row.to_app_id as string | null) ?? null,
    fromTitle: (row.from_title as string | null) ?? null,
    handedAt: (row.handed_at as number | null) ?? null,
    reportedAt: (row.reported_at as number | null) ?? null,
    stopPending: (row.stop_pending as string | null) ?? null,
    heldReason: (row.held_reason as string | null) ?? null,
    heldSeen: row.held_seen === 1,
    chainBase: (row.chain_base as number | null) ?? 0,
  };
}

const COLUMNS: Record<keyof ChatSendPatch, string> = {
  status: 'status',
  toReplyId: 'to_reply_id',
  replyText: 'reply_text',
  reason: 'reason',
  resumedAs: 'resumed_as',
  finishedAt: 'finished_at',
  toChatId: 'to_chat_id',
  toNode: 'to_node',
  handedAt: 'handed_at',
  reportedAt: 'reported_at',
  stopPending: 'stop_pending',
  heldReason: 'held_reason',
  heldSeen: 'held_seen',
};

/** Chat-to-chat sends (migration 044). Local: the table has no sync triggers. */
export class SqliteChatSendRepo implements ChatSendRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(s: NewChatSend): ChatSend {
    const createdAt = s.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO chat_send (id, chain_id, depth, from_chat_id, from_message_id, to_chat_id, created_chat, text, status, to_reply_id, reply_text, reason, resumed_as, created_at, finished_at,
           to_node, from_node, to_app_id, from_title, handed_at, reported_at, stop_pending, held_reason, held_seen, chain_base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.id, s.chainId, s.depth, s.fromChatId, s.fromMessageId, s.toChatId, s.createdChat ? 1 : 0, s.text, s.status, s.toReplyId, s.replyText, s.reason, s.resumedAs, createdAt,
        s.toNode ?? null, s.fromNode ?? null, s.toAppId ?? null, s.fromTitle ?? null, s.handedAt ?? null, s.reportedAt ?? null, s.stopPending ?? null, s.heldReason ?? null,
        s.heldSeen === true ? 1 : 0, s.chainBase ?? 0
      );
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
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
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

  remoteWork(): ChatSend[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_send
         WHERE (to_node IS NOT NULL AND status = 'queued')
            OR stop_pending IS NOT NULL
            OR (from_node IS NOT NULL AND status NOT IN ('queued', 'running') AND reported_at IS NULL)
         ORDER BY created_at ASC, rowid ASC`
      )
      .all() as Record<string, unknown>[];
    return rows.map(toSend);
  }

  unsettled(): ChatSend[] {
    const rows = this.db.prepare("SELECT * FROM chat_send WHERE status IN ('queued', 'running') ORDER BY created_at ASC, rowid ASC").all() as Record<string, unknown>[];
    return rows.map(toSend);
  }
}
