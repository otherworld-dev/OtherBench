import { beforeEach, describe, expect, it } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { BODY_NOT_JSON, BODY_NOT_OBJECT, readJsonBody } from '../../src/validation.js';

const of = (text: string) => ({ req: { text: async () => text } });

describe('readJsonBody', () => {
  it('returns the parsed object', async () => {
    expect(await readJsonBody(of('{"name":"Alpha","n":1}'))).toEqual({ name: 'Alpha', n: 1 });
    expect(await readJsonBody(of(' {} \n'))).toEqual({});
  });

  it('reads no body at all, or only white space, as an empty object', async () => {
    expect(await readJsonBody(of(''))).toEqual({});
    expect(await readJsonBody(of(' \r\n\t'))).toEqual({});
  });

  it.each(['{', '{"name": }', "{'name': 'x'}", 'name=Alpha', '{"a":1}{"b":2}', 'undefined'])('refuses %j as not valid JSON, with a 400', async (text) => {
    const err = await readJsonBody(of(text)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(400);
    expect((err as HTTPException).message).toBe(BODY_NOT_JSON);
  });

  it.each(['null', '[]', '[{"name":"Alpha"}]', '"name"', '12', 'true'])('refuses %j as not an object, with a 400', async (text) => {
    const err = await readJsonBody(of(text)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(400);
    expect((err as HTTPException).message).toBe(BODY_NOT_OBJECT);
  });
});

let container: Container;

beforeEach(() => {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'profile-1', name: 'Mock', description: null, colour: null, connectionId: 'conn-1', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  store.projects.create({ id: 'proj-1', name: 'Alpha', description: '', instructions: '', workspace: null, folders: [], defaultProfileId: null, parentId: null, sortOrder: 0 });
  store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  store.messages.create({ id: 'm1', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
});

/** Sends `raw` as the body exactly as given, with the JSON content type the web client always sends. `undefined` sends no body. */
function send(method: string, path: string, raw: string | undefined): Promise<Response> {
  return Promise.resolve(createApp(container).request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(raw === undefined ? {} : { body: raw }) }));
}

const MALFORMED = ['{"name": "Beta"', 'name=Beta', '{"name": Beta}'];
const NOT_OBJECTS = ['null', '["Beta"]', '"Beta"'];

interface Sample {
  what: string;
  method: string;
  path: string;
  valid: string;
  validStatus: number;
  /** What a request with no body gets: its status, and its error when it is refused. */
  empty: { status: number; error?: string };
  /** Something a refused request must have left alone. */
  untouched: () => unknown;
}

const SAMPLES: Sample[] = [
  {
    what: 'a create (POST /api/projects)',
    method: 'POST',
    path: '/api/projects',
    valid: '{"name":"Beta"}',
    validStatus: 201,
    // The field it needs is what is named, not the JSON.
    empty: { status: 400, error: '"name" is required and must be a string.' },
    untouched: () => container.store.projects.list().map((p) => p.name),
  },
  {
    what: 'a patch (PATCH /api/projects/:id)',
    method: 'PATCH',
    path: '/api/projects/proj-1',
    valid: '{"name":"Beta"}',
    validStatus: 200,
    // Every field is optional: nothing changes.
    empty: { status: 200 },
    untouched: () => container.store.projects.get('proj-1'),
  },
  {
    what: 'a POST with one field (POST /api/chats/:id/head)',
    method: 'POST',
    path: '/api/chats/chat-1/head',
    valid: '{"messageId":"m1"}',
    validStatus: 200,
    empty: { status: 400, error: '"messageId" is required and must be a non-empty string.' },
    untouched: () => container.store.chats.get('chat-1')!.headMessageId,
  },
];

describe.each(SAMPLES)('$what', (sample) => {
  it('takes a valid body', async () => {
    const res = await send(sample.method, sample.path, sample.valid);
    expect(res.status).toBe(sample.validStatus);
  });

  it.each([['no body at all', undefined], ['an empty body', ''], ['only white space', ' \n']])('reads %s as an empty object', async (_what, raw) => {
    const before = sample.untouched();
    const res = await send(sample.method, sample.path, raw);
    expect(res.status).toBe(sample.empty.status);
    if (sample.empty.error !== undefined) {
      expect(await res.json()).toEqual({ error: sample.empty.error });
      expect(sample.untouched()).toEqual(before);
    }
  });

  it.each(MALFORMED)('refuses %j as not valid JSON and changes nothing', async (raw) => {
    const before = sample.untouched();
    const res = await send(sample.method, sample.path, raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: BODY_NOT_JSON });
    expect(sample.untouched()).toEqual(before);
  });

  it.each(NOT_OBJECTS)('refuses %j as not an object and changes nothing', async (raw) => {
    const before = sample.untouched();
    const res = await send(sample.method, sample.path, raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: BODY_NOT_OBJECT });
    expect(sample.untouched()).toEqual(before);
  });
});
