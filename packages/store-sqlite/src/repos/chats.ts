import type { DatabaseSync } from 'node:sqlite';
import type { Chat, ChatRepo, NewChat } from '@grunt/core/ports/store.js';
import { toStoredWorkspace } from '@grunt/core/domain/workspace.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromBool, toBool } from './util.js';
import { WORKSPACE_COLUMNS, workspaceFromRow, workspaceToRow } from './workspace-columns.js';
import { selfIdOf } from './nodes.js';

function chatMapping(selfId: () => string): CrudMapping<Chat> {
  return {
    table: 'chat',
    columns: [
      'id',
      'title',
      'profile_id',
      'head_message_id',
      ...WORKSPACE_COLUMNS,
      'runs_on',
      'pinned',
      'archived_at',
      'auto_mode',
      'project_id',
      'memory_cursor',
      'memory_excluded',
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
      c.runsOn,
      toBool(c.pinned),
      c.archivedAt,
      toBool(c.autoMode),
      c.projectId,
      c.memoryCursor,
      toBool(c.memoryExcluded),
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
      runsOn: (row.runs_on as string | null) ?? selfId(),
      pinned: fromBool(row.pinned as number),
      archivedAt: row.archived_at as number | null,
      autoMode: fromBool(row.auto_mode as number),
      projectId: row.project_id as string | null,
      memoryCursor: row.memory_cursor as string | null,
      memoryExcluded: fromBool(row.memory_excluded as number),
      sortOrder: row.sort_order as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }),
  };
}

export class SqliteChatRepo implements ChatRepo {
  private readonly crud: SqliteCrudRepo<Chat>;

  /** `selfId` is this machine's node id (`NodeRepo`), the default for `runsOn` and for a bare `workspaceRoot`. */
  constructor(
    db: DatabaseSync,
    private readonly selfId: () => string = selfIdOf(db)
  ) {
    this.crud = new SqliteCrudRepo(db, chatMapping(selfId));
  }

  create(c: NewChat): Chat {
    const now = Date.now();
    const fields = toStoredWorkspace(c, this.selfId());
    const full: Chat = {
      ...fields,
      workspace: fields.workspace ?? null,
      runsOn: c.runsOn ?? this.selfId(),
      autoMode: c.autoMode ?? false,
      projectId: c.projectId ?? null,
      memoryCursor: c.memoryCursor ?? null,
      memoryExcluded: c.memoryExcluded ?? false,
      sortOrder: c.sortOrder ?? c.createdAt ?? now,
      createdAt: c.createdAt ?? now,
      updatedAt: c.updatedAt ?? now,
    };
    return this.crud.create(full);
  }

  get(id: string): Chat | null {
    return this.crud.get(id);
  }

  list(): Chat[] {
    return this.crud.list();
  }

  /** A chat that changes project starts over in the new project's memory (ChatRepo.update's doc). */
  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat {
    const current = this.crud.get(id);
    const stored = toStoredWorkspace(patch, this.selfId()) as Partial<Omit<Chat, 'id'>>;
    const moved = current !== null && stored.projectId !== undefined && stored.projectId !== current.projectId;
    return this.crud.update(id, moved ? { ...stored, memoryCursor: null } : stored);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
