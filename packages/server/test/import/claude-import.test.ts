import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_ROOT_PARENT, type ClaudeExportFiles } from '@grunt/core/domain/claude-import.js';
import type { CoworkSessionFiles } from '@grunt/core/domain/cowork-import.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { AppEvent } from '@grunt/core/types/events.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
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
    read: async () => ({ files: exportFiles, sources: ['conversations.json'], organizationId: 'org-1' }),
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
    expect(status.report!.chats).toEqual({ imported: 2, existing: 0, newer: 0, filed: 0, messages: 5, failed: [] });
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
    expect(again.report!.chats).toEqual({ imported: 0, existing: 2, newer: 0, filed: 0, messages: 0, failed: [] });
    expect(store.chats.list()).toHaveLength(2);
  });

  it('counts, without adding, messages a chat gained on claude.ai since it was imported', async () => {
    await runImport(makeService());
    (exportFiles.conversations as Record<string, unknown>[])[1]!['chat_messages'] = [message('u2', 'human', CLAUDE_ROOT_PARENT, 4), message('a3', 'assistant', 'u2', 5), message('u4', 'human', 'a3', 6)];
    expect((await makeService().preview(root)).chats).toMatchObject({ total: 2, existing: 2, newer: 1 });
    const again = await runImport(makeService());
    expect(again.report!.chats).toEqual({ imported: 0, existing: 2, newer: 1, filed: 0, messages: 0, failed: [] });
    expect(store.messages.get('u4')).toBeNull();
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
    expect(status.report!.docs).toEqual({ written: 1, folders: [{ project: 'Home Stuff', path: expect.stringContaining('Home Stuff-019f3c80'), attached: true, workspace: false }] });
    expect(status.report!.fileErrors).toEqual([]);
    const folders = store.projects.get('019f3c80-aaaa')!.folders!;
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ access: 'read', workspace: { kind: 'machine', nodeId: store.nodes.self().id } });
  });

  it('keeps two claude.ai projects with one name apart, rather than merging the second into the first', async () => {
    exportFiles.projects = [
      { uuid: 'aaaa1111-x', name: 'Notes', prompt_template: 'A.', docs: [] },
      { uuid: 'bbbb2222-y', name: 'notes', prompt_template: 'B.', docs: [] },
    ];
    expect((await makeService().preview(root)).projects.map((p) => p.action)).toEqual(['create', 'create']);
    const status = await runImport(makeService());
    expect(status.report!.projects.created).toEqual(['Notes', 'notes']);
    expect(store.projects.get('aaaa1111-x')!.instructions).toBe('A.');
    expect(store.projects.get('bbbb2222-y')!.instructions).toBe('B.');
  });

  it('reports a doc it could not write and carries on', async () => {
    // A folder where the doc should go makes its write fail.
    await mkdir(join(root, 'imported', 'claude', 'Home Stuff-019f3c80', 'shed-plan.md'), { recursive: true });
    const status = await runImport(makeService());
    expect(status.state).toBe('done');
    expect(status.report!.docs.written).toBe(0);
    expect(status.report!.fileErrors).toEqual([{ title: 'Home Stuff: shed-plan.md', error: expect.any(String) }]);
    expect(status.report!.projects.created).toContain('Home Stuff');
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

  it('drafts About you for the user to accept, and saves the learned note and the project note', async () => {
    const status = await runImport(makeService(), { memory: true });
    expect(status.report!.memory).toEqual({
      model: 'Claude Opus',
      about: { status: 'drafted', text: 'I live in Wales and run a small company.' },
      note: { status: 'saved' },
      projects: [{ name: 'Garden', outcome: { status: 'saved' } }],
    });
    // About you goes into every chat as the user's own words, so it is never saved without them.
    expect(store.globalMemory.get()).toMatchObject({ about: '', note: GLOBAL_NOTE, noteUpdatedBy: 'summariser' });
    expect(store.projectMemory.get('p1')!.body).toBe(PROJECT_NOTE);
    expect(requests.map((r) => r.purpose)).toEqual(['utility', 'utility', 'utility']);
    expect(promptOf(requests[2]!)).toContain('Raised beds.');
    expect(status).toMatchObject({ done: 4, total: 4 });
  });

  it('drafts About you even when it has text, leaving it as it is, and records a rejected note without stopping', async () => {
    store.globalMemory.saveAbout('Written by me.');
    respond = (req) => (promptOf(req).includes('lasting facts about the user') ? reply('no headings at all') : goodModel(req));
    const status = await runImport(makeService(), { memory: true });
    const memory = status.report!.memory!;
    expect(memory.about.status).toBe('drafted');
    expect(memory.note.status).toBe('failed');
    expect(memory.projects[0]!.outcome).toEqual({ status: 'saved' });
    expect(store.globalMemory.get()).toMatchObject({ about: 'Written by me.', note: '' });
  });

  it('never starts a memory call still queued when Grunt shuts down', async () => {
    const queue = new MemoryQueue();
    let release!: () => void;
    // A summariser call holds the queue while the import's calls wait behind it.
    void queue.add(() => new Promise<void>((r) => (release = r)));
    const service = makeService({ queue });
    await service.start({ folder: root, profileId: 'claude', memory: true });
    await new Promise((r) => setTimeout(r, 20));
    service.dispose();
    release();
    await service.idle();
    expect(requests).toHaveLength(0);
    expect(service.status().state).toBe('failed');
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

describe("ClaudeImportService: filing chats by claude.ai's chat list", () => {
  beforeEach(() => {
    exportFiles.projects = [
      { uuid: 'p-home', name: 'Home Stuff', docs: [] },
      { uuid: 'p-phd', name: 'PhD', docs: [] },
    ];
    store.projects.create({ id: 'grunt-phd', name: 'PhD', workspace: null, defaultProfileId: null });
    exportFiles.conversations = [
      conversation('c1', 'Shed', [message('u1', 'human', CLAUDE_ROOT_PARENT, 1)]),
      conversation('c2', 'Thesis', [message('u2', 'human', CLAUDE_ROOT_PARENT, 2)]),
      conversation('c3', 'Loose', [message('u3', 'human', CLAUDE_ROOT_PARENT, 3)]),
    ];
    exportFiles.conversationList = [
      [
        { uuid: 'c1', project_uuid: 'p-home' },
        { uuid: 'c2', project_uuid: 'p-phd' },
        { uuid: 'c3', project_uuid: null },
      ],
    ];
  });

  it("files new chats under their projects, a merged project's under the one it merged into", async () => {
    const preview = await makeService().preview(root);
    expect(preview.chats.filed).toBe(2);
    expect(preview.chatList).toEqual({ found: true, url: 'https://claude.ai/api/organizations/org-1/chat_conversations' });
    const status = await runImport(makeService());
    expect(status.report!.chats.filed).toBe(2);
    expect(store.chats.get('c1')!.projectId).toBe('p-home');
    expect(store.chats.get('c2')!.projectId).toBe('grunt-phd');
    expect(store.chats.get('c3')!.projectId).toBeNull();
  });

  it('on a re-run files chats left in No project, never moving one the user filed', async () => {
    const saved = exportFiles.conversationList;
    exportFiles.conversationList = undefined;
    await runImport(makeService());
    store.projects.create({ id: 'mine', name: 'Mine', workspace: null, defaultProfileId: null });
    store.chats.update('c2', { projectId: 'mine' });
    exportFiles.conversationList = saved;
    const status = await runImport(makeService());
    expect(status.report!.chats).toMatchObject({ imported: 0, existing: 3, filed: 1 });
    expect(store.chats.get('c1')).toMatchObject({ projectId: 'p-home', memoryCursor: 'u1' });
    expect(store.chats.get('c2')!.projectId).toBe('mine');
  });

  it('says where to get the list when the folder has none', async () => {
    exportFiles.conversationList = undefined;
    expect((await makeService().preview(root)).chatList).toEqual({ found: false, url: 'https://claude.ai/api/organizations/org-1/chat_conversations' });
    expect((await makeService({ read: async () => ({ files: exportFiles, sources: [], organizationId: null }) }).preview(root)).chatList.url).toBeNull();
  });
});

describe('ClaudeImportService: Cowork sessions', () => {
  const png = Buffer.from('a png, near enough');

  function line(o: Record<string, unknown>): string {
    return JSON.stringify({ timestamp: at(1), isSidechain: false, ...o });
  }

  function session(id: string, title: string, spaceId: string | null, withImage = false): CoworkSessionFiles {
    const prompt = withImage ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }, { type: 'text', text: `${title} prompt` }] : `${title} prompt`;
    return {
      meta: { sessionId: id, title, createdAt: Date.parse(at(0)), lastActivityAt: Date.parse(at(9)), model: 'claude-opus-4-7' },
      transcript: [
        line({ type: 'user', uuid: `${id}-u`, parentUuid: null, message: { role: 'user', content: prompt } }),
        line({ type: 'assistant', uuid: `${id}-a`, parentUuid: `${id}-u`, message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: `${title} reply` }] } }),
      ].join('\n'),
      spaceId,
    };
  }

  let sessions: CoworkSessionFiles[];
  const ROOT = 'C:/Users/me/AppData/Roaming/Claude/local-agent-mode-sessions';
  const coworkService = (over: Partial<ConstructorParameters<typeof ClaudeImportService>[0]> = {}) =>
    makeService({ coworkRoot: ROOT, readCowork: async () => sessions, blobStore: createBlobStore(join(root, 'blobs')), ...over });

  async function runCowork(service: ClaudeImportService, spaces: Record<string, string | null> = { 'space-1': 'grunt-phd' }) {
    await service.start({ folder: root, profileId: 'claude', memory: false, cowork: true, spaces });
    await service.idle();
    return service.status();
  }

  beforeEach(() => {
    exportFiles.conversations = [];
    sessions = [session('local_s1', 'Finance Dept', 'space-1', true), session('local_s2', 'Fence install', null)];
    store.projects.create({ id: 'grunt-phd', name: 'PhD', workspace: null, defaultProfileId: null });
  });

  it("previews the sessions and their spaces, so the user can choose each space's project", async () => {
    expect((await coworkService().preview(root)).cowork).toEqual({
      root: ROOT,
      sessions: 2,
      existing: 0,
      messages: 4,
      images: 1,
      spaces: [{ id: 'space-1', sessions: 1, titles: ['Finance Dept'] }],
    });
    expect((await makeService().preview(root)).cowork).toBeNull();
  });

  it("imports them when asked, filing each space's sessions where the user chose and storing pasted images as attachments", async () => {
    const status = await runCowork(coworkService());
    expect(status.report!.cowork).toEqual({ imported: 2, existing: 0, filed: 1, messages: 4, images: 1, failed: [] });
    expect(store.chats.get('local_s1')).toMatchObject({ title: 'Finance Dept', projectId: 'grunt-phd', headMessageId: 'local_s1-a' });
    expect(store.chats.get('local_s2')!.projectId).toBeNull();
    const [attachment] = store.attachments.list('local_s1');
    expect(attachment).toMatchObject({ id: 'local_s1-u:image:1', messageId: 'local_s1-u', mime: 'image/png', size: png.length });
    expect(await readFile(attachment!.storagePath)).toEqual(png);
    expect(store.messages.get('local_s1-u')!.parts[0]).toEqual({ type: 'image', attachmentId: 'local_s1-u:image:1', mime: 'image/png' });
    expect(store.messages.get('local_s1-a')!.producedBy).toMatchObject({ profileName: 'Claude', modelId: 'claude-opus-4-7' });
  });

  it('skips them on a second run, filing one the first run left in No project', async () => {
    await runCowork(coworkService(), {});
    expect(store.chats.get('local_s1')!.projectId).toBeNull();
    const again = await runCowork(coworkService());
    expect(again.report!.cowork).toMatchObject({ imported: 0, existing: 2, filed: 1 });
    expect(store.chats.get('local_s1')!.projectId).toBe('grunt-phd');
  });

  it("leaves Cowork alone unless asked, and refuses a space mapped to a project that isn't there", async () => {
    expect((await runImport(coworkService())).report!.cowork).toBeNull();
    expect(store.chats.get('local_s1')).toBeNull();
    await expect(coworkService().start({ folder: root, profileId: 'claude', memory: false, cowork: true, spaces: { 'space-1': 'nope' } })).rejects.toThrow(ImportInputError);
  });

  it('notes the images instead when there is no blob store', async () => {
    await runCowork(coworkService({ blobStore: undefined }));
    expect(store.messages.get('local_s1-u')!.parts[0]).toEqual({ type: 'text', text: '[An image, not imported]' });
    expect(store.attachments.list('local_s1')).toEqual([]);
  });
});
