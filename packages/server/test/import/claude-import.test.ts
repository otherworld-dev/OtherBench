import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_ROOT_PARENT, type ClaudeExportFiles } from '@grunt/core/domain/claude-import.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { AppEvent } from '@grunt/core/types/events.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import { openDatabase } from '@grunt/store-sqlite/db.js';
import { runMigrations } from '@grunt/store-sqlite/migrations/index.js';
import { SqliteStore } from '@grunt/store-sqlite/store.js';
import { ClaudeImportService, ImportBusyError, ImportInputError } from '../../src/import/claude-import.js';
import { MemoryQueue } from '../../src/memory/shared.js';
import { AppEventBus, withChatEvents } from '../../src/stream/events.js';

const ZERO = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };
const reply = (text: string): EngineEvent[] => [{ type: 'text-delta', text }, { type: 'finish', usage: ZERO, finishReason: 'stop' }];
const GLOBAL_NOTE = '## Pinned\n\n## Preferences\n- British spelling\n\n## Setup and tools\n\n## Working style';
const PROJECT_NOTE = '## Pinned\n\n## Goals\n- Raised beds\n\n## Decisions\n\n## Current focus\n- The shed\n\n## Open questions';

let store: Store;
let bus: AppEventBus;
let events: AppEvent[];
let root: string;
let exportFiles: ClaudeExportFiles;
let requests: EngineRequest[];
let respond: (req: EngineRequest) => Promise<EngineEvent[]> | EngineEvent[];

const engine: ChatEngine = {
  async *stream(req) {
    requests.push(req);
    for (const event of await respond(req)) {
      if (req.signal.aborted) return;
      yield event;
    }
  },
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

const resolveProfile = async (id: string): Promise<ResolvedProfile> => {
  const profile = store.profiles.get(id);
  if (!profile) throw new Error(`cannot resolve ${id}`);
  return { ...profile, connection: store.connections.get(profile.connectionId)!, apiKey: null, model: null };
};

function promptOf(req: EngineRequest): string {
  const part = req.messages[0]!.parts[0]!;
  return part.type === 'text' ? part.text : '';
}

/** Answers each condensing prompt with a valid result. */
function goodModel(req: EngineRequest): EngineEvent[] {
  const prompt = promptOf(req);
  if (prompt.includes('"About you"')) return reply('I live in Wales and run a small company.');
  if (prompt.includes('lasting facts about the user')) return reply(GLOBAL_NOTE);
  return reply(PROJECT_NOTE);
}

function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
}

function message(uuid: string, sender: 'human' | 'assistant', parent: string, minute: number, text = `${uuid} text`): Record<string, unknown> {
  return { uuid, sender, parent_message_uuid: parent, created_at: at(minute), text: '', content: [{ type: 'text', text }], attachments: [], files: [] };
}

function conversation(uuid: string, name: string, messages: Record<string, unknown>[]): Record<string, unknown> {
  return { uuid, name, created_at: at(0), updated_at: at(30), chat_messages: messages };
}

function makeService(over: Partial<ConstructorParameters<typeof ClaudeImportService>[0]> = {}): ClaudeImportService {
  return new ClaudeImportService({
    store,
    engine,
    resolveProfile,
    queue: new MemoryQueue(),
    events: bus,
    importRoot: join(root, 'imported', 'claude'),
    read: async () => ({ files: exportFiles, sources: ['conversations.json'] }),
    ...over,
  });
}

