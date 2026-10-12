import type { DatabaseSync } from 'node:sqlite';
import type { Artifact, ArtifactKind, ArtifactRepo, ArtifactVersion, ArtifactVersionInfo, LiveSpec, NewArtifactVersion } from '@grunt/core/ports/store.js';
import { parseLiveSpec } from '@grunt/core/domain/live-artifacts.js';
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

/** A stored declaration, or null for none (or for text that no longer parses: the page is then shown plain). */
function storedLive(value: unknown): LiveSpec | null {
  if (typeof value !== 'string') return null;
  const parsed = parseLiveSpec(value);
  return parsed.ok ? parsed.spec : null;
}

const VERSION: CrudMapping<ArtifactVersion> = {
  table: 'artifact_version',
  columns: ['id', 'artifact_id', 'number', 'title', 'content', 'kind', 'language', 'made_by', 'message_id', 'parent_version_id', 'created_at', 'live'],
  toRow: (v) => [v.id, v.artifactId, v.number, v.title, v.content, v.kind, v.language, v.madeBy, v.messageId, v.parentVersionId, v.createdAt, v.live === null ? null : JSON.stringify(v.live)],
  fromRow: (row) => ({
    id: row.id as string,
    artifactId: row.artifact_id as string,
    number: row.number as number,
    title: row.title as string,
    content: row.content as string,
    kind: row.kind as ArtifactKind,
    language: (row.language as string | null) ?? null,
    madeBy: row.made_by as 'model' | 'user',
    messageId: (row.message_id as string | null) ?? null,
    parentVersionId: (row.parent_version_id as string | null) ?? null,
    createdAt: row.created_at as number,
    live: storedLive(row.live),
  }),
};

/** Artifacts and their versions (migrations 016, 017, 024); both synced, so every write is stamped. */
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

  addVersion(v: NewArtifactVersion): ArtifactVersion {
    const artifact = this.get(v.artifactId);
    if (!artifact) throw new Error(`Artifact "${v.artifactId}" not found.`);
    const { n } = this.db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM artifact_version WHERE artifact_id = ?').get(v.artifactId) as { n: number };
    return this.versionRows.create({ ...v, kind: v.kind ?? artifact.kind, language: v.language !== undefined ? v.language : artifact.language, live: v.live ?? null, number: n + 1 });
  }

  getVersion(id: string): ArtifactVersion | null {
    return this.versionRows.get(id);
  }

  versionInfos(artifactId: string): ArtifactVersionInfo[] {
    const rows = this.db
      .prepare("SELECT id, artifact_id, number, title, '' AS content, kind, language, made_by, message_id, parent_version_id, created_at, live FROM artifact_version WHERE artifact_id = ? ORDER BY number, created_at, id")
      .all(artifactId) as Record<string, unknown>[];
    return rows.map((row) => {
      const { content: _content, ...info } = VERSION.fromRow(row);
      return info;
    });
  }

  versions(artifactId: string): ArtifactVersion[] {
    return (this.db.prepare('SELECT * FROM artifact_version WHERE artifact_id = ? ORDER BY number, created_at, id').all(artifactId) as Record<string, unknown>[]).map(VERSION.fromRow);
  }
}
