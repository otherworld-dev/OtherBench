import { describe, expect, it, vi } from 'vitest';
import type { ChatEngine, EngineEvent, EngineRequest } from '../src/ports/chat-engine.js';
import type { ToolSpec } from '../src/ports/tool-provider.js';
import type { Connection, ModelInfo, Profile, ResolvedProfile, ToolPolicy } from '../src/types/config.js';
import { FakeToolProvider, InMemoryStore } from '../src/testing/fakes.js';
import { TurnRunner, type TurnEvent } from '../src/domain/turn.js';
import { toolContextFor } from '../src/domain/tool-context.js';
import { runSubagentTool, SUBAGENT_TOOL_PARAMETERS } from '../src/domain/subagent.js';
import type { SubagentPart } from '../src/domain/parts.js';

const USAGE = { tokensIn: 10, tokensOut: 5, tokensCached: 0, tokensReasoning: 0 };
const finish: EngineEvent = { type: 'finish', usage: USAGE, finishReason: 'stop' };

const readFile: ToolSpec = { name: 'read_file', description: '', parameters: {}, risk: 'read', source: 'fs', execute: async () => 'text' };
const artifact: ToolSpec = { name: 'artifact', description: '', parameters: {}, risk: 'read', source: 'artifact', execute: async () => null };
const subagentTool: ToolSpec = { name: 'subagent', description: 'Start a sub-agent.', parameters: SUBAGENT_TOOL_PARAMETERS as unknown as Record<string, unknown>, risk: 'read', source: 'subagent', execute: runSubagentTool };

function connection(id: string, over: Partial<Connection> = {}): Connection {
  return { id, name: id, kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null, ...over };
}
const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'read', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', subagents: true, ...over });
function model(id: string, connectionId: string): ModelInfo {
  return { id, connectionId, modelId: `${id}-name`, displayName: id, source: 'manual', supportsVision: false, supportsTools: true, supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: 1, priceOutPer1m: 2, priceCachedPer1m: null, currency: 'USD' };
}

function seeded(): InMemoryStore {
  const store = new InMemoryStore('node-laptop');
  store.connections.create(connection('mock'));
  store.connections.create(connection('cc', { kind: 'claude_code' }));
  store.models.create(model('m-main', 'mock'));
  store.models.create(model('m-cheap', 'mock'));
  const row = (id: string, name: string, connectionId: string, modelId: string, over: Partial<Profile> = {}): Profile =>
    ({ id, name, description: null, colour: null, connectionId, modelId, systemPrompt: null, params: {}, toolPolicy: policy(), isDefault: false, archivedAt: null, ...over });
  store.profiles.create(row('p-main', 'Main', 'mock', 'm-main-name', { systemPrompt: 'You are Main.' }));
  store.profiles.create(row('p-cheap', 'Cheap', 'mock', 'm-cheap-name'));
  store.profiles.create(row('p-cc', 'Coder', 'cc', 'sonnet'));
  store.locations.create({ id: 'nc', name: 'Nextcloud' });
  store.locations.setPath({ locationId: 'nc', nodeId: 'node-laptop', path: '/home/adam/nc' });
  store.chats.create({
    id: 'chat-1', title: 'T', profileId: 'p-main', headMessageId: null, pinned: false, archivedAt: null,
    workspace: { kind: 'location', locationId: 'nc', subpath: 'proj' },
    folders: [{ workspace: { kind: 'location', locationId: 'nc', subpath: 'notes' }, access: 'read' }],
  });
  return store;
}

function resolved(store: InMemoryStore, id: string): ResolvedProfile {
  const p = store.profiles.get(id)!;
  return { ...p, connection: store.connections.get(p.connectionId)!, apiKey: null, model: store.models.list(p.connectionId).find((m) => m.modelId === p.modelId) ?? null };
}

/**
 * The parent (no `req.subagent`) calls the offered subagent tool once per
 * entry in `calls`, all at once, then finishes; a sub-agent's request is
 * answered by `child`.
 */
