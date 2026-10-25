import { describe, expect, it, vi } from 'vitest';
import { COMPUTER_UNATTENDED_REASON } from '@otherbench/core/domain/computer-apps.js';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { PLAN_REFUSAL } from '@otherbench/core/domain/thread-tools.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { Grant } from '@otherbench/core/ports/store.js';
import type { ApprovalChoice, ApprovalRequest, ToolApprovalEvent } from '@otherbench/core/ports/tool-provider.js';
import { FAKE_COMPUTER_APP, FakeComputerDriver } from '@otherbench/core/testing/fake-computer.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Connection, Profile, ResolvedProfile, ToolPolicy } from '@otherbench/core/types/config.js';
import { OtherBenchToolProvider } from '../src/provider.js';
import { ctx, policy as computerPolicy } from './computer-helpers.js';

// The integration seams of computer use with scheduled runs (unattended),
// Plan mode (thread cards) and API sub-agents, through the real TurnRunner,
// SubagentRunner, OtherBenchToolProvider and PermissionBroker. The desktop is
// FakeComputerDriver: nothing here moves a mouse or reads a screen, and
// `driver.started` is every native start dialog that would have come up.

const emptyMcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
const finish: EngineEvent = { type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
const connection: Connection = { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null };
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', artifacts: false, recall: false, computer: true, ...o });
const row = (id: string, name: string, toolPolicy: ToolPolicy): Profile => ({ id, name, description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1', systemPrompt: null, params: {}, toolPolicy, isDefault: false, archivedAt: null });
const resolve = (p: Profile): ResolvedProfile => ({ ...p, connection, apiKey: null, model: null });
const appGrant = (scope: 'always' | 'chat' = 'always'): Grant =>
  ({ id: `g-${scope}`, chatId: scope === 'chat' ? 'chat-1' : null, profileId: 'p-main', toolName: 'computer', source: 'computer', scope, constraint: { app: FAKE_COMPUTER_APP.path }, expiresAt: null }) as Grant;
const isError = (r: unknown, code?: string): boolean =>
  typeof r === 'object' && r !== null && (r as { error?: unknown }).error === true && (code === undefined || (r as { code?: unknown }).code === code);
const messageOf = (r: unknown): string => String((r as { message?: unknown }).message);

const LOOK = { action: 'screenshot' };
const CLICK = { action: 'left_click', coordinate: [10, 20] };

interface TurnOptions {
  parent?: Partial<ToolPolicy>;
  /** The computer calls the parent reply makes, in order. */
  calls?: Record<string, unknown>[];
  /** Starts a sub-agent after the parent's calls; it tries the same calls. */
  subagent?: boolean;
  planMode?: boolean;
  unattended?: boolean;
  /** Approves the reply's plan after the first round of calls, then makes them again. */
  approvePlan?: boolean;
  answer?: ApprovalChoice['choice'];
  grants?: Grant[];
}

async function turn(o: TurnOptions = {}) {
  const store = new InMemoryStore();
  store.connections.create(connection);
  const main = row('p-main', 'Main', policy({ subagents: o.subagent === true, ...o.parent }));
  store.profiles.create(main);
  const driver = new FakeComputerDriver();
  const broker = new PermissionBroker(store);
  const provider = new OtherBenchToolProvider(store, broker, emptyMcp, { computer: driver });
  const cards: ApprovalRequest[] = [];
  provider.onApprovalEvent((e: ToolApprovalEvent) => {
    if (e.type !== 'request') return;
    cards.push(e.request);
    provider.resolveApproval(e.request.id, { choice: o.answer ?? 'deny' } as ApprovalChoice);
  });
  for (const grant of o.grants ?? []) store.grants.create(grant);
  store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p-main', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, planMode: o.planMode === true, autoMode: false });

  const seen = { results: [] as unknown[], afterApproval: [] as unknown[], offered: [] as string[], subOffered: null as string[] | null, subPolicy: null as ToolPolicy | null, subResults: [] as unknown[] };
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      if (req.subagent) {
        seen.subOffered = req.tools.map((t) => t.name);
        seen.subPolicy = req.profile.toolPolicy;
        const tool = req.tools.find((t) => t.name === 'computer');
        for (const [i, args] of (o.calls ?? []).entries()) seen.subResults.push(tool ? await tool.execute(args, toolContextFor(req, req.signal, `sub-${i}`)) : 'not offered');
        yield { type: 'text-delta', text: 'Finished.' };
        yield finish;
        return;
      }
      seen.offered = req.tools.map((t) => t.name);
      const tool = req.tools.find((t) => t.name === 'computer');
      for (const [i, args] of (o.calls ?? []).entries()) seen.results.push(tool ? await tool.execute(args, toolContextFor(req, req.signal, `call-${i}`)) : 'not offered');
      if (o.approvePlan && req.plan) {
        req.plan.approve();
        for (const [i, args] of (o.calls ?? []).entries()) seen.afterApproval.push(tool ? await tool.execute(args, toolContextFor(req, req.signal, `again-${i}`)) : 'not offered');
      }
      const sub = req.tools.find((t) => t.name === 'subagent');
      if (o.subagent && sub) await sub.execute({ description: 'Helper', prompt: 'Use the computer.' }, toolContextFor(req, req.signal, 'sub-call'));
      yield finish;
    },
    async listModels() {
      return [];
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 0 };
    },
  };
  const runner = new TurnRunner(store, engine, { toolProvider: provider, resolveProfile: async (id) => resolve(store.profiles.get(id)!) });
  const { assistantMessageIds } = await runner.run({
    chatId: 'chat-1',
    parentId: null,
    userParts: [{ type: 'text', text: 'go' }],
    profiles: [resolve(main)],
    ...(o.unattended ? { unattended: true } : {}),
  });
  await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete'));
  const audit = store.audit.list('chat-1').map((a) => `${a.toolName}:${a.grantedBy}`);
  return { store, driver, provider, seen, cards, audit };
}

