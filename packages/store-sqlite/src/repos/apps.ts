import type { DatabaseSync } from 'node:sqlite';
import type { App, AppRepo, NewApp } from '@otherbench/core/ports/store.js';
import { toStoredWorkspace } from '@otherbench/core/domain/workspace.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { WORKSPACE_COLUMNS, workspaceFromRow, workspaceToRow } from './workspace-columns.js';
import { SqliteChatRepo } from './chats.js';
import { selfIdOf } from './nodes.js';
import { clockOf, type SyncClock } from './clock.js';

function appMapping(selfId: () => string): CrudMapping<App> {
  return {
    table: 'app',
    columns: ['id', 'name', ...WORKSPACE_COLUMNS, 'github_repo', 'linked_project_id', 'default_profile_id', 'deck_board_id', 'wiki_collective', 'wiki_page_path', 'bookmark_tag', 'sort_order', 'created_at', 'updated_at'],
    toRow: (a) => [a.id, a.name, ...workspaceToRow(a.workspace), a.githubRepo, a.linkedProjectId, a.defaultProfileId, a.deckBoardId, a.wikiCollective, a.wikiPagePath, a.bookmarkTag, a.sortOrder, a.createdAt, a.updatedAt],
    fromRow: (row) => ({
      id: row.id as string,
      name: row.name as string,
      workspace: workspaceFromRow(row, selfId),
      githubRepo: (row.github_repo as string | null) ?? null,
      linkedProjectId: (row.linked_project_id as string | null) ?? null,
      defaultProfileId: (row.default_profile_id as string | null) ?? null,
      deckBoardId: (row.deck_board_id as number | null) ?? null,
      wikiCollective: (row.wiki_collective as string | null) ?? null,
      wikiPagePath: (row.wiki_page_path as string | null) ?? null,
      bookmarkTag: (row.bookmark_tag as string | null) ?? null,
      sortOrder: row.sort_order as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }),
  };
}

/** Apps for the Code tab (spec 2026-10-20-code-tab-design, "Data"); a synced table (migration 029), modelled on `SqliteProjectRepo`. */
export class SqliteAppRepo implements AppRepo {
  private readonly crud: SqliteCrudRepo<App>;
  private readonly mapping: CrudMapping<App>;
  private readonly chats: SqliteChatRepo;

  constructor(
    private readonly db: DatabaseSync,
    private readonly selfId: () => string = selfIdOf(db),
    clock: SyncClock = clockOf(db, selfId)
  ) {
    this.mapping = appMapping(selfId);
    this.crud = new SqliteCrudRepo(db, this.mapping, clock);
    this.chats = new SqliteChatRepo(db, selfId, clock);
  }

  create(a: NewApp): App {
    const now = Date.now();
    const fields = toStoredWorkspace(a, this.selfId());
    return this.crud.create({
      ...fields,
      workspace: fields.workspace ?? null,
      githubRepo: a.githubRepo ?? null,
      linkedProjectId: a.linkedProjectId ?? null,
      defaultProfileId: a.defaultProfileId ?? null,
      deckBoardId: a.deckBoardId ?? null,
      wikiCollective: a.wikiCollective ?? null,
      wikiPagePath: a.wikiPagePath ?? null,
      bookmarkTag: a.bookmarkTag ?? null,
      sortOrder: a.sortOrder ?? 0,
      createdAt: a.createdAt ?? now,
      updatedAt: a.updatedAt ?? now,
    });
  }

  get(id: string): App | null {
    return this.crud.get(id);
  }

  /** Same order as `compareApps` (@otherbench/core/domain/apps.js). */
  list(): App[] {
    const rows = this.db.prepare('SELECT * FROM app ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapping.fromRow(r));
  }

  update(id: string, patch: Partial<Omit<App, 'id'>>): App {
    return this.crud.update(id, toStoredWorkspace(patch, this.selfId()) as Partial<Omit<App, 'id'>>);
  }

  /**
   * Its chats keep existing. `chat.app_id` has no foreign key (migration 029),
   * so it is cleared here through the chat repo's `update`, which stamps the
   * field and logs the change: other machines would otherwise only see the
   * app's deletion and keep chats pointing at it.
   */
  delete(id: string): void {
    const chats = this.db.prepare('SELECT id FROM chat WHERE app_id = ?').all(id) as { id: string }[];
    for (const chat of chats) this.chats.update(chat.id, { appId: null });
    this.crud.delete(id);
  }
}
