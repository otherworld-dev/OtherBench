import { describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import { RoutingChatEngine } from '../src/engine-router.js';

const ws = '/ws';
const usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };

const profile: ResolvedProfile = {
  id: 'p1',
  name: 'CC',
  description: null,
  colour: null,
  connectionId: 'conn-cc',
  modelId: 'sonnet',
  systemPrompt: null,
  params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
  isDefault: false,
  archivedAt: null,
  connection: { id: 'conn-cc', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
  apiKey: null,
  model: null,
};

describe('claude_code turns through the routing engine', () => {
  it('persists the session on the assistant message and offers it to the next turn', async () => {
    const store = new InMemoryStore();
    const aisdk = new FakeChatEngine([]);
    // Lookup result captured at request time: later turns re-persist the same
    // session id, which would change the answer once they complete.
    const lookups: (string | null)[] = [];
    const cc = new FakeChatEngine((req) => {
      lookups.push(req.latestMessageForSession!('s1'));
      return [
        { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: 's1', backend: 'claude', cwd: ws } },
        { type: 'finish', usage, finishReason: 'stop' },
      ];
    });
    const runner = new TurnRunner(store, new RoutingChatEngine(aisdk, cc));
    const chat = store.chats.create({ id: 'chat-1', title: 't', profileId: null, headMessageId: null, workspaceRoot: ws, pinned: false, archivedAt: null });

    const first = await runner.run({ chatId: chat.id, parentId: null, userParts: [{ type: 'text', text: 'one' }], profiles: [profile] });
    const firstId = first.assistantMessageIds[0]!;
    await vi.waitFor(() => expect(store.messages.get(firstId)!.status).toBe('complete'));
    expect(store.messages.get(firstId)!.engineMeta?.sessionId).toBe('s1');
    expect(aisdk.requests).toHaveLength(0);

    await runner.run({ chatId: chat.id, parentId: firstId, userParts: [{ type: 'text', text: 'two' }], profiles: [profile] });
    await vi.waitFor(() => expect(cc.requests).toHaveLength(2));
    expect(lookups).toEqual([null, firstId]);
  });
});
