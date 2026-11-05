import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_NOTES_MIRROR_BANNER, emptyAppNotesBody } from '@otherbench/core/domain/app-notes.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Profile, ResolvedProfile } from '@otherbench/core/types/config.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import { AppNotesService } from '../../src/app-notes/service.js';
import type { Container } from '../../src/container.js';
import { CodeRouteError } from '../../src/code/route-errors.js';
import { NextcloudError } from '../../src/nextcloud/client.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { FakeNextcloudClient } from '../nextcloud/fake-client.js';
import { ManualClock } from '../memory/manual-clock.js';

const ZERO = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };
const reply = (text: string): EngineEvent[] => [{ type: 'text-delta', text }, { type: 'finish', usage: ZERO, finishReason: 'stop' }];

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function profileRow(id: string): Profile {
  return {
    id,
    name: id,
    description: null,
    colour: null,
    connectionId: 'conn',
    modelId: 'm',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: true,
    archivedAt: null,
  };
}

let store: InMemoryStore;
let fake: FakeNextcloudClient;
let clock: ManualClock;
let respond: (req: EngineRequest) => EngineEvent[];
let requests: EngineRequest[];
let nextcloudOff: CodeRouteError | null;
let service: AppNotesService;
let container: Container;

const engine: ChatEngine = {
  async *stream(req) {
    requests.push(req);
    for (const event of respond(req)) yield event;
  },
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

beforeEach(() => {
  store = new InMemoryStore('node-pc');
  store.connections.create({ id: 'conn', name: 'Local', kind: 'ollama', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create(profileRow('p1'));
  store.apps.create({ id: 'app1', name: 'OtherBench', wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench' });
  store.apps.create({ id: 'app2', name: 'Bare' });
  fake = new FakeNextcloudClient({
    collectives: [{ id: 1, name: 'Otherworld Dev' }],
    pages: [
      { id: 1, title: 'Landing', parentId: 0, collectiveId: 1, fileName: 'Readme.md' },
      { id: 2, title: 'Products', parentId: 1, collectiveId: 1 },
    ],
  });
  clock = new ManualClock();
  requests = [];
  respond = () => reply('{"section":"VM / workers","replaces":null}');
  nextcloudOff = null;
  service = new AppNotesService({
    store,
    engine,
    resolveProfile: async (id: string): Promise<ResolvedProfile> => {
      const profile = store.profiles.get(id)!;
      return { ...profile, connection: store.connections.get('conn')!, apiKey: null, model: null };
    },
    nextcloud: async () => {
      if (nextcloudOff) throw nextcloudOff;
      return fake;
    },
    now: clock.now,
    scheduler: clock,
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'ob-appnotes-'));
  made.push(dataDir);
  const turnEngine = engine;
  const turnRunner = new TurnRunner(store, turnEngine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    appNotes: service,
    close: () => {},
  };
});

const app1 = () => store.apps.get('app1')!;

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

describe('AppNotesService', () => {
  it('starts with the default headings and nothing to copy', () => {
    expect(service.view(app1())).toEqual({ notes: { appId: 'app1', body: emptyAppNotesBody(), updatedAt: 0, sourceChatId: null, mirroredAt: null }, mirror: { state: 'nothing' } });
  });

  it('files a fact where the model says, replacing the line it names, and copies the notes to Collectives', async () => {
    service.save(app1(), '## Build\n\n## VM / workers\n- Builds run on vm-build-01\n');
    respond = () => reply('{"section":"VM / workers","replaces":"- Builds run on vm-build-01"}');
    const saved = await service.addFact(app1(), 'Builds run on vm-build-02', null, null);
    expect(saved.fact).toMatchObject({ section: 'VM / workers', line: '- Builds run on vm-build-02', replaced: '- Builds run on vm-build-01' });
    expect(saved.notes.body).toBe('## Build\n\n## VM / workers\n- Builds run on vm-build-02\n');
    expect(requests[0]!.purpose).toBe('utility');
    expect(requests[0]!.tools).toEqual([]);

    await service.idle();
    const page = fake.data.pages.find((p) => p.title === 'Notes')!;
    expect(fake.data.pages.find((p) => p.id === page.parentId)!.title).toBe('OtherBench');
    expect(page.text).toBe(`${APP_NOTES_MIRROR_BANNER}\n\n## Build\n\n## VM / workers\n- Builds run on vm-build-02\n`);
    expect(service.view(app1()).mirror).toMatchObject({ state: 'mirrored', url: 'https://nc.example/index.php/apps/collectives/Otherworld%20Dev/Products/OtherBench/Notes' });
  });

  it('files under the given heading, or Other, when the model fails', async () => {
    respond = () => reply('no idea');
    expect((await service.addFact(app1(), 'a', 'Release', null)).fact.section).toBe('Release');
    respond = () => [{ type: 'error', error: { message: 'down' } } as EngineEvent];
    expect((await service.addFact(app1(), 'b', null, null)).fact.section).toBe('Other');
  });

  it('edits, moves and takes back a fact', async () => {
    service.save(app1(), '## Build\n- old\n\n## Release\n');
    respond = () => reply('{"section":"Build","replaces":"- old"}');
    const { fact } = await service.addFact(app1(), 'new', null, null);
    expect(service.undoFact(app1(), fact.line, fact.section, fact.replaced).notes.body).toBe('## Build\n- old\n\n## Release\n');
    expect(service.editFact(app1(), '- old', 'older').notes.body).toContain('- older');
    expect(service.moveFact(app1(), '- older', 'Release').notes.body).toBe('## Build\n\n## Release\n- older\n');
  });

  it('keeps the save when Collectives fails, says why, and catches up on the next sweep', async () => {
    fake.failOn = { call: 'collectives', error: new NextcloudError('nextcloud-unreachable', "Couldn't reach Nextcloud.") };
    service.save(app1(), '## Build\n- x\n');
    await service.idle();
    expect(store.appNotes.get('app1')!.body).toBe('## Build\n- x\n');
    expect(service.view(app1()).mirror).toMatchObject({ state: 'failed', error: "Couldn't reach Nextcloud." });

    fake.failOn = null;
    await service.sweep();
    expect(service.view(app1()).mirror.state).toBe('mirrored');
    expect(fake.data.pages.find((p) => p.title === 'Notes')!.text).toContain('- x');
  });

  it("doesn't copy when Nextcloud is off, not set up, or the app has no wiki page", async () => {
    store.settings.update({ nextcloudEnabled: false });
    expect(service.view(app1()).mirror).toEqual({ state: 'off' });
    store.settings.update({ nextcloudEnabled: true });
    expect(service.view(store.apps.get('app2')!).mirror).toEqual({ state: 'no-page' });
    service.save(store.apps.get('app2')!, '## Build\n- y\n');

    nextcloudOff = new CodeRouteError(409, 'nextcloud-not-configured', 'not set up');
    service.save(app1(), '## Build\n- x\n');
    await service.idle();
    expect(service.view(app1()).mirror).toEqual({ state: 'not-configured' });
    expect(fake.calls).toEqual([]);
  });

  it('restores a version, only of its own app', () => {
    service.save(app1(), 'one');
    service.save(app1(), 'two');
    const first = store.appNotes.versions('app1')[1]!;
    expect(service.restore(app1(), first.id)!.notes.body).toBe('one');
    expect(service.restore(store.apps.get('app2')!, first.id)).toBeNull();
  });
});

describe('/api/apps/:id/notes', () => {
  it('reads, saves and refuses notes over the cap', async () => {
    const got = (await (await send('GET', '/api/apps/app1/notes')).json()) as { notes: { body: string } };
    expect(got.notes.body).toBe(emptyAppNotesBody());
    expect((await send('PUT', '/api/apps/app1/notes', { body: '## Build\n- z\n' })).status).toBe(200);
    expect(store.appNotes.get('app1')!.body).toBe('## Build\n- z\n');
    expect((await send('PUT', '/api/apps/app1/notes', { body: 'x'.repeat(12_001) })).status).toBe(400);
    expect((await send('GET', '/api/apps/nope/notes')).status).toBe(404);
  });

  it('files a fact, naming its chat only when the chat is on the app', async () => {
    store.chats.create({ id: 'c1', title: 't', appId: 'app1' } as never);
    const res = await send('POST', '/api/apps/app1/notes/facts', { text: 'Use vm-build-02', chatId: 'c1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fact: { section: string } };
    expect(body.fact.section).toBe('VM / workers');
    expect(store.appNotes.get('app1')!.sourceChatId).toBe('c1');
    await send('POST', '/api/apps/app1/notes/facts', { text: 'Other one', chatId: 'not-mine' });
    expect(store.appNotes.get('app1')!.sourceChatId).toBeNull();
    expect((await send('POST', '/api/apps/app1/notes/facts', { text: '' })).status).toBe(400);
    expect((await send('POST', '/api/apps/app1/notes/facts', { text: 'x'.repeat(501) })).status).toBe(400);
  });

  it('lists versions and restores one', async () => {
    await send('PUT', '/api/apps/app1/notes', { body: 'one' });
    await send('PUT', '/api/apps/app1/notes', { body: 'two' });
    const versions = (await (await send('GET', '/api/apps/app1/notes/versions')).json()) as { id: string }[];
    expect(versions).toHaveLength(2);
    expect((await send('POST', `/api/apps/app1/notes/versions/${versions[1]!.id}/restore`)).status).toBe(200);
    expect(store.appNotes.get('app1')!.body).toBe('one');
    expect((await send('POST', `/api/apps/app2/notes/versions/${versions[1]!.id}/restore`)).status).toBe(404);
  });
});