describe('computer use in a scheduled run (seam 1: unattended)', () => {
  it('refuses every action, a screenshot included, with no card and no start dialog, even with Always and chat grants for the app', async () => {
    const r = await turn({ unattended: true, calls: [LOOK, CLICK], answer: 'once', grants: [appGrant('always'), appGrant('chat')] });
    expect(r.seen.offered).toContain('computer');
    expect(r.seen.results).toHaveLength(2);
    for (const result of r.seen.results) {
      expect(isError(result, 'approval_unavailable')).toBe(true);
      expect(messageOf(result)).toBe(COMPUTER_UNATTENDED_REASON);
    }
    expect(r.driver.started).toEqual([]);
    expect(r.driver.actions).toEqual([]);
    expect(r.driver.screenshots).toEqual([]);
    expect(r.cards).toEqual([]);
    expect(r.audit).toEqual(['computer:deny:unattended', 'computer:deny:unattended']);
  });

  it('runs the same calls with someone watching (the look with no card, the click on its grant)', async () => {
    const r = await turn({ calls: [LOOK, CLICK], grants: [appGrant('always')] });
    expect(r.seen.results.map((x) => isError(x))).toEqual([false, false]);
    expect(r.driver.started).toHaveLength(1);
    expect(r.driver.actions).toHaveLength(1);
    expect(r.cards).toEqual([]);
  });

  it("a scheduled run's sub-agent is never offered computer use, and its policy has it off", async () => {
    const r = await turn({ unattended: true, subagent: true, calls: [LOOK, CLICK], answer: 'once', grants: [appGrant('always')] });
    expect(r.seen.subOffered).not.toBeNull();
    expect(r.seen.subOffered).not.toContain('computer');
    expect(r.seen.subPolicy?.computer).toBe(false);
    expect(r.seen.subResults).toEqual(['not offered', 'not offered']);
    expect(r.driver.started).toEqual([]);
  });

  it("refuses the relayed computer tool (Claude Code's gate) in a scheduled run before the desktop app is asked anything", async () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'T', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const driver = new FakeComputerDriver();
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), emptyMcp, { computer: driver });
    const cards: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') cards.push(e.request);
    });
    const [spec] = (await provider.relayOtherBenchTools(computerPolicy()));
    expect(spec).toMatchObject({ name: 'computer', source: 'computer' });
    for (const args of [LOOK, CLICK]) {
      // `deferAsk` as in auto mode: a scheduled run never hands a call to Claude Code's classifier either.
      const outcome = await provider.requestApproval(spec!, args, computerPolicy(), ctx({ unattended: true }), { deferAsk: true });
      expect(outcome).toEqual({ allowed: false, reason: COMPUTER_UNATTENDED_REASON });
    }
    expect(driver.started).toEqual([]);
    expect(cards).toEqual([]);
    expect(store.audit.list('chat-1').map((a) => a.grantedBy)).toEqual(['deny:unattended', 'deny:unattended']);
  });
});

describe('computer use in a Plan-mode chat (seam 3)', () => {
  it('refuses every action while the plan waits, the looks included, with no card and no start dialog, whatever grants there are', async () => {
    const r = await turn({ planMode: true, calls: [LOOK, { action: 'cursor_position' }, { action: 'wait', duration: 1 }, CLICK], answer: 'once', grants: [appGrant('always')] });
    expect(r.seen.results).toHaveLength(4);
    for (const result of r.seen.results) {
      expect(isError(result, 'plan_mode')).toBe(true);
      expect(messageOf(result)).toBe(PLAN_REFUSAL);
    }
    expect(r.driver.started).toEqual([]);
    expect(r.driver.actions).toEqual([]);
    expect(r.cards).toEqual([]);
    expect(r.audit).toEqual(['computer:deny:plan', 'computer:deny:plan', 'computer:deny:plan', 'computer:deny:plan']);
  });

  it('goes back to its own rules once the plan is approved: the look runs, and the click on its grant', async () => {
    const r = await turn({ planMode: true, approvePlan: true, calls: [LOOK, CLICK], grants: [appGrant('always')] });
    expect(r.seen.results.map((x) => isError(x, 'plan_mode'))).toEqual([true, true]);
    expect(r.seen.afterApproval.map((x) => isError(x))).toEqual([false, false]);
    expect(r.driver.started).toHaveLength(1);
    expect(r.driver.actions).toHaveLength(1);
  });

  it("refuses the relayed computer tool while the plan waits, before the desktop app is asked anything", async () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'chat-1', title: 'T', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const driver = new FakeComputerDriver();
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), emptyMcp, { computer: driver });
    const [spec] = (await provider.relayOtherBenchTools(computerPolicy()));
    const { createPlanGate } = await import('@otherbench/core/domain/thread-tools.js');
    for (const args of [LOOK, CLICK]) {
      expect(await provider.requestApproval(spec!, args, computerPolicy(), ctx({ plan: createPlanGate() }))).toEqual({ allowed: false, reason: PLAN_REFUSAL });
    }
    expect(driver.started).toEqual([]);
    expect(store.audit.list('chat-1').map((a) => a.grantedBy)).toEqual(['deny:plan', 'deny:plan']);
  });
});
