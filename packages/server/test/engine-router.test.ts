import { describe, expect, it } from 'vitest';
import { FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import type { EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { Connection } from '@otherbench/core/types/config.js';
import { MAIN_ACCOUNT, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import { endpointModelLister, RoutingChatEngine } from '../src/engine-router.js';

const conn = (kind: Connection['kind'], baseUrl: string | null = null): Connection => ({ id: 'c', name: 'n', kind, baseUrl, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });

describe('RoutingChatEngine', () => {
  it('routes claude_code to the Claude Code engine and everything else to the AI SDK engine', async () => {
    const aisdk = new FakeChatEngine([{ type: 'text-delta', text: 'aisdk' }]);
    const cc = new FakeChatEngine([{ type: 'text-delta', text: 'cc' }]);
    aisdk.models = [{ modelId: 'a', displayName: 'a', contextWindow: null, supportsVision: null, supportsTools: null }];
    cc.models = [{ modelId: 'sonnet', displayName: 'Sonnet', contextWindow: null, supportsVision: true, supportsTools: true }];
    const router = new RoutingChatEngine(aisdk, cc);
    expect((await router.listModels(conn('claude_code'), null))[0]!.modelId).toBe('sonnet');
    expect((await router.listModels(conn('ollama'), null))[0]!.modelId).toBe('a');
  });
  it('lists commands from the Claude Code engine only, and none for other connections', async () => {
    const row = { name: 'deploy', description: 'd', argumentHint: '', aliases: [] };
    const asked: string[] = [];
    const cc = new FakeChatEngine([]);
    cc.listCommands = async (i) => { asked.push(i.chatId); return [row]; };
    const router = new RoutingChatEngine(new FakeChatEngine([]), cc);
    const profile = (kind: Connection['kind']) => ({ connection: conn(kind) }) as never;
    expect(await router.listCommands({ chatId: 'c1', profile: profile('claude_code'), workspaceRoot: null })).toEqual([row]);
    expect(await router.listCommands({ chatId: 'c2', profile: profile('ollama'), workspaceRoot: null })).toEqual([]);
    expect(asked).toEqual(['c1']);
  });
  it('hands notes to the Claude Code engine, and says no when no engine takes them', async () => {
    const cc = new FakeChatEngine([]);
    const sent: string[] = [];
    cc.sendToReply = async (messageId, note) => { sent.push(`${messageId}:${note.id}`); return true; };
    cc.withdrawNote = async (noteId) => noteId === 'n1';
    const router = new RoutingChatEngine(new FakeChatEngine([]), cc);
    expect(await router.sendToReply('r1', { id: 'n1', text: 'hi', attachments: [] })).toBe(true);
    expect(sent).toEqual(['r1:n1']);
    expect(await router.withdrawNote('n1')).toBe(true);
    expect(await router.withdrawNote('n2')).toBe(false);
    // An engine that takes notes but can't say which it has is taken to have them.
    expect(router.knowsNote('n2')).toBe(true);
    cc.knowsNote = (noteId) => noteId === 'n1';
    expect([router.knowsNote('n1'), router.knowsNote('n2')]).toEqual([true, false]);

    const none = new RoutingChatEngine(new FakeChatEngine([]), new FakeChatEngine([]));
    expect(await none.sendToReply('r1', { id: 'n1', text: 'hi', attachments: [] })).toBe(false);
    expect(await none.withdrawNote('n1')).toBe(false);
    expect(none.knowsNote('n1')).toBe(false);
  });
  describe('the Claude account a request runs on', () => {
    const VH: ClaudeAccountRef = { slug: 'vh', name: 'VH', configDir: '/home/adam/.claude-vh' };
    const finished: EngineEvent = { type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
    const request = (connection: Connection, extra: Partial<EngineRequest> = {}): EngineRequest =>
      ({ profile: { connection }, messages: [], tools: [], signal: new AbortController().signal, chatId: 'c1', messageId: 'm1', workspaceRoot: null, purpose: 'title', ...extra }) as EngineRequest;
    const drain = async (events: AsyncIterable<EngineEvent>) => {
      for await (const _ of events) void _;
    };

    it("gives a Claude-login request with no account the default account's ref", async () => {
      const cc = new FakeChatEngine([finished]);
      const router = new RoutingChatEngine(new FakeChatEngine([]), cc, () => VH);
      await drain(router.stream(request(conn('claude_code'))));
      expect(cc.requests[0]!.claudeAccount).toBe(VH);
    });

    it('leaves an endpoint request, and one that already names an account, as they are', async () => {
      const cc = new FakeChatEngine([finished]);
      const router = new RoutingChatEngine(new FakeChatEngine([]), cc, () => VH);
      await drain(router.stream(request(conn('claude_code', 'http://localhost:11434'))));
      await drain(router.stream(request(conn('claude_code'), { claudeAccount: MAIN_ACCOUNT })));
      expect(cc.requests.map((r) => r.claudeAccount)).toEqual([undefined, MAIN_ACCOUNT]);
      expect('claudeAccount' in cc.requests[0]!).toBe(false);
    });

    it("reads an account's plan usage through the Claude Code engine", async () => {
      const seen: (ClaudeAccountRef | undefined)[] = [];
      const cc = Object.assign(new FakeChatEngine([]), {
        planUsage: async (_conn: Connection, account?: ClaudeAccountRef) => {
          seen.push(account);
          return null;
        },
      });
      await new RoutingChatEngine(new FakeChatEngine([]), cc).planUsage(conn('claude_code'), VH);
      expect(seen).toEqual([VH]);
    });
  });

  it('lists endpoint models through the Ollama path with /v1 appended', async () => {
    const aisdk = new FakeChatEngine([]);
    const seen: Connection[] = [];
    aisdk.listModels = async (c) => { seen.push(c); return []; };
    await endpointModelLister(aisdk)(conn('claude_code', 'http://localhost:11434/'), null);
    expect(seen[0]).toMatchObject({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1' });
  });
});
