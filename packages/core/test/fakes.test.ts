import { describe, it, expect } from 'vitest';
import type { EngineEvent, EngineRequest } from '../src/ports/chat-engine.js';
import type { ToolSpec } from '../src/ports/tool-provider.js';
import type { ResolvedProfile } from '../src/types/config.js';
import { FakeChatEngine, InMemoryStore, FakeSecretStore, FakeToolProvider } from '../src/testing/fakes.js';
import { runSecretStoreContract } from '../src/testing/secret-store-contract.js';
import { runToolProviderContract } from '../src/testing/tool-provider-contract.js';
import { runStoreContract } from '../src/testing/store-contract.js';

function makeResolvedProfile(over: Partial<ResolvedProfile> & { id: string }): ResolvedProfile {
  return {
    name: 'Test Profile',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    connection: {
      id: 'conn-1',
      name: 'Test Connection',
      kind: 'mock',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    },
    apiKey: null,
    model: null,
    ...over,
  };
}

function makeRequest(over: Partial<EngineRequest> = {}): EngineRequest {
  return {
    profile: makeResolvedProfile({ id: 'profile-1' }),
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    chatId: 'chat-1',
    messageId: 'msg-req-1',
    ...over,
  };
}

async function drain(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('FakeChatEngine', () => {
  it('yields exactly the scripted events for a fixed EngineEvent[] script', async () => {
    const script: EngineEvent[] = [
      { type: 'text-delta', text: 'Hello, ' },
      { type: 'text-delta', text: 'world!' },
      { type: 'finish', usage: { tokensIn: 5, tokensOut: 5, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' },
    ];
    const engine = new FakeChatEngine(script);

    const events = await drain(engine.stream(makeRequest()));

    expect(events).toEqual(script);
  });

  it('stops yielding immediately and yields nothing further once the signal is aborted mid-stream', async () => {
    const script: EngineEvent[] = [
      { type: 'text-delta', text: 'a' },
      { type: 'text-delta', text: 'b' },
      { type: 'text-delta', text: 'c' },
      { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' },
    ];
    const engine = new FakeChatEngine(script);
    const controller = new AbortController();
    const iterator = engine.stream(makeRequest({ signal: controller.signal }))[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: { type: 'text-delta', text: 'a' } });

    controller.abort();

    const second = await iterator.next();
    expect(second.done).toBe(true);
  });

  it('records every EngineRequest it receives on .requests, in call order', async () => {
    const engine = new FakeChatEngine([]);
    const reqA = makeRequest({ profile: makeResolvedProfile({ id: 'profile-a' }) });
    const reqB = makeRequest({ profile: makeResolvedProfile({ id: 'profile-b' }) });

    await drain(engine.stream(reqA));
    await drain(engine.stream(reqB));

    expect(engine.requests).toEqual([reqA, reqB]);
  });

  it('supports a script function that varies output per request', async () => {
    const engine = new FakeChatEngine((req) =>
      req.profile.id === 'profile-a'
        ? [{ type: 'text-delta', text: 'A' }]
        : [{ type: 'text-delta', text: 'B' }]
    );

    const eventsA = await drain(engine.stream(makeRequest({ profile: makeResolvedProfile({ id: 'profile-a' }) })));
    const eventsB = await drain(engine.stream(makeRequest({ profile: makeResolvedProfile({ id: 'profile-b' }) })));

    expect(eventsA).toEqual([{ type: 'text-delta', text: 'A' }]);
    expect(eventsB).toEqual([{ type: 'text-delta', text: 'B' }]);
  });

  it('does not yield anything when the signal is already aborted before iteration starts', async () => {
    const engine = new FakeChatEngine([{ type: 'text-delta', text: 'never' }]);
    const controller = new AbortController();
    controller.abort();

    const events = await drain(engine.stream(makeRequest({ signal: controller.signal })));

    expect(events).toEqual([]);
  });
});

describe('FakeSecretStore', () => {
  it('returns null for a ref that was never set', async () => {
    const secrets = new FakeSecretStore();
    expect(await secrets.get('missing')).toBeNull();
  });

  it('round-trips set -> get, and delete removes it', async () => {
    const secrets = new FakeSecretStore();
    await secrets.set('api-key-1', 'sk-abc123');

    expect(await secrets.get('api-key-1')).toBe('sk-abc123');

    await secrets.delete('api-key-1');
    expect(await secrets.get('api-key-1')).toBeNull();
  });

  it('set overwrites an existing value for the same ref', async () => {
    const secrets = new FakeSecretStore();
    await secrets.set('ref', 'first');
    await secrets.set('ref', 'second');
    expect(await secrets.get('ref')).toBe('second');
  });
});

describe('FakeToolProvider', () => {
  it('offers its subagent tool only when the policy turns sub-agents on', async () => {
    const subagent: ToolSpec = { name: 'subagent', description: '', parameters: {}, risk: 'read', source: 'subagent', execute: async () => 'ok' };
    const provider = new FakeToolProvider({ tools: [subagent] });
    const base = { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const };
    expect((await provider.listTools(base)).map((t) => t.name)).toEqual([]);
    expect((await provider.listTools({ ...base, subagents: true })).map((t) => t.name)).toEqual(['subagent']);
  });
});

// The shared behavioural contract (packages/core/src/testing/store-contract.ts) is
// authored here and run against InMemoryStore now, so it cannot drift from what
// Task 9's real SQLite adapter will be held to later -- that is the whole point of
// having one exported suite instead of separate ad hoc tests per implementation.
runStoreContract('InMemoryStore', () => new InMemoryStore());

runSecretStoreContract('FakeSecretStore', () => new FakeSecretStore());
runToolProviderContract('FakeToolProvider', ({ mcpServers }) => new FakeToolProvider({ mcpServers }));
