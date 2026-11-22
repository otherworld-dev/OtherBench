import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// Rows written under a reply that is still streaming (a sub-agent's usage, a
// tool's file, a message placed under it) are logged before the reply can be
// sent, so a machine that pulls in between has to turn them down: their parent
// isn't there. Its cursor moves on regardless, so they must be logged again,
// behind the reply, when it stops.

interface Node {
  id: string;
  db: DatabaseSync;
  store: SqliteStore;
}

function node(id: string): Node {
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('UPDATE node_self SET id = ?').run(id);
  return { id, db, store: new SqliteStore(db) };
}

/** Pulls everything `from` has changed since `cursor` into `to`, in batches of `limit`, as the syncer does. */
function pull(from: Node, to: Node, cursor: { seq: number }, limit = 1000): void {
  for (;;) {
    const batch = from.store.sync.changesSince(cursor.seq, limit);
    to.store.sync.apply(batch.rows);
    cursor.seq = batch.nextSeq;
    if (!batch.more) return;
  }
}

function message(n: Node, id: string, parentId: string | null, over: Partial<CanonMessage> = {}): void {
  n.store.messages.create({ id, chatId: 'c', parentId, role: 'user', parts: [{ type: 'text', text: id }], status: 'complete', error: null, producedBy: null, ...over });
}

