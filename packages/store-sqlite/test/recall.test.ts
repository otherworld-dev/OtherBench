import { describe, expect, it } from 'vitest';
import { runRecallCommand } from '@otherbench/core/domain/recall.js';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// Recall over the real full-text index (spec 2026-10-09-recall-design): every
// word must be in one message, and the asking chat can fill whole pages of hits.

function store(): SqliteStore {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const s = new SqliteStore(db);
  s.connections.create({ id: 'conn', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  s.profiles.create({ id: 'p', name: 'P', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null });
  return s;
}

/** A chat whose messages form one line, head on the last. */
function chat(s: SqliteStore, id: string, texts: string[], over: { memoryExcluded?: boolean } = {}): void {
  s.chats.create({ id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, memoryExcluded: over.memoryExcluded ?? false });
  let parent: string | null = null;
  texts.forEach((text, i) => {
    const mid = `${id}-${i}`;
    s.messages.create({ id: mid, chatId: id, parentId: parent, role: i % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null, createdAt: Date.UTC(2026, 9, 1) + i });
    parent = mid;
  });
  if (parent !== null) s.chats.update(id, { headMessageId: parent });
}

describe('recall over SQLite', () => {
  it('finds a chat by several words in one message in any order, but not words split across messages', () => {
    const s = store();
    chat(s, 'asking', ['What host did we use?']);
    chat(s, 'together', ['The staging box runs on Hetzner.']);
    chat(s, 'apart', ['Staging is fine.', 'Hetzner was cheaper.']);
    const outcome = runRecallCommand(s, { chatId: 'asking' }, { command: 'search', query: 'hetzner staging' }) as { chats: { chatId: string }[] };
    expect(outcome.chats.map((c) => c.chatId)).toEqual(['together']);
  });

  it("looks past pages of hits from the asking chat, and from excluded chats, to the ones it may show", () => {
    const s = store();
    chat(s, 'asking', Array.from({ length: 160 }, (_, i) => `quokka ${i}`));
    chat(s, 'private', Array.from({ length: 60 }, (_, i) => `quokka secret ${i}`), { memoryExcluded: true });
    chat(s, 'found', ['A quokka, once.']);
    const outcome = runRecallCommand(s, { chatId: 'asking' }, { command: 'search', query: 'quokka' }) as { chats: { chatId: string }[] };
    expect(outcome.chats.map((c) => c.chatId)).toEqual(['found']);
  });
});
