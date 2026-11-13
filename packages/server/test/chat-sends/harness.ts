import { expect, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { resolveWorkspace } from '@otherbench/core/domain/workspace.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { SendOutcome, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { ChatSendService, type ChatSendDeps } from '../../src/chat-sends/service.js';
import { collectMessageTree, createAppChat } from '../../src/routes/chats.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { startTurn, type TurnStartDeps } from '../../src/turn-start.js';

/** A ChatEngine driven by hand per message id (as in schedule/service.test.ts), recording every request. */
export function manualEngine(): { engine: ChatEngine; push: (messageId: string, event: EngineEvent | null) => void; requests: EngineRequest[] } {
  interface Channel {
    queued: (EngineEvent | null)[];
    waiters: ((event: EngineEvent | null) => void)[];
  }
  const channels = new Map<string, Channel>();
  const requests: EngineRequest[] = [];
  const channelFor = (messageId: string): Channel => {
    let ch = channels.get(messageId);
    if (!ch) {
      ch = { queued: [], waiters: [] };
      channels.set(messageId, ch);
    }
    return ch;
  };
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      requests.push(req);
      const ch = channelFor(req.messageId);
      while (true) {
        if (req.signal.aborted) return;
        const event = await new Promise<EngineEvent | null>((resolve) => {
          if (ch.queued.length > 0) {
            resolve(ch.queued.shift() as EngineEvent | null);
            return;
          }
          const onAbort = (): void => resolve(null);
          req.signal.addEventListener('abort', onAbort, { once: true });
          ch.waiters.push((e) => {
            req.signal.removeEventListener('abort', onAbort);
            resolve(e);
          });
        });
        if (event === null || req.signal.aborted) return;
        yield event;
        if (event.type === 'finish' || event.type === 'error') return;
      }
    },
    listModels: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
  };
  const push = (messageId: string, event: EngineEvent | null): void => {
    const ch = channelFor(messageId);
    const waiter = ch.waiters.shift();
    if (waiter) waiter(event);
    else ch.queued.push(event);
  };
  return { engine, push, requests };
}

export const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * One machine for ChatSendService tests: a store (its own node id), a hand-driven engine, a turn runner and an event
 * bus, a profile `p1`, and helpers that start, finish and send from replies. Two harnesses with different node ids
 * stand in for two paired machines.
 */
export class Harness {
  readonly store: InMemoryStore;
  readonly engine = manualEngine();
  readonly runner: TurnRunner;
  readonly bus = new AppEventBus();
  readonly events: AppEvent[] = [];
  readonly turnDeps: TurnStartDeps;
  readonly waitingNotes = new Set<string>();
  service!: ChatSendService;

  constructor(selfNodeId = 'node-self') {
    this.store = new InMemoryStore(selfNodeId);
    this.runner = new TurnRunner(this.store, this.engine.engine);
    this.bus.attach(this.runner, this.store);
    this.bus.subscribe((e) => this.events.push(e));
    this.turnDeps = { store: this.store, turnRunner: this.runner, streamRegistry: new StreamRegistry(this.runner, this.store), events: this.bus };
    this.store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
    this.store.profiles.create({
      id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', artifacts: false, recall: false },
      isDefault: true, archivedAt: null,
    });
  }

  resolveP = async (id: string): Promise<ResolvedProfile> => {
    const p = this.store.profiles.get(id);
    if (!p) throw new Error(`Profile "${id}" not found.`);
    return { ...p, connection: this.store.connections.get(p.connectionId)!, apiKey: null, model: null };
  };

  deps(over: Partial<ChatSendDeps> = {}): ChatSendDeps {
    const store = this.store;
    return {
      store,
      turnRunner: this.runner,
      startTurn: (input) => startTurn(this.turnDeps, input),
      resolveProfile: this.resolveP,
      resolveWorkspace: (ws, on) => resolveWorkspace(ws, on ?? store.nodes.self().id, store.locations.allPaths(), () => true),
      isChatBusy: (chatId) => this.bus.runningTurns().some((t) => t.chatId === chatId),
      hasWaitingNotes: (chatId) => this.waitingNotes.has(chatId),
      createAppChat: (app, title, id) => createAppChat({ store }, app, title, id),
      emit: (e) => this.bus.emit(e),
      ...over,
    };
  }

  /** Makes this machine's service (not started). */
  build(over: Partial<ChatSendDeps> = {}): ChatSendService {
    this.service = new ChatSendService(this.deps(over));
    return this.service;
  }

  addChat(id: string, over: Record<string, unknown> = {}): void {
    this.store.chats.create({ id, title: `Chat ${id}`, profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, ...over });
  }

  /** Starts a turn in `chatId` with `text` and returns its reply's id (still streaming). */
  async reply(chatId: string, text = 'hello'): Promise<string> {
    const chat = this.store.chats.get(chatId)!;
    const tip = chat.headMessageId === null ? null : this.store.messages.children(chat.headMessageId).at(-1)?.id ?? chat.headMessageId;
    const result = await startTurn(this.turnDeps, { chatId, parentId: tip, userParts: [{ type: 'text', text }], profiles: [await this.resolveP(chat.profileId)] });
    return result.assistantMessageIds[0]!;
  }

  async finish(replyId: string, text: string): Promise<void> {
    this.engine.push(replyId, { type: 'text-delta', text });
    this.engine.push(replyId, FINISH);
    await vi.waitFor(() => expect(this.store.messages.get(replyId)?.status).toBe('complete'));
    await flush();
    await this.service.idle();
  }

  ctxFor(chatId: string, messageId: string, over: Partial<ToolContext> = {}): ToolContext {
    return { chatId, messageId, profileId: 'p1', workspaceRoot: null, signal: new AbortController().signal, ...over };
  }

  async send(chatId: string, messageId: string, targets: SendTarget[]): Promise<SendOutcome> {
    const out = await this.service.send(this.ctxFor(chatId, messageId), targets);
    await flush();
    await this.service.idle();
    return out;
  }

  /** The newest reply in a chat. */
  latestReply(chatId: string): string | undefined {
    return collectMessageTree(this.store, chatId)
      .filter((m) => m.role === 'assistant')
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1)?.id;
  }
}

export const refusal = (out: SendOutcome): string => ('refused' in out ? out.refused : '');