function usage(n: Node, id: string, messageId: string, over: { subagentCallId?: string } = {}): void {
  n.store.usage.create({
    id, chatId: 'c', messageId, profileId: 'p1', connectionId: 'c1', modelId: 'm1', tokensIn: 3, tokensOut: 4, tokensCached: 0,
    tokensReasoning: 0, costEstimate: null, pricingSnapshot: { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' }, latencyMs: 0, ...over,
  });
}

/** Machine a: a chat with a user message and a reply that is still streaming. */
function streaming(): Node {
  const a = node('a');
  a.store.connections.create({ id: 'c1', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  a.store.models.create({
    id: 'm1', connectionId: 'c1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: false, supportsTools: false,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  a.store.profiles.create({
    id: 'p1', name: 'P', description: null, colour: null, connectionId: 'c1', modelId: 'm1', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  a.store.chats.create({ id: 'c', title: 'c', profileId: 'p1', headMessageId: null, workspace: null, pinned: false, archivedAt: null });
  message(a, 'u', null, { createdAt: 10 });
  message(a, 'r', 'u', { role: 'assistant', status: 'streaming', parts: [], createdAt: 20 });
  return a;
}

function logged(n: Node, since: number): string[] {
  return (n.db.prepare('SELECT tbl, row_id FROM change_log WHERE seq > ? ORDER BY seq').all(since) as { tbl: string; row_id: string }[]).map((r) => `${r.tbl}:${r.row_id}`);
}

describe('rows written under a reply that is still streaming', () => {
  it("a sub-agent's usage, turned down by a machine that pulled mid-reply, arrives once the reply stops", () => {
    const a = streaming();
    const b = node('b');
    const cursor = { seq: 0 };
    usage(a, 'sub', 'r', { subagentCallId: 'call-1' });

    // Mid-reply: the usage row is offered, but its reply is not there to hang it on.
    pull(a, b, cursor);
    expect(b.store.messages.get('r')).toBeNull();
    expect(b.store.usage.get('sub')).toBeNull();
    expect(cursor.seq).toBe(a.store.sync.latestSeq());

    usage(a, 'own', 'r');
    a.store.messages.updateStatus('r', 'complete');
    pull(a, b, cursor);

    expect(b.store.messages.get('r')).toMatchObject({ status: 'complete' });
    expect(b.store.usage.get('sub')).toMatchObject({ messageId: 'r', tokensOut: 4, subagentCallId: 'call-1' });
    expect(b.store.usage.get('own')).toMatchObject({ messageId: 'r' });
  });

  it('arrives too when the reply and its usage fall in different batches', () => {
    const a = streaming();
    const b = node('b');
    const cursor = { seq: 0 };
    usage(a, 'sub', 'r');
    pull(a, b, cursor, 1);

    a.store.messages.updateStatus('r', 'error', { kind: 'unknown', message: 'cut off', retryable: true });
    pull(a, b, cursor, 1);

    expect(b.store.usage.get('sub')).toMatchObject({ messageId: 'r' });
  });

  it('logs the usage again behind the reply, once, and only when the reply stops', () => {
    const a = streaming();
    usage(a, 'sub', 'r');
    const before = a.store.sync.latestSeq();

    a.store.messages.updateStatus('r', 'complete');

    expect(logged(a, before)).toEqual(['message:r', 'usage:sub']);
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE tbl = 'usage' AND row_id = 'sub'").get()).toEqual({ n: 1 });
    // A reply with nothing under it logs itself and nothing else.
    message(a, 'plain', 'r', { role: 'assistant', status: 'streaming', parts: [] });
    const mid = a.store.sync.latestSeq();
    a.store.messages.updateStatus('plain', 'complete');
    expect(logged(a, mid)).toEqual(['message:plain']);
  });

  it('messages placed under it, with their own files, usage and replies, arrive once it stops, whatever the batch size', () => {
    for (const limit of [1000, 1]) {
      const a = streaming();
      const b = node('b');
      const cursor = { seq: 0 };
      // A follow-on under the streaming reply, its file, its own finished reply with usage, and one still streaming.
      message(a, 'next', 'r', { createdAt: 30 });
      a.store.attachments.create({ id: 'file', chatId: 'c', messageId: 'next', filename: 'f.png', mime: 'image/png', size: 1, sha256: 'a'.repeat(64), storagePath: 'E:/blobs/a', extractedText: null });
      message(a, 'answer', 'next', { role: 'assistant', createdAt: 40 });
      usage(a, 'answer-usage', 'answer');
      message(a, 'later', 'answer', { role: 'assistant', status: 'streaming', parts: [], createdAt: 50 });
      usage(a, 'later-usage', 'later');

      pull(a, b, cursor, limit);
      expect(b.store.messages.get('next'), `limit ${limit}`).toBeNull();
      expect(b.store.messages.get('answer'), `limit ${limit}`).toBeNull();

      a.store.messages.updateStatus('r', 'complete');
      pull(a, b, cursor, limit);

      expect(b.store.messages.get('next'), `limit ${limit}`).toMatchObject({ parentId: 'r' });
      expect(b.store.attachments.get('file'), `limit ${limit}`).toMatchObject({ messageId: 'next' });
      expect(b.store.messages.get('answer'), `limit ${limit}`).toMatchObject({ parentId: 'next' });
      expect(b.store.usage.get('answer-usage'), `limit ${limit}`).toMatchObject({ messageId: 'answer' });
      // What is under a reply still streaming waits for that reply.
      expect(b.store.messages.get('later'), `limit ${limit}`).toBeNull();
      expect(b.store.usage.get('later-usage'), `limit ${limit}`).toBeNull();

      a.store.messages.updateStatus('later', 'complete');
      pull(a, b, cursor, limit);
      expect(b.store.messages.get('later'), `limit ${limit}`).toMatchObject({ status: 'complete' });
      expect(b.store.usage.get('later-usage'), `limit ${limit}`).toMatchObject({ messageId: 'later' });
    }
  });

  it('nothing is sent twice to a machine that had it already', () => {
    const a = streaming();
    const b = node('b');
    const cursor = { seq: 0 };
    a.store.messages.updateStatus('r', 'complete');
    usage(a, 'own', 'r');
    pull(a, b, cursor);
    const stamp = (b.db.prepare("SELECT hlc FROM usage WHERE id = 'own'").get() as { hlc: string }).hlc;

    // A retry: the reply streams again and stops again, and its usage is logged again behind it.
    a.store.messages.updateStatus('r', 'streaming');
    a.store.messages.updateStatus('r', 'complete');
    const batch = a.store.sync.changesSince(cursor.seq, 1000);
    const result = b.store.sync.apply(batch.rows);

    expect(result.written.filter((w) => w.tbl === 'usage')).toEqual([]);
    expect((b.db.prepare("SELECT hlc FROM usage WHERE id = 'own'").get() as { hlc: string }).hlc).toBe(stamp);
  });
});
