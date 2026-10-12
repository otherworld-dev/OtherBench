import { describe, expect, it, vi } from 'vitest';
import type { ChatEngine, EngineEvent, EngineRequest } from '../src/ports/chat-engine.js';
import type { ApprovalRequest, ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { Connection, ModelInfo, Profile, ResolvedProfile, ToolPolicy } from '../src/types/config.js';
import type { Part } from '../src/types/messages.js';
import type { Usage } from '../src/types/usage.js';
import { FakeToolProvider, InMemoryStore } from '../src/testing/fakes.js';
import type { SubagentEvent, SubagentPart } from '../src/domain/parts.js';
import { createPlanGate } from '../src/domain/thread-tools.js';
import { toolContextFor } from '../src/domain/tool-context.js';
import { SUBAGENT_PLAN_NOTE, SUBAGENT_RESULT_COPY_MAX_CHARS, SubagentRunner, type SubagentRunnerDeps } from '../src/domain/subagent.js';

const USAGE: Usage = { tokensIn: 40, tokensOut: 8, tokensCached: 0, tokensReasoning: 0 };
const finish = (finishReason = 'stop'): EngineEvent => ({ type: 'finish', usage: USAGE, finishReason });

function connection(id: string, over: Partial<Connection> = {}): Connection {
  return { id, name: id, kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null, ...over };
}
function policy(over: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'read', shell: false, mcpServerIds: [], approvalMode: 'always_ask', subagents: true, ...over };
}
function profileRow(id: string, name: string, connectionId: string, over: Partial<Profile> = {}): Profile {
  return { id, name, description: null, colour: null, connectionId, modelId: `${id}-model`, systemPrompt: null, params: {}, toolPolicy: policy(), isDefault: false, archivedAt: null, ...over };
}
function resolved(store: InMemoryStore, id: string): ResolvedProfile {
  const p = store.profiles.get(id)!;
  const model: ModelInfo | null = store.models.list(p.connectionId).find((m) => m.modelId === p.modelId) ?? null;
  return { ...p, connection: store.connections.get(p.connectionId)!, apiKey: null, model };
}
function seeded(): InMemoryStore {
  const store = new InMemoryStore('node-self');
  store.connections.create(connection('mock'));
  store.connections.create(connection('cc', { kind: 'claude_code' }));
  store.profiles.create(profileRow('p-main', 'Main', 'mock', { systemPrompt: 'You are Main.' }));
  store.profiles.create(profileRow('p-cheap', 'Cheap', 'mock', { systemPrompt: 'You are Cheap.' }));
  store.profiles.create(profileRow('p-coder', 'Coder', 'cc'));
  store.profiles.create(profileRow('p-old', 'Old', 'mock', { archivedAt: 1 }));
  return store;
}

const readFile: ToolSpec = { name: 'read_file', description: '', parameters: {}, risk: 'read', source: 'fs', execute: async () => 'file text' };

/** A child engine run per request by `script`; records every request. */
function childEngine(script: (req: EngineRequest) => AsyncIterable<EngineEvent>): ChatEngine & { requests: EngineRequest[] } {
  const requests: EngineRequest[] = [];
  return {
    requests,
    async *stream(req) {
      requests.push(req);
      yield* script(req);
    },
    async listModels() {
      return [];
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 0 };
    },
  };
}

async function* answer(text: string): AsyncIterable<EngineEvent> {
  yield { type: 'text-delta', text };
  yield finish();
}

function harness(engine: ChatEngine, over: Partial<SubagentRunnerDeps> = {}, toolProvider = new FakeToolProvider({ tools: [readFile] })) {
  const store = (over.store as InMemoryStore | undefined) ?? seeded();
  const controller = new AbortController();
  let parts: Part[] = [];
  const events: { callId: string; event: SubagentEvent }[] = [];
  const usage: { profileId: string; modelId: string; callId: string; usage: Usage }[] = [];
  let ids = 0;
  const runner = new SubagentRunner({
    store,
    engine,
    toolProvider,
    resolveProfile: async (id) => resolved(store, id),
    now: () => 0,
    generateId: () => `gen-${++ids}`,
    chatId: 'chat-1',
    messageId: 'reply-1',
    parent: resolved(store, 'p-main'),
    workspaceRoot: '/ws',
    folders: [],
    signal: controller.signal,
    emit: (callId, event) => events.push({ callId, event }),
    updateParts: (fn) => {
      parts = fn(parts);
    },
    writeUsage: (profile, u, _latency, callId) => usage.push({ profileId: profile.id, modelId: profile.modelId, callId, usage: u }),
    ...over,
  });
  const ctx = (toolCallId: string): ToolContext => ({ chatId: 'chat-1', messageId: 'reply-1', profileId: 'p-main', workspaceRoot: '/ws', signal: controller.signal, toolCallId });
  return { store, runner, controller, events, usage, ctx, parts: () => parts, toolProvider };
}

