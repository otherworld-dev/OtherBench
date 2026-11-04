import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeExportError } from '@otherbench/core/domain/claude-import.js';
import { classifyExportPath, claudeReaderWorkersRunning, readClaudeExport, readClaudeExportInProcess, readerWorkerCandidates } from '../../src/import/claude-reader.js';
import { makeZip } from './make-zip.js';

/** `count` conversations of 20 messages, about 32 KB each: 50 make about 1.6 MB of JSON. */
function bigConversations(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      uuid: `c${i}`,
      name: `Chat ${i}`,
      chat_messages: Array.from({ length: 20 }, (_, j) => ({ uuid: `c${i}-m${j}`, sender: j % 2 ? 'assistant' : 'human', text: `${i}.${j} `.repeat(200), content: [{ type: 'text', text: 'word '.repeat(80) }], attachments: [] })),
    }))
  );
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otherbench-claude-reader-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(rel: string, content: string | Buffer): Promise<void> {
  const path = join(dir, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

const conversations = JSON.stringify([{ uuid: 'c1', chat_messages: [] }]);

describe('classifyExportPath', () => {
  it('knows the parts the import uses, under any leading folders', () => {
    expect(classifyExportPath('conversations.json')).toEqual({ kind: 'conversations' });
    expect(classifyExportPath('x/conversations/conversations.json')).toEqual({ kind: 'conversations' });
    expect(classifyExportPath('projects/019a.json')).toEqual({ kind: 'project' });
    expect(classifyExportPath('memories\\acc.json')).toEqual({ kind: 'memory' });
    expect(classifyExportPath('frames/artifacts/a1/artifact.json')).toEqual({ kind: 'artifact-meta', artifact: 'a1' });
    expect(classifyExportPath('artifacts/a1/versions/178-ab.html')).toEqual({ kind: 'artifact-html', artifact: 'a1', version: '178-ab' });
    for (const ignored of ['users.json', 'login_history.json', 'design_chats/d1.json', 'projects/sub/p.json', 'artifacts/a1/notes.txt']) {
      expect(classifyExportPath(ignored)).toBeNull();
    }
  });
});

describe('readClaudeExport', () => {
  it('reads the downloaded ZIPs', async () => {
    await put('conversations-000.zip', makeZip([{ name: 'conversations.json', content: conversations }]));
    await put('projects-000.zip', makeZip([{ name: 'projects/p1.json', content: '{"uuid":"p1"}' }, { name: 'projects/p2.json', content: '{"uuid":"p2"}' }]));
    await put('memories-000.zip', makeZip([{ name: 'memories/acc.json', content: '{"account_uuid":"acc"}' }]));
    await put(
      'frames-000.zip',
      makeZip([
        { name: 'artifacts/a1/artifact.json', content: '{"id":"a1"}' },
        { name: 'artifacts/a1/versions/v1.html', content: '<p>one</p>' },
      ])
    );
    await put('light_metadata-000.zip', makeZip([{ name: 'login_history.json', content: 'not read' }]));
    const read = await readClaudeExport(dir);
    expect(read.files.conversations).toEqual([{ uuid: 'c1', chat_messages: [] }]);
    expect(read.files.projects).toEqual([{ uuid: 'p1' }, { uuid: 'p2' }]);
    expect(read.files.memories).toEqual([{ account_uuid: 'acc' }]);
    expect(read.files.artifacts).toEqual([{ meta: { id: 'a1' }, html: { v1: '<p>one</p>' } }]);
    expect(read.sources).toEqual(['conversations-000.zip: conversations.json', 'memories-000.zip: memories/acc.json']);
  });

  it('reads extracted folders, and joins conversations from several parts', async () => {
    await put('conversations/conversations.json', conversations);
    await put('conversations-001/conversations.json', JSON.stringify([{ uuid: 'c2', chat_messages: [] }]));
    await put('projects/projects/p1.json', '{"uuid":"p1"}');
    await put('frames/artifacts/a1/artifact.json', '{"id":"a1"}');
    await put('frames/artifacts/a1/versions/v1.html', '<p>one</p>');
    const read = await readClaudeExport(dir);
    expect(read.files.conversations).toHaveLength(2);
    expect(read.files.conversations).toEqual(expect.arrayContaining([{ uuid: 'c1', chat_messages: [] }, { uuid: 'c2', chat_messages: [] }]));
    expect(read.files.projects).toEqual([{ uuid: 'p1' }]);
    expect(read.files.artifacts).toEqual([{ meta: { id: 'a1' }, html: { v1: '<p>one</p>' } }]);
  });

  it("reads claude.ai's chat list when it's saved into the folder, and the organisation from the manifest", async () => {
    await put('conversations.json', conversations);
    await put('chat_conversations (1).json', JSON.stringify([{ uuid: 'c1', project_uuid: 'p1' }]));
    await put('zips/manifest-cb5dc9c1-1791-2026.json', JSON.stringify({ data_files: [{ export_url: 'https://claude.ai/export/cb5dc9c1-cce3-443e-992e-7663a0cd0690/download/abc', filename: 'conversations-000.zip' }] }));
    const read = await readClaudeExport(dir);
    expect(read.files.conversationList).toEqual([[{ uuid: 'c1', project_uuid: 'p1' }]]);
    expect(read.organizationId).toBe('cb5dc9c1-cce3-443e-992e-7663a0cd0690');
    expect(read.sources).toContain('chat_conversations (1).json');
  });

  it('reads the list of files saved from claude.ai and says where they are, but never from a ZIP', async () => {
    await put('conversations.json', conversations);
    await put('saved/files/index.json', JSON.stringify({ 'bc2bf0f2-7906-4f06-9a72-a82a7da01427': { name: 'a.pdf', mime: 'application/pdf' } }));
    await put('saved/files/bc2bf0f2-7906-4f06-9a72-a82a7da01427', '%PDF-');
    await put('conversations-001.zip', makeZip([{ name: 'files/index.json', content: '{"from":"zip"}' }]));
    const read = await readClaudeExport(dir);
    expect(read.files.downloaded).toEqual({ 'bc2bf0f2-7906-4f06-9a72-a82a7da01427': { name: 'a.pdf', mime: 'application/pdf' } });
    expect(read.filesDir).toBe(join(dir, 'saved', 'files'));
    expect(read.sources).toContain('saved/files/index.json');
  });

  it('has no saved files when the folder has no list of them', async () => {
    await put('conversations.json', conversations);
    const read = await readClaudeExport(dir);
    expect(read.files.downloaded).toBeUndefined();
    expect(read.filesDir).toBeNull();
  });

  it("leaves alone ZIPs that aren't the export's, even unreadable ones", async () => {
    await put('conversations.json', conversations);
    await put('holiday-photos.zip', Buffer.from('not a zip'));
    await put('backup-000.zip', Buffer.from('not a zip either'));
    await put('conversations-000 (1).zip', makeZip([{ name: 'conversations.json', content: JSON.stringify([{ uuid: 'c2', chat_messages: [] }]) }]));
    const read = await readClaudeExport(dir);
    expect(read.files.conversations).toHaveLength(2);
  });

  it('follows a link only when it leads somewhere inside the folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'otherbench-claude-outside-'));
    try {
      await mkdir(join(outside, 'projects'));
      await writeFile(join(outside, 'projects', 'secret.json'), '{"uuid":"outside"}');
      await put('conversations.json', conversations);
      await put('real/projects/p1.json', '{"uuid":"p1"}');
      await symlink(outside, join(dir, 'away'), 'junction');
      await symlink(join(dir, 'real'), join(dir, 'here'), 'junction');
      const read = await readClaudeExport(dir);
      // real/ and the link to it, which the planner reads as one project; never the folder outside.
      expect(read.files.projects).toEqual([{ uuid: 'p1' }, { uuid: 'p1' }]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('says what is wrong when the folder is missing, not a folder, relative or has no conversations', async () => {
    await expect(readClaudeExport(join(dir, 'nope'))).rejects.toThrow(/There's no folder at/);
    await put('file.txt', 'x');
    await expect(readClaudeExport(join(dir, 'file.txt'))).rejects.toThrow(/is a file, not a folder/);
    await expect(readClaudeExport('relative/path')).rejects.toThrow(/full path/);
    await expect(readClaudeExport(dir)).rejects.toThrow(/There's no conversations.json/);
  });

  it("reads a folder without an export when it's optional, saying there was none", async () => {
    await put('acc/org/local_s1.json', '{}');
    expect(await readClaudeExport(dir, { optional: true })).toMatchObject({ hasExport: false, sources: [] });
    await put('conversations.json', conversations);
    expect((await readClaudeExport(dir, { optional: true })).hasExport).toBe(true);
  });

  it("never searches a Cowork session's own folder, whose files could be named like the export's", async () => {
    await put('conversations.json', conversations);
    await put('acc/org/local_s1/outputs/conversations.json', JSON.stringify([{ uuid: 'planted', chat_messages: [] }]));
    await put('acc/org/local_s1/outputs/projects/p.json', '{}');
    const read = await readClaudeExport(dir);
    expect(read.files.conversations).toEqual([{ uuid: 'c1', chat_messages: [] }]);
    expect(read.files.projects).toEqual([]);
  });

  it('refuses invalid JSON, conversations that are not a list, and a damaged ZIP, naming the file', async () => {
    await put('conversations.json', '{ broken');
    await expect(readClaudeExport(dir)).rejects.toThrow(/conversations.json isn't valid JSON/);
    await put('conversations.json', '{"not":"a list"}');
    await expect(readClaudeExport(dir)).rejects.toThrow(ClaudeExportError);
    await rm(join(dir, 'conversations.json'));
    await put('conversations-000.zip', Buffer.from('this is not a zip file, it is just some text'));
    await expect(readClaudeExport(dir)).rejects.toThrow(/conversations-000.zip: /);
  });

  it('refuses a ZIP entry over the size the import reads, with the same message as in this thread', async () => {
    const zip = makeZip([{ name: 'conversations.json', content: conversations }]);
    // The central directory's uncompressed size (one entry, so it starts after the local header, name and data).
    const central = zip.length - 22 - 46 - 'conversations.json'.length;
    zip.writeUInt32LE(600 * 1024 * 1024, central + 24);
    await put('conversations-000.zip', zip);
    const inProcess = await readClaudeExportInProcess(dir).catch((err: unknown) => err);
    expect(inProcess).toBeInstanceOf(ClaudeExportError);
    expect((inProcess as Error).message).toMatch(/conversations-000.zip: "conversations.json" is 629,145,600 bytes, over the 536,870,912 the import reads/);
    await expect(readClaudeExport(dir)).rejects.toThrow(ClaudeExportError);
    await expect(readClaudeExport(dir)).rejects.toThrow((inProcess as Error).message);
  });
});

describe('readClaudeExport in a worker', () => {
  it('finds the worker beside its module, or in dist when run from the sources', () => {
    expect(readerWorkerCandidates('file:///repo/packages/server/src/import/claude-reader.ts').map((u) => u.href)).toEqual([
      'file:///repo/packages/server/src/import/claude-reader-worker.js',
      'file:///repo/packages/server/dist/import/claude-reader-worker.js',
    ]);
    expect(readerWorkerCandidates('file:///repo/packages/server/dist/import/claude-reader.js').map((u) => u.href)).toEqual(['file:///repo/packages/server/dist/import/claude-reader-worker.js']);
    // The bundle: this module is part of cli.js, and the worker is written next to it.
    expect(readerWorkerCandidates('file:///app/server/cli.js').map((u) => u.href)).toEqual(['file:///app/server/claude-reader-worker.js']);
  });

  it('reads what this thread reads, the lists sent back in several batches, and leaves no worker running', async () => {
    await put('conversations-000.zip', makeZip([{ name: 'conversations.json', content: bigConversations(120) }]));
    await put('projects/projects/p1.json', '{"uuid":"p1","docs":[{"content":"x"}]}');
    await put('memories/memories/acc.json', '{"account_uuid":"acc"}');
    await put('frames/artifacts/a1/artifact.json', '{"id":"a1"}');
    await put('frames/artifacts/a1/versions/constructor.html', '<p>one</p>');
    await put('chat_conversations.json', '[{"uuid":"c1"}]');
    await put('saved/files/index.json', '{"f1":{"name":"a.pdf"}}');
    const inWorker = await readClaudeExport(dir);
    expect(inWorker).toStrictEqual(await readClaudeExportInProcess(dir));
    expect(inWorker.files.conversations).toHaveLength(120);
    expect(Object.getPrototypeOf(inWorker.files.artifacts[0]!.html)).toBeNull();
    expect(claudeReaderWorkersRunning()).toBe(0);
  });

  it('stops the worker when the request goes away', async () => {
    await put('conversations.json', bigConversations(50));
    const gone = new AbortController();
    const reading = readClaudeExport(dir, { signal: gone.signal });
    gone.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(claudeReaderWorkersRunning()).toBe(0);
    await expect(readClaudeExport(dir, { signal: gone.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(claudeReaderWorkersRunning()).toBe(0);
  });

  it('keeps this thread free while a large export is parsed', async () => {
    const json = bigConversations(600);
    await put('conversations.json', json);
    // How long this thread would be held parsing it: the longest pause the timer should see is well short of it.
    JSON.parse(json);
    const started = performance.now();
    JSON.parse(json);
    const parseMs = performance.now() - started;

    let ticks = 0;
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      ticks++;
    }, 1);
    try {
      const read = await readClaudeExport(dir);
      // One more turn, so a pause at the very end is measured too.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(read.files.conversations).toHaveLength(600);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
    expect(longest).toBeLessThan(parseMs);
  });
});
