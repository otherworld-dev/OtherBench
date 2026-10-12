import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

function store(): SqliteStore {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const s = new SqliteStore(db);
  s.connections.create({ id: 'conn', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  s.profiles.create({ id: 'p', name: 'P', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null });
  s.chats.create({ id: 'c1', title: 'C', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  return s;
}

describe('SqliteArtifactRepo', () => {
  it('stores artifacts and numbers their versions, finds by short id, and lists oldest first', () => {
    const s = store();
    s.artifacts.create({ id: 'a1', chatId: 'c1', slug: 'calc', kind: 'html', language: null, createdAt: 1 });
    s.artifacts.create({ id: 'a2', chatId: 'c1', slug: 'lib', kind: 'code', language: 'py', createdAt: 2 });
    const v1 = s.artifacts.addVersion({ id: 'v1', artifactId: 'a1', title: 'Calc', content: '<p>1</p>', madeBy: 'model', messageId: 'm-not-here', parentVersionId: null, createdAt: 3 });
    const v2 = s.artifacts.addVersion({ id: 'v2', artifactId: 'a1', title: 'Calc', content: '<p>2</p>', madeBy: 'user', messageId: null, parentVersionId: 'v1', createdAt: 4 });
    expect([v1.number, v2.number]).toEqual([1, 2]);
    expect(s.artifacts.bySlug('c1', 'lib')).toEqual({ id: 'a2', chatId: 'c1', slug: 'lib', kind: 'code', language: 'py', createdAt: 2 });
    expect(s.artifacts.bySlug('c1', 'nope')).toBeNull();
    expect(s.artifacts.listByChat('c1').map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(s.artifacts.versions('a1').map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(s.artifacts.getVersion('v2')).toEqual({ ...v2 });
  });

  it("keeps each version's own kind and language, the artifact's unless given", () => {
    const s = store();
    s.artifacts.create({ id: 'a1', chatId: 'c1', slug: 'bear', kind: 'markdown', language: null, createdAt: 1 });
    const v1 = s.artifacts.addVersion({ id: 'v1', artifactId: 'a1', title: 'Bear', content: '# Bear', madeBy: 'model', messageId: null, parentVersionId: null, createdAt: 2 });
    const v2 = s.artifacts.addVersion({ id: 'v2', artifactId: 'a1', title: 'Bear', content: 'print(1)', kind: 'code', language: 'py', madeBy: 'model', messageId: null, parentVersionId: 'v1', createdAt: 3 });
    expect([v1.kind, v1.language, v2.kind, v2.language]).toEqual(['markdown', null, 'code', 'py']);
    expect(s.artifacts.versions('a1').map((v) => `${v.kind}:${v.language}`)).toEqual(['markdown:null', 'code:py']);
  });

  it('goes with its chat, and logs every change for sync', () => {
    const s = store();
    s.artifacts.create({ id: 'a1', chatId: 'c1', slug: 'calc', kind: 'html', language: null, createdAt: 1 });
    s.artifacts.addVersion({ id: 'v1', artifactId: 'a1', title: 'Calc', content: 'x', madeBy: 'model', messageId: null, parentVersionId: null, createdAt: 2 });
    const logged = (s as unknown as { db: { prepare(sql: string): { all(): { tbl: string; row_id: string; op: string }[] } } }).db
      .prepare("SELECT tbl, row_id, op FROM change_log WHERE tbl LIKE 'artifact%' ORDER BY seq")
      .all();
    expect(logged.map((r) => `${r.tbl}:${r.row_id}:${r.op}`)).toEqual(['artifact:a1:upsert', 'artifact_version:v1:upsert']);
    s.chats.delete('c1');
    expect(s.artifacts.get('a1')).toBeNull();
    expect(s.artifacts.getVersion('v1')).toBeNull();
  });

  it("keeps a version's live declaration, null when it has none, in every read", () => {
    const s = store();
    s.artifacts.create({ id: 'a1', chatId: 'c1', slug: 'dash', kind: 'html', language: null, createdAt: 1 });
    const live = { calls: [{ id: 'value', tool: 'mcp__s__lookup', args: { key: { $param: 'key' } }, params: { key: { enum: ['a', 'b'], default: 'a' } } }] };
    const v1 = s.artifacts.addVersion({ id: 'v1', artifactId: 'a1', title: 'Dash', content: '<p></p>', madeBy: 'model', messageId: null, parentVersionId: null, createdAt: 2, live });
    const v2 = s.artifacts.addVersion({ id: 'v2', artifactId: 'a1', title: 'Dash', content: '<p></p>', madeBy: 'model', messageId: null, parentVersionId: 'v1', createdAt: 3 });
    expect(v1.live).toEqual(live);
    expect(v2.live).toBeNull();
    expect(s.artifacts.getVersion('v1')!.live).toEqual(live);
    expect(s.artifacts.versions('a1').map((v) => v.live)).toEqual([live, null]);
    expect(s.artifacts.versionInfos('a1').map((v) => v.live)).toEqual([live, null]);
  });

  it('adds artifact_version.live as a nullable column', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(artifact_version)').all() as { name: string; notnull: number; dflt_value: unknown }[];
    expect(cols.find((c) => c.name === 'live')).toMatchObject({ notnull: 0, dflt_value: null });
  });
});