const sub = (parts: Part[], callId: string): SubagentPart | undefined =>
  parts.find((p): p is SubagentPart => p.type === 'subagent' && p.callId === callId);

describe('SubagentRunner', () => {
  it("runs a sub-agent as the parent's profile and returns its final text", async () => {
    const engine = childEngine(() => answer('Found it.'));
    const h = harness(engine);

    const result = await h.runner.run({ description: 'Look', prompt: 'Find the bug.' }, h.ctx('call-1'));

    expect(result).toBe('Found it.');
    const req = engine.requests[0]!;
    expect(req.profile.id).toBe('p-main');
    expect(req.profile.systemPrompt).toContain('You are Main.');
    expect(req.profile.systemPrompt).toContain('# Working as a sub-agent');
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(req.messages[1]!.parts).toEqual([{ type: 'text', text: 'Find the bug.' }]);
    expect(req).toMatchObject({ chatId: 'chat-1', messageId: 'reply-1', workspaceRoot: '/ws', purpose: 'turn' });
    // Run as the parent's own profile, the tag names no other profile.
    expect(req.subagent).toEqual({ callId: 'call-1', label: 'Look', parentProfileId: 'p-main' });
    expect(req.subagents).toBeUndefined();
    expect(req.tools.map((t) => t.name)).toEqual(['read_file']);
    expect(sub(h.parts(), 'call-1')).toMatchObject({ status: 'complete', usage: USAGE, parts: [{ type: 'text', text: 'Found it.' }], profileName: 'Main' });
    expect(h.events.map((e) => e.event.type)).toEqual(['start', 'running', 'text-delta', 'end']);
    expect(h.usage).toEqual([{ profileId: 'p-main', modelId: 'p-main-model', callId: 'call-1', usage: USAGE }]);
    await h.runner.settled();
  });

  // Integration with the sandbox: the narrowed policy decides which run_command the sub-agent is offered.
  it("offers a sandboxed parent's sub-agent the sandboxed run_command, never the host one, even as a host-shell profile", async () => {
    const store = seeded();
    store.profiles.update('p-main', { toolPolicy: policy({ shell: true, shellRuns: 'sandbox', sandboxHosts: ['pypi.org', 'github.com'] }) });
    store.profiles.update('p-cheap', { toolPolicy: policy({ shell: true, sandboxHosts: ['pypi.org', 'internal.example.com'] }) });
    const provider = new FakeToolProvider();
    const listed: ToolPolicy[] = [];
    const listTools = provider.listTools.bind(provider);
    provider.listTools = async (p) => {
      listed.push(p);
      return listTools(p);
    };
    const engine = childEngine(() => answer('ok'));
    const h = harness(engine, { store }, provider);

    await h.runner.run({ description: 'As Cheap', prompt: 'Run it.', profile: 'Cheap' }, h.ctx('call-1'));
    await h.runner.run({ description: 'As me', prompt: 'Run it.' }, h.ctx('call-2'));

    for (const req of engine.requests) {
      expect(req.tools.filter((t) => t.name === 'run_command').map((t) => t.source)).toEqual(['sandbox']);
      // Told where its folders are in the sandbox, as the parent is.
      expect(req.profile.systemPrompt).toContain('# Sandbox');
    }
    expect(listed[0]).toMatchObject({ shell: true, shellRuns: 'sandbox', sandboxHosts: ['pypi.org'] });
    expect(listed[1]).toMatchObject({ shell: true, shellRuns: 'sandbox', sandboxHosts: ['pypi.org', 'github.com'] });
  });

  it("a host-shell parent's sub-agent run as a sandboxed profile is sandboxed, and one with no shell gets none", async () => {
    const store = seeded();
    store.profiles.update('p-main', { toolPolicy: policy({ shell: true }) });
    store.profiles.update('p-cheap', { toolPolicy: policy({ shell: true, shellRuns: 'sandbox' }) });
    const engine = childEngine(() => answer('ok'));
    const h = harness(engine, { store }, new FakeToolProvider());
    await h.runner.run({ description: 'As Cheap', prompt: 'Run it.', profile: 'Cheap' }, h.ctx('call-1'));
    await h.runner.run({ description: 'As me', prompt: 'Run it.' }, h.ctx('call-2'));
    await h.runner.run({ description: 'No shell', prompt: 'Run it.', tools: { shell: false } }, h.ctx('call-3'));
    const sources = engine.requests.map((req) => req.tools.filter((t) => t.name === 'run_command').map((t) => t.source));
    expect(sources).toEqual([['sandbox'], ['shell'], []]);
    expect(engine.requests.map((req) => req.profile.systemPrompt!.includes('# Sandbox'))).toEqual([true, false, false]);
  });

  // Integration with thread cards and scheduled tasks: what limits the parent reply limits its sub-agents.
  it("carries the parent call's plan gate onto the sub-agent's request, so every call it makes meets the same gate", async () => {
    const plan = createPlanGate();
    const engine = childEngine(() => answer('ok'));
    const h = harness(engine);
    await h.runner.run({ description: 'Look', prompt: 'Read it.' }, { ...h.ctx('call-1'), plan });
    const req = engine.requests[0]!;
    // The same object, not a copy: approving the parent's plan opens the sub-agent's calls too.
    expect(req.plan).toBe(plan);
    expect(toolContextFor(req).plan).toBe(plan);
    expect(req.profile.systemPrompt).toContain(SUBAGENT_PLAN_NOTE);
    expect(req).not.toHaveProperty('unattended');
  });

  it("carries the turn's own plan gate even when the call's context has none, and no gate or note when there is none", async () => {
    const plan = createPlanGate();
    const engine = childEngine(() => answer('ok'));
    const h = harness(engine, { plan });
    await h.runner.run({ description: 'Look', prompt: 'Read it.' }, h.ctx('call-1'));
    expect(engine.requests[0]!.plan).toBe(plan);

    const plain = childEngine(() => answer('ok'));
    const h2 = harness(plain);
    await h2.runner.run({ description: 'Look', prompt: 'Read it.' }, h2.ctx('call-1'));
    expect(plain.requests[0]).not.toHaveProperty('plan');
    expect(plain.requests[0]!.profile.systemPrompt).not.toContain('# Plan mode');

    // Started after the plan was approved: still the gate, but no note saying changes are refused.
    plan.approve();
    await h.runner.run({ description: 'Do it', prompt: 'Write it.' }, h.ctx('call-2'));
    expect(engine.requests[1]!.plan).toBe(plan);
    expect(engine.requests[1]!.profile.systemPrompt).not.toContain('# Plan mode');
  });

  it("marks a scheduled run's sub-agent unattended, from the call's context or from the turn, and no other", async () => {
    const fromCtx = childEngine(() => answer('ok'));
    const h = harness(fromCtx);
    await h.runner.run({ description: 'Look', prompt: 'Read it.' }, { ...h.ctx('call-1'), unattended: true });
    expect(fromCtx.requests[0]!.unattended).toBe(true);
    expect(toolContextFor(fromCtx.requests[0]!).unattended).toBe(true);

    const fromTurn = childEngine(() => answer('ok'));
    const h2 = harness(fromTurn, { unattended: true });
    await h2.runner.run({ description: 'Look', prompt: 'Read it.' }, h2.ctx('call-1'));
    expect(fromTurn.requests[0]!.unattended).toBe(true);

    const attended = childEngine(() => answer('ok'));
    const h3 = harness(attended);
    await h3.runner.run({ description: 'Look', prompt: 'Read it.' }, h3.ctx('call-1'));
    expect(attended.requests[0]).not.toHaveProperty('unattended');
    expect(toolContextFor(attended.requests[0]!)).not.toHaveProperty('unattended');
  });

  it('refuses bad input without starting anything', async () => {
    const engine = childEngine(() => answer('x'));
    const h = harness(engine);
    expect(await h.runner.run({ description: 'Look' }, h.ctx('call-1'))).toMatchObject({ error: true, code: 'invalid_input' });
    expect(engine.requests).toEqual([]);
    expect(h.parts()).toEqual([]);
  });

  it('refuses the 11th sub-agent of one reply', async () => {
    const engine = childEngine(() => answer('ok'));
    const h = harness(engine);
    const results = await Promise.all(Array.from({ length: 11 }, (_, i) => h.runner.run({ description: `Job ${i}`, prompt: 'Do it.' }, h.ctx(`call-${i}`))));
    expect(results.slice(0, 10)).toEqual(Array(10).fill('ok'));
    expect(results[10]).toMatchObject({ error: true, code: 'subagent_limit' });
    expect(engine.requests).toHaveLength(10);
  });

  it('runs at most four at once; the fifth waits its turn', async () => {
    let open = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const engine = childEngine(async function* (req) {
      open += 1;
      most = Math.max(most, open);
      await new Promise<void>((resolve) => releases.push(resolve));
      open -= 1;
      yield* answer(`done ${req.subagent!.label}`);
    });
    const h = harness(engine);
    const runs = Array.from({ length: 5 }, (_, i) => h.runner.run({ description: `Job ${i}`, prompt: 'Wait.' }, h.ctx(`call-${i}`)));

    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(sub(h.parts(), 'call-4')?.status).toBe('queued');
    // One finishes, so the fifth gets its slot and starts.
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    for (const release of releases.splice(0)) release();

    expect(await Promise.all(runs)).toEqual(['done Job 0', 'done Job 1', 'done Job 2', 'done Job 3', 'done Job 4']);
    expect(most).toBe(4);
  });

  it('Stop while a sub-agent waits for a slot ends it cancelled without calling its model', async () => {
    const engine = childEngine(async function* (req) {
      await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const h = harness(engine);
    const runs = Array.from({ length: 5 }, (_, i) => h.runner.run({ description: `Job ${i}`, prompt: 'Wait.' }, h.ctx(`call-${i}`)));
    await vi.waitFor(() => expect(engine.requests).toHaveLength(4));

    h.controller.abort();
    const results = await Promise.all(runs);
    await h.runner.settled();

    expect(results.every((r) => (r as { code?: string }).code === 'cancelled')).toBe(true);
    expect(engine.requests).toHaveLength(4);
    expect(sub(h.parts(), 'call-4')?.status).toBe('cancelled');
    expect(h.parts().every((p) => p.type !== 'subagent' || p.status === 'cancelled')).toBe(true);
    expect(h.usage).toEqual([]);
  });

  it("Stop while a sub-agent waits on a card ends it cancelled, settles the card, and tags the card with the sub-agent", async () => {
    const provider = new FakeToolProvider({ tools: [readFile] });
    const requests: ApprovalRequest[] = [];
    const resolved: string[] = [];
    provider.onApprovalEvent((e) => (e.type === 'request' ? requests.push(e.request) : resolved.push(e.requestId)));
    const engine = childEngine(async function* (req) {
      const tool = req.tools.find((t) => t.name === 'read_file')!;
      yield { type: 'tool-call', id: 'r1', name: 'read_file', args: { path: 'a.txt' } };
      const result = await tool.execute({ path: 'a.txt' }, toolContextFor(req, req.signal, 'r1'));
      if (req.signal.aborted) return;
      yield { type: 'tool-result', id: 'r1', name: 'read_file', result, isError: false };
      yield* answer('read it');
    });
    const h = harness(engine, {}, provider);
    const run = h.runner.run({ description: 'Reader', prompt: 'Read a.txt.' }, h.ctx('call-1'));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ messageId: 'reply-1', subagent: { callId: 'call-1', label: 'Reader' } });

    h.controller.abort();

    expect(await run).toMatchObject({ error: true, code: 'cancelled' });
    expect(resolved).toEqual([requests[0]!.id]);
    expect(sub(h.parts(), 'call-1')).toMatchObject({ status: 'cancelled', parts: [{ type: 'tool-call', id: 'r1' }] });
  });

  it('runs as another profile by name, case-insensitively, and refuses Claude Code, archived and unknown ones', async () => {
    const engine = childEngine(() => answer('cheap answer'));
    const h = harness(engine);
    expect(await h.runner.run({ description: 'A', prompt: 'p', profile: 'cheap' }, h.ctx('call-1'))).toBe('cheap answer');
    expect(engine.requests[0]!.profile).toMatchObject({ id: 'p-cheap' });
    expect(engine.requests[0]!.subagent).toEqual({ callId: 'call-1', label: 'A', parentProfileId: 'p-main', profileName: 'Cheap' });
    expect(engine.requests[0]!.profile.systemPrompt).toContain('You are Cheap.');
    expect(engine.requests[0]!.profile.systemPrompt).not.toContain('You are Main.');
    expect(h.usage[0]).toMatchObject({ profileId: 'p-cheap', modelId: 'p-cheap-model' });

    for (const name of ['Coder', 'Old', 'Nobody']) {
      const result = await h.runner.run({ description: 'B', prompt: 'p', profile: name }, h.ctx(`call-${name}`));
      expect(result).toMatchObject({ error: true, code: 'subagent_profile', message: expect.stringContaining('"Cheap"') });
    }
    expect(engine.requests).toHaveLength(1);
  });

  it('names both profiles when two are called the same', async () => {
    const engine = childEngine(() => answer('x'));
    const store = seeded();
    store.profiles.create(profileRow('p-cheap-2', 'CHEAP', 'mock'));
    const h = harness(engine, { store });
    const result = await h.runner.run({ description: 'A', prompt: 'p', profile: 'Cheap' }, h.ctx('call-1'));
    expect(result).toMatchObject({ error: true, code: 'subagent_profile', message: expect.stringMatching(/p-cheap\b.*p-cheap-2|p-cheap-2.*p-cheap\b/) });
  });

  it('only allows your own profile without a resolver', async () => {
    const engine = childEngine(() => answer('x'));
    const h = harness(engine, { resolveProfile: undefined });
    expect(await h.runner.run({ description: 'A', prompt: 'p', profile: 'Cheap' }, h.ctx('call-1'))).toMatchObject({ code: 'subagent_profile' });
    expect(await h.runner.run({ description: 'A', prompt: 'p', profile: 'main' }, h.ctx('call-2'))).toBe('x');
  });

  it('refuses an MCP server the sub-agent may not use', async () => {
    const engine = childEngine(() => answer('x'));
    const h = harness(engine);
    expect(await h.runner.run({ description: 'A', prompt: 'p', tools: { mcpServers: ['GitHub'] } }, h.ctx('call-1'))).toMatchObject({ error: true, code: 'subagent_tools' });
    expect(engine.requests).toEqual([]);
  });

  it('never gives a sub-agent the artifact or subagent tool', async () => {
    const artifact: ToolSpec = { name: 'artifact', description: '', parameters: {}, risk: 'read', source: 'artifact', execute: async () => null };
    const subagent: ToolSpec = { name: 'subagent', description: '', parameters: {}, risk: 'read', source: 'subagent', execute: async () => null };
    const engine = childEngine(() => answer('x'));
    const h = harness(engine, {}, new FakeToolProvider({ tools: [readFile, artifact, subagent] }));
    await h.runner.run({ description: 'A', prompt: 'p' }, h.ctx('call-1'));
    expect(engine.requests[0]!.tools.map((t) => t.name)).toEqual(['read_file']);
  });

  it('cuts the stored copy of a long tool result, but keeps it whole for the model', async () => {
    const long = 'q'.repeat(9_000);
    const engine = childEngine(async function* () {
      yield { type: 'tool-call', id: 't1', name: 'read_file', args: {} };
      yield { type: 'tool-result', id: 't1', name: 'read_file', result: long, isError: false };
      yield* answer('Long file.');
    });
    const h = harness(engine);
    expect(await h.runner.run({ description: 'A', prompt: 'p' }, h.ctx('call-1'))).toBe('Long file.');
    const stored = sub(h.parts(), 'call-1')!.parts.find((p) => p.type === 'tool-result') as Extract<Part, { type: 'tool-result' }>;
    expect(typeof stored.result).toBe('string');
    expect((stored.result as string).length).toBeLessThan(SUBAGENT_RESULT_COPY_MAX_CHARS + 200);
    expect(stored.result as string).toContain('9000 characters');
  });

  it('marks the card failed when the engine errors or the sub-agent writes no answer', async () => {
    const failing = childEngine(async function* () {
      yield { type: 'error', error: { kind: 'rate_limit', message: 'Slow down.', retryable: true } };
    });
    const h = harness(failing);
    expect(await h.runner.run({ description: 'A', prompt: 'p' }, h.ctx('call-1'))).toEqual({ error: true, code: 'subagent_failed', message: 'The sub-agent failed: Slow down.' });
    expect(sub(h.parts(), 'call-1')).toMatchObject({ status: 'error', error: 'Slow down.' });
    expect(h.usage).toEqual([]);

    const silent = childEngine(async function* () {
      yield finish();
    });
    const h2 = harness(silent);
    expect(await h2.runner.run({ description: 'A', prompt: 'p' }, h2.ctx('call-1'))).toMatchObject({ code: 'subagent_no_answer' });
    expect(sub(h2.parts(), 'call-1')).toMatchObject({ status: 'error', usage: USAGE });
    expect(h2.usage).toHaveLength(1);
  });

  it('gives a fresh call id when the engine gives none or repeats one', async () => {
    const engine = childEngine(() => answer('x'));
    const h = harness(engine);
    const noId: ToolContext = { ...h.ctx('ignored'), toolCallId: undefined };
    await h.runner.run({ description: 'A', prompt: 'p' }, noId);
    await h.runner.run({ description: 'B', prompt: 'p' }, h.ctx('same'));
    await h.runner.run({ description: 'C', prompt: 'p' }, h.ctx('same'));
    expect(h.parts().map((p) => (p as SubagentPart).callId)).toEqual(['gen-1', 'same', 'gen-2']);
  });

  it("closes the card even when the usage row can't be written", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const engine = childEngine(() => answer('Done.'));
      const h = harness(engine, {
        writeUsage: () => {
          throw new Error('SQLITE_BUSY');
        },
      });
      expect(await h.runner.run({ description: 'A', prompt: 'p' }, h.ctx('call-1'))).toBe('Done.');
      expect(sub(h.parts(), 'call-1')).toMatchObject({ status: 'complete', usage: USAGE });
      expect(h.events.filter((e) => e.event.type === 'end')).toHaveLength(1);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('settled() waits for a run that is still going, until its end has been sent', async () => {
    let release!: () => void;
    const engine = childEngine(async function* () {
      await new Promise<void>((resolve) => (release = resolve));
      yield* answer('late');
    });
    const h = harness(engine);
    const run = h.runner.run({ description: 'A', prompt: 'p' }, h.ctx('call-1'));
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    let settled = false;
    const waiting = h.runner.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await waiting;
    expect(settled).toBe(true);
    expect(h.events.at(-1)?.event.type).toBe('end');
    expect(await run).toBe('late');
  });

  it('frees its slot when listing the tools throws, so the fifth sub-agent still starts', async () => {
    class FlakyProvider extends FakeToolProvider {
      calls = 0;
      override async listTools(policy: ToolPolicy): Promise<ToolSpec[]> {
        this.calls += 1;
        if (this.calls === 1) throw new Error('mcp is down');
        return super.listTools(policy);
      }
    }
    const releases: (() => void)[] = [];
    let open = 0;
    let most = 0;
    const engine = childEngine(async function* () {
      open += 1;
      most = Math.max(most, open);
      await new Promise<void>((resolve) => releases.push(resolve));
      open -= 1;
      yield* answer('ok');
    });
    const h = harness(engine, {}, new FlakyProvider({ tools: [readFile] }));
    const runs = Array.from({ length: 5 }, (_, i) => h.runner.run({ description: `Job ${i}`, prompt: 'p' }, h.ctx(`call-${i}`)));

    // The first failed at once, so the other four all run together; with its slot leaked only three would.
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    for (const release of releases.splice(0)) release();
    const results = await Promise.all(runs);

    expect(results[0]).toMatchObject({ error: true, code: 'subagent_failed' });
    expect(results.slice(1)).toEqual(Array(4).fill('ok'));
    expect(most).toBeLessThanOrEqual(4);
    expect(sub(h.parts(), 'call-0')).toMatchObject({ status: 'error' });
  });

  describe("grants: a sub-agent's calls are matched and stored under the parent reply's profile", () => {
    const writeFile: ToolSpec = { name: 'write_file', description: '', parameters: {}, risk: 'mutate', source: 'fs', execute: async () => 'written' };
    /** Main (the parent) and Cheap may both write, and both always ask. */
    function writableStore(): InMemoryStore {
      const store = seeded();
      for (const id of ['p-main', 'p-cheap']) store.profiles.update(id, { toolPolicy: policy({ fs: 'readwrite', approvalMode: 'always_ask' }) });
      return store;
    }
    function alwaysGrant(store: InMemoryStore, profileId: string): void {
      store.grants.create({ id: `grant-${profileId}`, chatId: null, profileId, toolName: 'write_file', source: 'fs', scope: 'always', constraint: null, expiresAt: null });
    }
    const writer = childEngine(async function* (req) {
      const tool = req.tools.find((t) => t.name === 'write_file')!;
      yield { type: 'tool-call', id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'x' } };
      const result = await tool.execute({ path: 'a.txt', content: 'x' }, toolContextFor(req, req.signal, 'w1'));
      yield { type: 'tool-result', id: 'w1', name: 'write_file', result, isError: false };
      yield* answer(`wrote: ${JSON.stringify(result)}`);
    });

    it("the profile it runs as having an always grant doesn't let it write without a card", async () => {
      const store = writableStore();
      alwaysGrant(store, 'p-cheap');
      const provider = new FakeToolProvider({ tools: [readFile, writeFile], store });
      const requests: ApprovalRequest[] = [];
      provider.onApprovalEvent((e) => {
        if (e.type === 'request') requests.push(e.request);
      });
      const h = harness(writer, { store }, provider);
      const run = h.runner.run({ description: 'Writer', prompt: 'Write a.txt.', profile: 'Cheap' }, h.ctx('call-1'));

      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toMatchObject({ toolName: 'write_file', subagent: { callId: 'call-1', label: 'Writer', parentProfileId: 'p-main', profileName: 'Cheap' } });
      // An "always" answer is stored under the parent's profile, not Cheap's.
      provider.resolveApproval(requests[0]!.id, { choice: 'always', constraint: null });
      expect(await run).toBe('wrote: "written"');
      const made = store.grants.list().filter((g) => g.id !== 'grant-p-cheap');
      expect(made).toEqual([expect.objectContaining({ profileId: 'p-main', toolName: 'write_file', scope: 'always' })]);
    });

    it("a grant under the parent's profile lets the sub-agent's call through", async () => {
      const store = writableStore();
      alwaysGrant(store, 'p-main');
      const provider = new FakeToolProvider({ tools: [readFile, writeFile], store });
      const requests: ApprovalRequest[] = [];
      provider.onApprovalEvent((e) => {
        if (e.type === 'request') requests.push(e.request);
      });
      const h = harness(writer, { store }, provider);
      expect(await h.runner.run({ description: 'Writer', prompt: 'Write a.txt.', profile: 'Cheap' }, h.ctx('call-1'))).toBe('wrote: "written"');
      expect(requests).toEqual([]);
    });
  });

  it("ends a card whose start went out even when storing the start throws", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const engine = childEngine(() => answer('x'));
      let parts: Part[] = [];
      const h = harness(engine, {
        updateParts: (fn) => {
          const next = fn(parts);
          if (next.some((p) => p.type === 'subagent' && p.status === 'queued') && !parts.some((p) => p.type === 'subagent')) throw new Error('SQLITE_BUSY');
          parts = next;
        },
      });
      const result = await h.runner.run({ description: 'A', prompt: 'p' }, h.ctx('call-1'));
      expect(result).toMatchObject({ error: true, code: 'subagent_failed' });
      expect(h.events.map((e) => e.event.type)).toEqual(['start', 'end']);
      expect(h.events[1]!.event).toMatchObject({ type: 'end', status: 'error' });
      expect(engine.requests).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("passes the call's tools narrowing on to the tool list", async () => {
    const engine = childEngine(() => answer('x'));
    const h = harness(engine);
    await h.runner.run({ description: 'A', prompt: 'p', tools: { files: 'off' } }, h.ctx('call-1'));
    expect(engine.requests[0]!.tools.map((t) => t.name)).not.toContain('read_file');
    await h.runner.run({ description: 'B', prompt: 'p' }, h.ctx('call-2'));
    expect(engine.requests[1]!.tools.map((t) => t.name)).toContain('read_file');
  });
});
