import type { DatabaseSync } from 'node:sqlite';
import type { Artifact, ArtifactKind, ArtifactRepo, ArtifactVersion } from '@grunt/core/ports/store.js';
import type { SyncClock } from './clock.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';

const ARTIFACT: CrudMapping<Artifact> = {
  table: 'artifact',
  columns: ['id', 'chat_id', 'slug', 'kind', 'language', 'created_at'],
  toRow: (a) => [a.id, a.chatId, a.slug, a.kind, a.language, a.createdAt],
  fromRow: (row) => ({
    id: row.id as string,
    chatId: row.chat_id as string,
    slug: row.slug as string,
    kind: row.kind as ArtifactKind,
    language: (row.language as string | null) ?? null,
    createdAt: row.created_at as number,
  }),
};

const VERSION: CrudMapping<ArtifactVersion> = {
  table: 'artifact_version',
  columns: ['id', 'artifact_id', 'number', 'title', 'content', 'made_by', 'message_id', 'parent_version_id', 'created_at'],
  toRow: (v) => [v.id, v.artifactId, v.number, v.title, v.content, v.madeBy, v.messageId, v.parentVersionId, v.createdAt],
  fromRow: (row) => ({
    id: row.id as string,
    artifactId: row.artifact_id as string,
    number: row.number as number,
    title: row.title as string,
    content: row.content as string,
    madeBy: row.made_by as 'model' | 'user',
    messageId: (row.message_id as string | null) ?? null,
    parentVersionId: (row.parent_version_id as string | null) ?? null,
    createdAt: row.created_at as number,
  }),
};

/** Artifacts and their versions (migration 016); both synced, so every write is stamped. */
export class SqliteArtifactRepo implements ArtifactRepo {
  private readonly artifacts: SqliteCrudRepo<Artifact>;
  private readonly versionRows: SqliteCrudRepo<ArtifactVersion>;

  constructor(private readonly db: DatabaseSync, clock: SyncClock) {
    this.artifacts = new SqliteCrudRepo(db, ARTIFACT, clock);
    this.versionRows = new SqliteCrudRepo(db, VERSION, clock);
  }

  create(a: Artifact): Artifact {
    return this.artifacts.create(a);
  }

  get(id: string): Artifact | null {
    return this.artifacts.get(id);
  }

  bySlug(chatId: string, slug: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifact WHERE chat_id = ? AND slug = ? ORDER BY created_at, id LIMIT 1').get(chatId, slug) as Record<string, unknown> | undefined;
    return row ? ARTIFACT.fromRow(row) : null;
  }

  listByChat(chatId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifact WHERE chat_id = ? ORDER BY created_at, id').all(chatId) as Record<string, unknown>[]).map(ARTIFACT.fromRow);
  }

  addVersion(v: Omit<ArtifactVersion, 'number'>): ArtifactVersion {
    const { n } = this.db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM artifact_version WHERE artifact_id = ?').get(v.artifactId) as { n: number };
    return this.versionRows.create({ ...v, number: n + 1 });
  }

  getVersion(id: string): ArtifactVersion | null {
    return this.versionRows.get(id);
  }

  versions(artifactId: string): ArtifactVersion[] {
    return (this.db.prepare('SELECT * FROM artifact_version WHERE artifact_id = ? ORDER BY number, created_at, id').all(artifactId) as Record<string, unknown>[]).map(VERSION.fromRow);
  }
}
