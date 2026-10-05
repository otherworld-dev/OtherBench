import type { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, AuditRepo } from '@grunt/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromJson, toJson } from './util.js';
import { selfIdOf } from './nodes.js';

const mapping: CrudMapping<AuditEntry> = {
  table: 'audit',
  columns: ['id', 'chat_id', 'message_id', 'tool_name', 'args_redacted', 'result_summary', 'duration_ms', 'granted_by', 'decided_on_node', 'created_at'],
  toRow: (a) => [
    a.id,
    a.chatId,
    a.messageId,
    a.toolName,
    toJson(a.argsRedacted),
    a.resultSummary,
    a.durationMs,
    a.grantedBy,
    a.decidedOnNode ?? null,
    a.createdAt,
  ],
  fromRow: (row) => ({
    id: row.id as string,
    chatId: row.chat_id as string,
    messageId: row.message_id as string,
    toolName: row.tool_name as string,
    argsRedacted: fromJson(row.args_redacted as string),
    resultSummary: row.result_summary as string,
    durationMs: row.duration_ms as number,
    grantedBy: row.granted_by as string,
    ...(row.decided_on_node ? { decidedOnNode: row.decided_on_node as string } : {}),
    createdAt: row.created_at as number,
  }),
};

export class SqliteAuditRepo implements AuditRepo {
  private readonly crud: SqliteCrudRepo<AuditEntry>;

  /** `selfId` is this machine's node id, the default `decidedOnNode`. */
  constructor(
    db: DatabaseSync,
    private readonly selfId: () => string = selfIdOf(db)
  ) {
    this.crud = new SqliteCrudRepo(db, mapping);
  }

  create(a: Omit<AuditEntry, 'createdAt'> & { createdAt?: number }): AuditEntry {
    const full: AuditEntry = { ...a, decidedOnNode: a.decidedOnNode ?? this.selfId(), createdAt: a.createdAt ?? Date.now() };
    return this.crud.create(full);
  }

  get(id: string): AuditEntry | null {
    return this.crud.get(id);
  }

  list(chatId: string): AuditEntry[] {
    return this.crud.listWhere('chat_id = ?', chatId);
  }

  update(id: string, patch: Partial<Omit<AuditEntry, 'id'>>): AuditEntry {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