function scriptedEngine(calls: unknown[], child: (req: EngineRequest) => AsyncIterable<EngineEvent>, parentTail: EngineEvent[] = [finish]): ChatEngine & { requests: EngineRequest[]; results: unknown[] } {
  const requests: EngineRequest[] = [];
  const results: unknown[] = [];
  return {
    requests,
    results,
    async *stream(req) {
      requests.push(req);
      if (req.subagent) {
        yield* child(req);
        return;
      }
      const tool = req.tools.find((t) => t.name === 'subagent');
      if (tool) {
        for (const [i, args] of calls.entries()) yield { type: 'tool-call', id: `call-${i + 1}`, name: 'subagent', args };
        const out = await Promise.all(calls.map((args, i) => tool.execute(args, toolContextFor(req, req.signal, `call-${i + 1}`))));
        results.push(...out);
        for (const [i, result] of out.entries()) yield { type: 'tool-result', id: `call-${i + 1}`, name: 'subagent', result, isError: typeof result !== 'string' };
      }
      yield* parentTail;
    },
    async listModels() {
      return [];
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 0 };
    },
  };
}

async function* says(text: string): AsyncIterable<EngineEvent> {
  yield { type: 'text-delta', text };
  yield finish;
}

async function runTurn(runner: TurnRunner, store: InMemoryStore, profile: ResolvedProfile, until: string = 'complete'): Promise<string> {
  const result = await runner.run({ chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'Split this up.' }], profiles: [profile] });
  const id = result.assistantMessageIds[0]!;
  await vi.waitFor(() => expect(store.messages.get(id)!.status).toBe(until));
  return id;
}