async function runImport(service: ClaudeImportService, over: { memory?: boolean; profileId?: string } = {}) {
  await service.start({ folder: root, profileId: over.profileId ?? 'claude', memory: over.memory ?? false });
  await service.idle();
  return service.status();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grunt-claude-import-'));
  const db = openDatabase(':memory:');
  runMigrations(db);
  bus = new AppEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  store = withChatEvents(new SqliteStore(db), bus);
  store.connections.create({ id: 'conn', name: 'Anthropic', kind: 'anthropic', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  for (const id of ['claude', 'old']) {
    store.profiles.create({
      id,
      name: id === 'claude' ? 'Claude Opus' : 'Old',
      description: null,
      colour: null,
      connectionId: 'conn',
      modelId: 'claude-opus',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: false,
      archivedAt: id === 'old' ? 1 : null,
    });
  }
  requests = [];
  respond = goodModel;
  exportFiles = {
    conversations: [
      conversation('c1', 'Garden plans', [message('u1', 'human', CLAUDE_ROOT_PARENT, 1), message('a1', 'assistant', 'u1', 2), message('a2', 'assistant', 'u1', 3)]),
      conversation('c2', 'Shed', [message('u2', 'human', CLAUDE_ROOT_PARENT, 4), message('a3', 'assistant', 'u2', 5)]),
      conversation('c3', '', []),
    ],
    projects: [],
    memories: [],
    artifacts: [],
  };
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe('ClaudeImportService: chats', () => {
  it('imports every conversation with its messages, branches, times and memory cursors', async () => {
    const status = await runImport(makeService());
    expect(status).toMatchObject({ state: 'done', done: 2, total: 2, error: null });
    expect(status.report!.chats).toEqual({ imported: 2, existing: 0, messages: 5, failed: [] });
    expect(status.report!.emptyChats).toBe(1);

    const chat = store.chats.get('c1')!;
    expect(chat).toMatchObject({ title: 'Garden plans', profileId: 'claude', headMessageId: 'a2', memoryCursor: 'a2', globalMemoryCursor: 'a2', createdAt: Date.parse(at(0)), updatedAt: Date.parse(at(30)) });
    expect(store.messages.children('u1').map((m) => [m.id, m.producedBy?.regenerated ?? false])).toEqual([
      ['a1', false],
      ['a2', true],
    ]);
    expect(store.messages.searchText('a3 text', 5).map((h) => h.chatId)).toEqual(['c2']);
    expect(events.filter((e) => e.type === 'chat-created').map((e) => (e.type === 'chat-created' ? e.chat.id : ''))).toEqual(['c1', 'c2']);
  });

  it('skips chats already imported on a second run', async () => {
    await runImport(makeService());
    const again = await runImport(makeService());
    expect(again.report!.chats).toEqual({ imported: 0, existing: 2, messages: 0, failed: [] });
    expect(store.chats.list()).toHaveLength(2);
  });

  it('rolls back a chat that fails part-way, says so, and carries on with the rest', async () => {
    exportFiles.conversations = [
      conversation('c1', 'Garden plans', [message('u1', 'human', CLAUDE_ROOT_PARENT, 1)]),
      // u1 again: its insert fails after the chat row is written.
      conversation('c2', 'Clash', [message('u9', 'human', CLAUDE_ROOT_PARENT, 2), message('u1', 'assistant', 'u9', 3)]),
      conversation('c3', 'Fine', [message('u3', 'human', CLAUDE_ROOT_PARENT, 4)]),
    ];
    const status = await runImport(makeService());
    expect(status.state).toBe('done');
    expect(status.report!.chats.imported).toBe(2);
    expect(status.report!.chats.failed).toEqual([{ title: 'Clash', error: expect.any(String) }]);
    expect(store.chats.get('c2')).toBeNull();
    expect(store.messages.get('u9')).toBeNull();
    expect(store.chats.get('c3')).not.toBeNull();
    expect(events.some((e) => e.type === 'chat-deleted' && e.chatId === 'c2')).toBe(true);
  });

  it('refuses a missing or archived profile and a second start while one runs', async () => {
    const service = makeService();
    await expect(service.start({ folder: root, profileId: 'nope', memory: false })).rejects.toThrow(ImportInputError);
    await expect(service.start({ folder: root, profileId: 'old', memory: false })).rejects.toThrow(/archived/);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const reached = new Promise<void>((r) => (asked = r));
    respond = async (req) => {
      asked();
      await gate;
      return goodModel(req);
    };
    exportFiles.memories = [{ account_uuid: 'acc', conversations_memory: 'Lives in Wales.' }];
    await service.start({ folder: root, profileId: 'claude', memory: true });
    await expect(service.start({ folder: root, profileId: 'claude', memory: false })).rejects.toThrow(ImportBusyError);
    await reached;
    expect(service.status()).toMatchObject({ state: 'running', phase: 'memory' });
    release();
    await service.idle();
    expect(service.status().state).toBe('done');
  });
});

describe('ClaudeImportService: published artifacts', () => {
  it('makes a chat holding the artifact with numbered, chained versions', async () => {
    exportFiles.conversations = [];
    exportFiles.artifacts = [
      {
        meta: { id: 'art1', active_version: 'v2', updated_at: at(40), versions: [{ id: 'v1', title: 'Draft', created_at: at(10) }, { id: 'v2', title: 'Final', created_at: at(20) }] },
        html: { v1: '<p>1</p>', v2: '<p>2</p>' },
      },
    ];
    const status = await runImport(makeService());
    expect(status.report!.artifacts).toEqual({ imported: 1, existing: 0, failed: [] });
    expect(store.chats.get('art1')).toMatchObject({ title: 'Final', headMessageId: 'art1:message' });
    const [artifact] = store.artifacts.listByChat('art1');
    expect(artifact).toMatchObject({ id: 'art1:artifact', slug: 'final', kind: 'html' });
    expect(store.artifacts.versions('art1:artifact').map((v) => [v.number, v.title, v.parentVersionId, v.messageId])).toEqual([
      [1, 'Draft', null, 'art1:message'],
      [2, 'Final', 'art1:v1', 'art1:message'],
    ]);
  });
});

describe('ClaudeImportService: projects and files', () => {
  beforeEach(() => {
    exportFiles.conversations = [];
    exportFiles.projects = [
      { uuid: '019f3c80-aaaa', name: 'Home Stuff', description: 'House things', prompt_template: 'Be brief.', created_at: at(0), updated_at: at(1), docs: [{ filename: 'claude/shed-plan.md', content: '# Shed' }] },
      { uuid: '019c0000-bbbb', name: 'phd', description: 'Robots', prompt_template: 'Cite sources.', created_at: at(0), updated_at: at(1), docs: [] },
    ];
    store.projects.create({ id: 'grunt-phd', name: 'PhD', description: '', instructions: 'Mine.', workspace: null, defaultProfileId: null });
  });

  it('creates new projects, merges into one with the same name without overwriting, and writes and attaches docs', async () => {
    const status = await runImport(makeService());
    expect(status.report!.projects).toMatchObject({ created: ['Home Stuff'], merged: ['PhD'], existing: [], failed: [] });
    expect(store.projects.get('019f3c80-aaaa')).toMatchObject({ name: 'Home Stuff', description: 'House things', instructions: 'Be brief.' });
    expect(store.projects.get('grunt-phd')).toMatchObject({ description: 'Robots', instructions: 'Mine.' });
    expect(store.projects.list().map((p) => p.name)).toEqual(['PhD', 'Home Stuff']);
    expect(store.projects.get('019f3c80-aaaa')!.sortOrder).toBeGreaterThan(store.projects.get('grunt-phd')!.sortOrder);

    const folder = join(root, 'imported', 'claude', 'Home Stuff-019f3c80');
    expect(await readFile(join(folder, 'shed-plan.md'), 'utf8')).toBe('# Shed');
    expect(status.report!.docs).toEqual({ written: 1, folders: [{ project: 'Home Stuff', path: expect.stringContaining('Home Stuff-019f3c80'), attached: true }] });
    const folders = store.projects.get('019f3c80-aaaa')!.folders!;
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ access: 'read', workspace: { kind: 'machine', nodeId: store.nodes.self().id } });
  });

  it('on a second run finds its own projects by id and attaches the docs folder only once', async () => {
    await runImport(makeService());
    const again = await runImport(makeService());
    expect(again.report!.projects).toMatchObject({ created: [], existing: ['Home Stuff'], merged: ['PhD'] });
    expect(store.projects.get('019f3c80-aaaa')!.folders).toHaveLength(1);
  });

  it("keeps every claude.ai memory file under memory/, whether or not memory is condensed", async () => {
    exportFiles.memories = [{ account_uuid: 'acc', conversations_memory: 'Lives in Wales.', memory_files: [{ path: '/people/wife.md', content: 'Married.' }, { path: '/../escape.md', content: 'stays inside' }] }];
    const status = await runImport(makeService());
    const base = join(root, 'imported', 'claude', 'memory');
    expect(status.report!.memoryFiles).toBe(base);
    expect(status.report!.memory).toBeNull();
    expect(await readFile(join(base, 'people', 'wife.md'), 'utf8')).toBe('Married.');
    expect(await readFile(join(base, 'conversations-memory.md'), 'utf8')).toBe('Lives in Wales.');
    expect((await readdir(base)).sort()).toEqual(['conversations-memory.md', 'part-1', 'people']);
    expect(await readFile(join(base, 'part-1', 'escape.md'), 'utf8')).toBe('stays inside');
    expect(requests).toHaveLength(0);
  });
});

describe('ClaudeImportService: memory', () => {
  beforeEach(() => {
    exportFiles.conversations = [];
    exportFiles.projects = [{ uuid: 'p1', name: 'Garden', docs: [] }];
    exportFiles.memories = [{ account_uuid: 'acc', conversations_memory: 'Lives in Wales.', memory_files: [{ path: '/preferences.md', content: 'British spelling.' }], project_memories: { p1: 'Raised beds.' } }];
  });

  it('writes About you, the learned note and the project note with the memory model', async () => {
    const status = await runImport(makeService(), { memory: true });
    expect(status.report!.memory).toEqual({
      model: 'Claude Opus',
      about: { status: 'saved' },
      note: { status: 'saved' },
      projects: [{ name: 'Garden', outcome: { status: 'saved' } }],
    });
    expect(store.globalMemory.get()).toMatchObject({ about: 'I live in Wales and run a small company.', note: GLOBAL_NOTE, noteUpdatedBy: 'summariser' });
    expect(store.projectMemory.get('p1')!.body).toBe(PROJECT_NOTE);
    expect(requests.map((r) => r.purpose)).toEqual(['utility', 'utility', 'utility']);
    expect(promptOf(requests[2]!)).toContain('Raised beds.');
    expect(status).toMatchObject({ done: 4, total: 4 });
  });

  it('leaves About you alone when it has text, and records a rejected note without stopping', async () => {
    store.globalMemory.saveAbout('Written by me.');
    respond = (req) => (promptOf(req).includes('lasting facts about the user') ? reply('no headings at all') : goodModel(req));
    const status = await runImport(makeService(), { memory: true });
    const memory = status.report!.memory!;
    expect(memory.about).toEqual({ status: 'skipped', reason: 'About you already has text, so it was left as it is.' });
    expect(memory.note.status).toBe('failed');
    expect(memory.projects[0]!.outcome).toEqual({ status: 'saved' });
    expect(store.globalMemory.get()).toMatchObject({ about: 'Written by me.', note: '' });
  });

  it("doesn't save a condensed note with nothing in it", async () => {
    const EMPTY_PROJECT_NOTE = '## Pinned\n\n## Goals\n\n## Decisions\n\n## Current focus\n\n## Open questions';
    respond = (req) => (promptOf(req).includes('shared memory note for the project') ? reply(EMPTY_PROJECT_NOTE) : goodModel(req));
    const status = await runImport(makeService(), { memory: true });
    expect(status.report!.memory!.projects).toEqual([{ name: 'Garden', outcome: { status: 'skipped', reason: "claude.ai's notes had nothing worth keeping." } }]);
    expect(store.projectMemory.get('p1')).toBeNull();
  });

  it('skips memory when no model can run it', async () => {
    const service = makeService({ resolveProfile: async () => Promise.reject(new Error('no API key')) });
    expect((await service.preview(root, 'claude')).memoryModel).toBeNull();
    const memory = (await runImport(service, { memory: true })).report!.memory!;
    expect(memory).toEqual({
      model: null,
      about: { status: 'skipped', reason: 'No model available for memory.' },
      note: { status: 'skipped', reason: 'No model available for memory.' },
      projects: [{ name: 'Garden', outcome: { status: 'skipped', reason: 'No model available for memory.' } }],
    });
    expect(requests).toHaveLength(0);
  });

  it('previews what the import would do', async () => {
    store.globalMemory.saveAbout('Written by me.');
    exportFiles.conversations = [conversation('c1', 'A', [message('u1', 'human', CLAUDE_ROOT_PARENT, 1)]), conversation('c2', '', [])];
    exportFiles.artifacts = [{ meta: { id: 'art1', active_version: 'v1', versions: [{ id: 'v1', title: 'Page', created_at: at(1) }] }, html: { v1: '<p></p>' } }];
    store.projects.create({ id: 'garden-here', name: 'garden', workspace: null, defaultProfileId: null });
    const preview = await makeService().preview(root, 'claude');
    expect(preview).toMatchObject({
      folder: root,
      chats: { total: 1, existing: 0, messages: 1, branched: 0 },
      emptyChats: 1,
      artifacts: [{ title: 'Page', versions: 1, existing: false }],
      projects: [{ name: 'Garden', action: 'merge', mergeInto: 'garden', docs: 0, hasInstructions: false, hasMemory: true }],
      memory: { about: true, aboutTaken: true, note: true, projectNotes: 1, files: 3 },
      memoryModel: 'Claude Opus',
      importFolder: join(root, 'imported', 'claude'),
    });
  });
});
