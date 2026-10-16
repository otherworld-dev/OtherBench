import type { DatabaseSync } from 'node:sqlite';
import type { Chat, ChatRepo, NewChat } from '@otherbench/core/ports/store.js';
import { toStoredWorkspace } from '@otherbench/core/domain/workspace.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromBool, toBool } from './util.js';
import { WORKSPACE_COLUMNS, foldersFromRow, foldersToRow, workspaceFromRow, workspaceToRow } from './workspace-columns.js';
import { selfIdOf } from './nodes.js';
import { clockOf, type SyncClock } from './clock.js';
import { CHAT_FIELDS } from '@otherbench/core/domain/sync.js';
import { isClaudeEffort } from '@otherbench/core/types/config.js';

function chatMapping(selfId: () => string): CrudMapping<Chat> {
  return {
    table: 'chat',
    columns: [
      'id',
      'title',
      'profile_id',
      'head_message_id',
      ...WORKSPACE_COLUMNS,
      'folders',
      'runs_on',
      'pinned',
      'project_pinned',
      'unread',
      'archived_at',
      'auto_mode',
      'plan_mode',
      'effort',
      'project_id',
      'memory_cursor',
      'memory_excluded',
      'global_memory_cursor',
      'sort_order',
      'created_at',
      'updated_at',
    ],
    toRow: (c) => [
      c.id,
      c.title,
      c.profileId,
      c.headMessageId,
      ...workspaceToRow(c.workspace),
      foldersToRow(c.folders),
      c.runsOn,
      toBool(c.pinned),
      toBool(c.projectPinned),
      toBool(c.unread),
      c.archivedAt,
      toBool(c.autoMode),
      toBool(c.planMode ?? false),
      c.effort ?? null,
      c.projectId,
      c.memoryCursor,
      toBool(c.memoryExcluded),
      c.globalMemoryCursor ?? null,
      c.sortOrder,
      c.createdAt,
      c.updatedAt,
    ],
    fromRow: (row) => ({
      id: row.id as string,
      title: row.title as string,
      profileId: row.profile_id as string,
      headMessageId: row.head_message_id as string | null,
      workspace: workspaceFromRow(row, selfId),
      ...foldersFromRow(row),
      runsOn: (row.runs_on as string | null) ?? selfId(),
      pinned: fromBool(row.pinned as number),
      projectPinned: fromBool(row.project_pinned as number),
      unread: fromBool(row.unread as number),
      archivedAt: row.archived_at as number | null,
      autoMode: fromBool(row.auto_mode as number),
      planMode: fromBool(row.plan_mode as number),
      // Unset, or a level this version doesn't know, follows Claude Code's own settings.
      ...(isClaudeEffort(row.effort) ? { effort: row.effort } : {}),
      projectId: row.project_id as string | null,
      memoryCursor: row.memory_cursor as string | null,
      memoryExcluded: fromBool(row.memory_excluded as number),
      globalMemoryCursor: row.global_memory_cursor as string | null,
      sortOrder: row.sort_order as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }),
  };
}

export class SqliteChatRepo implements ChatRepo {
  private readonly crud: SqliteCrudRepo<Chat>;

  /** `selfId` is this machine's node id (`NodeRepo`), the default for `runsOn` and for a bare `workspaceRoot`. */
  /** A synced table: `clock` stamps the row and each field it changes (migration 013). */
  constructor(
    private readonly db: DatabaseSync,
    private readonly selfId: () => string = selfIdOf(db),
    private readonly clock: SyncClock = clockOf(db, selfId)
  ) {
    this.crud = new SqliteCrudRepo(db, chatMapping(selfId), clock);
  }

  create(c: NewChat): Chat {
    const now = Date.now();
    const fields = toStoredWorkspace(c, this.selfId());
    const full: Chat = {
      ...fields,
      workspace: fields.workspace ?? null,
      runsOn: c.runsOn ?? this.selfId(),
      autoMode: c.autoMode ?? false,
      planMode: c.planMode ?? false,
      projectId: c.projectId ?? null,
      memoryCursor: c.memoryCursor ?? null,
      memoryExcluded: c.memoryExcluded ?? false,
      projectPinned: c.projectPinned ?? false,
      unread: c.unread ?? false,
      globalMemoryCursor: c.globalMemoryCursor ?? null,
      sortOrder: c.sortOrder ?? c.createdAt ?? now,
      createdAt: c.createdAt ?? now,
      updatedAt: c.updatedAt ?? now,
    };
    // Every field starts stamped with the chat's creation, so a field's
    // stamp never depends on later changes to other fields.
    const stamp = this.clock.stamp();
    const created = this.crud.create(full, stamp);
    this.writeFieldStamps(c.id, Object.fromEntries(Object.keys(CHAT_FIELDS).map((f) => [f, stamp])));
    return created;
  }

  private writeFieldStamps(id: string, fieldHlc: Record<string, string>): void {
    this.db.prepare('UPDATE chat SET field_hlc = ? WHERE id = ?').run(JSON.stringify(fieldHlc), id);
  }

  get(id: string): Chat | null {
    return this.crud.get(id);
  }

  list(): Chat[] {
    return this.crud.list();
  }

  /** A chat that changes project starts over in the new project's memory, and loses its project pin unless the patch sets it (ChatRepo.update's doc). */
  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat {
    const current = this.crud.get(id);
    const stored = toStoredWorkspace(patch, this.selfId()) as Partial<Omit<Chat, 'id'>>;
    const moved = current !== null && stored.projectId !== undefined && stored.projectId !== current.projectId;
    const next = moved ? { ...stored, memoryCursor: null, projectPinned: stored.projectPinned ?? false } : stored;
    const previous = this.db.prepare('SELECT hlc, field_hlc FROM chat WHERE id = ?').get(id) as { hlc: string; field_hlc: string } | undefined;
    const stamp = this.clock.stamp();
    const updated = this.crud.update(id, next, stamp);
    // Each field the patch sets is stamped on its own, so another machine's
    // change to a different field of this chat isn't lost when they merge.
    const fields = Object.keys(next).filter((k) => k in CHAT_FIELDS);
    if (fields.length > 0 && previous) {
      const fieldHlc = JSON.parse(previous.field_hlc || '{}') as Record<string, string>;
      // A field never stamped on its own keeps the stamp the row had until now.
      for (const f of Object.keys(CHAT_FIELDS)) fieldHlc[f] ??= previous.hlc;
      for (const f of fields) fieldHlc[f] = stamp;
      this.writeFieldStamps(id, fieldHlc);
    }
    return updated;
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