describe('TurnRunner with sub-agents', () => {
  const pathExists = () => true;

  it("hands the sub-agent the chosen profile, a fresh prompt, narrowed tools and the parent's chat, reply and folders", async () => {
    const store = seeded();
    const engine = scriptedEngine([{ description: 'Check notes', prompt: 'Read the notes.' }], () => says('Notes are fine.'));
    const runner = new TurnRunner(store, engine, { toolProvider: new FakeToolProvider({ tools: [readFile, artifact, subagentTool] }), pathExists });

    const id = await runTurn(runner, store, resolved(store, 'p-main'));

    const parent = engine.requests[0]!;
    const child = engine.requests[1]!;
    expect(parent.tools.map((t) => t.name).sort()).toEqual(['artifact', 'read_file', 'subagent']);
    expect(parent.subagents).toBeDefined();
    expect(child.tools.map((t) => t.name)).toEqual(['read_file']);
    expect(child.profile.id).toBe('p-main');
    expect(child.profile.systemPrompt!.startsWith('You are Main.\n\n# Working as a sub-agent')).toBe(true);
    expect(child.profile.systemPrompt).toContain('/home/adam/nc/notes (read-only)');
    expect(child.messages.map((m) => [m.role, m.parts])).toEqual([
      ['system', [{ type: 'text', text: child.profile.systemPrompt }]],
      ['user', [{ type: 'text', text: 'Read the notes.' }]],
    ]);
    expect(child).toMatchObject({ chatId: 'chat-1', messageId: id, workspaceRoot: '/home/adam/nc/proj', folders: [{ root: '/home/adam/nc/notes', access: 'read' }], subagent: { callId: 'call-1', label: 'Check notes' } });
    expect(child.subagents).toBeUndefined();
    expect(engine.results).toEqual(['Notes are fine.']);
  });

  it('stores a finished subagent part on the reply, and sends every subagent event before the terminal status', async () => {
    const store = seeded();
    const engine = scriptedEngine([{ description: 'Helper', prompt: 'Go.' }], () => says('Done.'));
    const runner = new TurnRunner(store, engine, { toolProvider: new FakeToolProvider({ tools: [subagentTool] }), pathExists });
    const events: TurnEvent[] = [];
    runner.on((e) => events.push(e));

    const id = await runTurn(runner, store, resolved(store, 'p-main'));

    const part = store.messages.get(id)!.parts.find((p): p is SubagentPart => p.type === 'subagent');
    expect(part).toMatchObject({ callId: 'call-1', label: 'Helper', status: 'complete', profileName: 'Main', modelId: 'm-main-name', usage: USAGE, parts: [{ type: 'text', text: 'Done.' }] });
    const lastSubagent = events.map((e) => e.type).lastIndexOf('subagent');
    const terminal = events.findIndex((e) => e.type === 'status' && e.status === 'complete');
    expect(lastSubagent).toBeGreaterThan(-1);
    expect(lastSubagent).toBeLessThan(terminal);
    expect(events.find((e) => e.type === 'subagent')).toMatchObject({ messageId: id, callId: 'call-1', event: { type: 'start', label: 'Helper' } });
  });

  it("writes a usage row for each sub-agent under the reply, priced at the sub-agent's own model, marked with its call id", async () => {
    const store = seeded();
    const engine = scriptedEngine([{ description: 'Helper', prompt: 'Go.', profile: 'Cheap' }], () => says('Cheap answer.'));
    const runner = new TurnRunner(store, engine, {
      toolProvider: new FakeToolProvider({ tools: [subagentTool] }),
      pathExists,
      resolveProfile: async (pid) => resolved(store, pid),
    });

    const id = await runTurn(runner, store, resolved(store, 'p-main'));

    const rows = store.usage.list('chat-1');
    const subRow = rows.find((r) => r.subagentCallId === 'call-1');
    const own = rows.find((r) => r.subagentCallId === undefined);
    expect(subRow).toMatchObject({ messageId: id, profileId: 'p-cheap', connectionId: 'mock', modelId: 'm-cheap-name', tokensIn: 10, pricingSnapshot: { priceInPer1m: 1, priceOutPer1m: 2 } });
    expect(own).toMatchObject({ messageId: id, profileId: 'p-main' });
    expect(engine.requests[1]!.profile.id).toBe('p-cheap');
  });

  it('gives a Claude Code profile no subagent tool and no host, even with the switch on', async () => {
    const store = seeded();
    const engine = scriptedEngine([], () => says('x'));
    const runner = new TurnRunner(store, engine, { toolProvider: new FakeToolProvider({ tools: [readFile, subagentTool] }), pathExists });

    await runTurn(runner, store, resolved(store, 'p-cc'));

    expect(engine.requests[0]!.tools.map((t) => t.name)).not.toContain('subagent');
    expect(engine.requests[0]!.subagents).toBeUndefined();
  });

  it("gives a model that can't use tools no subagent tool", async () => {
    const store = seeded();
    store.models.update('m-main', { supportsTools: false });
    const engine = scriptedEngine([], () => says('x'));
    const runner = new TurnRunner(store, engine, { toolProvider: new FakeToolProvider({ tools: [subagentTool] }), pathExists });
    await runTurn(runner, store, resolved(store, 'p-main'));
    expect(engine.requests[0]!.tools).toEqual([]);
    expect(engine.requests[0]!.subagents).toBeUndefined();
  });

  it('a parent stream that fails while a sub-agent runs leaves no running card, and waits for it before the terminal status', async () => {
    const store = seeded();
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const engine: ChatEngine & { requests: EngineRequest[] } = {
      requests: [],
      async *stream(req) {
        this.requests.push(req);
        if (req.subagent) {
          childStarted();
          await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
          return;
        }
        const tool = req.tools.find((t) => t.name === 'subagent')!;
        void tool.execute({ description: 'Slow', prompt: 'Take ages.' }, toolContextFor(req, req.signal, 'call-1'));
        await started;
        yield { type: 'error', error: { kind: 'transient', message: 'Connection dropped.', retryable: true } };
      },
      async listModels() {
        return [];
      },
      async testConnection() {
        return { ok: true, message: 'ok', latencyMs: 0 };
      },
    };
    const runner = new TurnRunner(store, engine, { toolProvider: new FakeToolProvider({ tools: [subagentTool] }), pathExists });
    const events: TurnEvent[] = [];
    runner.on((e) => events.push(e));

    const id = await runTurn(runner, store, resolved(store, 'p-main'), 'error');

    const part = store.messages.get(id)!.parts.find((p): p is SubagentPart => p.type === 'subagent');
    expect(part?.status).toBe('cancelled');
    const end = events.findIndex((e) => e.type === 'subagent' && e.event.type === 'end');
    const terminal = events.findIndex((e) => e.type === 'status' && e.status === 'error');
    expect(end).toBeGreaterThan(-1);
    expect(end).toBeLessThan(terminal);
  });
});
