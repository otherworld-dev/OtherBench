import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { OWN_COMMANDS, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const WARNING = "Couldn't load this chat's own commands.";
const REVIEW: CommandRow = { name: 'code-review', description: 'Review the diff', argumentHint: '', aliases: ['review'] };

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
  store.connections.create({ id: 'conn-cc', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'p-cc', name: 'Claude', description: null, colour: null, connectionId: 'conn-cc', modelId: 'claude', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'p-cc', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function withListCommands(listCommands: NonNullable<ChatEngine['listCommands']>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(listCommands);
  container.engine = { ...container.engine, listCommands: fn } as ChatEngine;
  return fn;
}

function get(path: string) {
  return createApp(container).request(path);
}

describe('GET /api/chats/:id/commands', () => {
  it("OWN_COMMANDS first, then the engine's rows", async () => {
    const list = withListCommands(async () => [REVIEW]);

    const res = await get('/api/chats/chat-1/commands?profileId=p-cc');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [...OWN_COMMANDS, REVIEW] });
    expect(list).toHaveBeenCalledTimes(1);
    const input = list.mock.calls[0]![0] as { chatId: string; profile: { id: string }; workspaceRoot: string | null };
    expect(input).toMatchObject({ chatId: 'chat-1', profile: { id: 'p-cc' }, workspaceRoot: null });
  });

  it("uses the chat's own profile when none is named", async () => {
    const list = withListCommands(async () => [REVIEW]);

    const res = await get('/api/chats/chat-1/commands');

    expect(res.status).toBe(200);
    expect(((list.mock.calls[0]![0]) as { profile: { id: string } }).profile.id).toBe('p-cc');
  });

  it("drops an engine row that repeats one of OtherBench's own", async () => {
    withListCommands(async () => [{ name: 'compact', description: 'Claude Code compact', argumentHint: '', aliases: [] }, REVIEW]);

    const res = await get('/api/chats/chat-1/commands?profileId=p-cc');

    expect(await res.json()).toEqual({ commands: [...OWN_COMMANDS, REVIEW] });
  });

  it('engine failure gives own commands and the warning copy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    withListCommands(async () => {
      throw new Error('process died');
    });

    const res = await get('/api/chats/chat-1/commands?profileId=p-cc');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [...OWN_COMMANDS], warning: WARNING });
  });

  it('an engine that takes over 3 seconds gives own commands and the warning copy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    withListCommands(() => new Promise<CommandRow[]>(() => {}));

    const pending = Promise.resolve(get('/api/chats/chat-1/commands?profileId=p-cc'));
    await vi.advanceTimersByTimeAsync(2999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [...OWN_COMMANDS], warning: WARNING });
  });

  it('an engine without a command list gives own commands alone', async () => {
    const res = await get('/api/chats/chat-1/commands?profileId=p-cc');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [...OWN_COMMANDS] });
  });

  it('unknown chat 404', async () => {
    const res = await get('/api/chats/nope/commands?profileId=p-cc');
    expect(res.status).toBe(404);
  });

  it('unknown profile 404', async () => {
    const res = await get('/api/chats/chat-1/commands?profileId=nope');
    expect(res.status).toBe(404);
  });
});
