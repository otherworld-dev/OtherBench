import { describe, expect, it, vi } from 'vitest';
import { PermissionBroker, UNATTENDED_REASON } from '@otherbench/core/domain/permissions.js';
import { createPlanGate, PLAN_REFUSAL } from '@otherbench/core/domain/thread-tools.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { Grant } from '@otherbench/core/ports/store.js';
import type { ApprovalChoice, ApprovalRequest, ToolApprovalEvent, ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Connection, Profile, ResolvedProfile, ToolPolicy } from '@otherbench/core/types/config.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { OtherBenchToolProvider } from '../../src/provider.js';
import { FakeFactory, fakeProxy } from './fakes.js';

// The integration seams between the model's browser and Plan mode (thread
// cards), scheduled runs (unattended) and API sub-agents, through the real
// OtherBenchToolProvider, PermissionBroker, BrowserManager, TurnRunner and
// SubagentRunner. Only Chromium and the proxy are fakes.

const emptyMcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', artifacts: false, recall: false, browser: true, ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'p-main', workspaceRoot: null, signal: new AbortController().signal, ...o });
const isError = (r: unknown, code?: string): boolean =>
  typeof r === 'object' && r !== null && (r as { error?: unknown }).error === true && (code === undefined || (r as { code?: unknown }).code === code);
const messageOf = (r: unknown): string => String((r as { message?: unknown }).message);
const siteGrant = (id: string, host: string, profileId = 'p-main', scope: 'always' | 'chat' = 'always'): Grant =>
  ({ id, chatId: scope === 'chat' ? 'chat-1' : null, profileId, toolName: 'browser', source: 'browser', scope, constraint: { host }, expiresAt: null }) as Grant;

function setup(o: { answer?: ApprovalChoice['choice']; grants?: Grant[] } = {}) {
  const store = new InMemoryStore();
  const factory = new FakeFactory();
  const proxy = fakeProxy();
  const manager = new BrowserManager({ factory, startProxy: proxy.start });
  const broker = new PermissionBroker(store);
  const provider = new OtherBenchToolProvider(store, broker, emptyMcp, { browser: manager });
  const cards: ApprovalRequest[] = [];
  provider.onApprovalEvent((e: ToolApprovalEvent) => {
    if (e.type !== 'request') return;
    cards.push(e.request);
    provider.resolveApproval(e.request.id, { choice: o.answer ?? 'deny' } as ApprovalChoice);
  });
  for (const grant of o.grants ?? []) store.grants.create(grant);
  const browser = async (p: ToolPolicy = policy()): Promise<ToolSpec> => (await provider.listTools(p)).find((t) => t.name === 'browser')!;
  const audit = () => store.audit.list('chat-1').map((a) => `${a.toolName}:${a.grantedBy}`);
  return { store, factory, proxy, manager, broker, provider, cards, browser, audit };
}

describe('the browser in a Plan-mode chat', () => {
  it('refuses opening a page and every change to one until the plan is approved, with no card and no browser started', async () => {
    const s = setup({ answer: 'once', grants: [siteGrant('g1', 'example.com')] });
    const tool = await s.browser();
    const plan = createPlanGate();
    const opened = await tool.execute({ command: 'open', url: 'https://example.com/' }, ctx({ plan }));
    expect(isError(opened, 'plan_mode')).toBe(true);
    expect(messageOf(opened)).toBe(PLAN_REFUSAL);
    expect(s.factory.sessions).toHaveLength(0);
    expect(s.cards).toEqual([]);
    expect(s.audit()).toEqual(['browser:deny:plan']);
    expect(s.broker.pendingCount).toBe(0);

    // A page opened before the plan was asked for (another reply of the chat, with no gate).
    expect(isError(await tool.execute({ command: 'open', url: 'https://example.com/' }, ctx()))).toBe(false);
    const session = s.factory.sessions[0]!;
    expect(session.actions).toEqual(['open https://example.com/']);

    // The planning reply may read it...
    const read = await tool.execute({ command: 'snapshot' }, ctx({ plan }));
    expect(isError(read)).toBe(false);
    expect(read).toMatchObject({ url: 'https://example.com/', snapshot: expect.stringContaining('[ref=e1]') });
    expect(isError(await tool.execute({ command: 'scroll', direction: 'down' }, ctx({ plan })))).toBe(false);
    // ...and change nothing on it, though the site has an Always grant.
    for (const args of [
      { command: 'click', ref: 'e3' },
      { command: 'type', ref: 'e2', text: 'secret', submit: true },
      { command: 'select', ref: 'e2', values: ['x'] },
      { command: 'press', key: 'Enter' },
      { command: 'back' },
      { command: 'open', url: 'https://example.com/next' },
    ]) {
      const refused = await tool.execute(args, ctx({ plan }));
      expect(isError(refused, 'plan_mode'), JSON.stringify(args)).toBe(true);
      expect(messageOf(refused)).toBe(PLAN_REFUSAL);
    }
    expect(session.actions).toEqual(['open https://example.com/', 'scroll down']);
    expect(s.cards).toEqual([]);

    // The same gate, approved: the click goes on to the site's grant and runs.
    plan.approve();
    expect(isError(await tool.execute({ command: 'click', ref: 'e3' }, ctx({ plan })))).toBe(false);
    expect(session.actions).toEqual(['open https://example.com/', 'scroll down', 'click e3']);
  });

  it("refuses the relayed browser the same way: Claude Code's gate gets the plan refusal, and no ticket's worth of arguments", async () => {
    const s = setup({ answer: 'once' });
    const [spec] = (await s.provider.relayTools(policy()));
    expect(spec).toMatchObject({ name: 'browser', source: 'browser' });
    const outcome = await s.provider.requestApproval(spec!, { command: 'open', url: 'https://example.com/' }, policy(), ctx({ plan: createPlanGate() }));
    expect(outcome).toEqual({ allowed: false, reason: PLAN_REFUSAL });
    expect(s.cards).toEqual([]);
    expect(s.audit()).toEqual(['browser:deny:plan']);
  });
});

describe('the browser in a scheduled run', () => {
  it('refuses a site that would need a card, with the shared reason and no card, and starts no browser', async () => {
    const s = setup({ answer: 'once' });
    const tool = await s.browser();
    const refused = await tool.execute({ command: 'open', url: 'https://example.com/' }, ctx({ unattended: true }));
    expect(isError(refused, 'approval_unavailable')).toBe(true);
    expect(messageOf(refused)).toBe(UNATTENDED_REASON);
    expect(s.cards).toEqual([]);
    expect(s.factory.sessions).toHaveLength(0);
    expect(s.audit()).toEqual(['browser:deny:unattended']);
    expect(s.broker.pendingCount).toBe(0);
    // The same call with someone watching raises the card.
    expect(isError(await tool.execute({ command: 'open', url: 'https://example.com/' }, ctx()))).toBe(false);
    expect(s.cards.map((c) => [c.toolName, c.source, c.summary])).toEqual([['browser', 'browser', 'Use example.com: open https://example.com/']]);
  });

  it('uses a site an Always grant covers, and is refused again the moment the page is on another site', async () => {
    const s = setup({ answer: 'once', grants: [siteGrant('g1', 'example.com')] });
    const tool = await s.browser();
    const unattended = ctx({ unattended: true });
    expect(isError(await tool.execute({ command: 'open', url: 'https://example.com/' }, unattended))).toBe(false);
    expect(isError(await tool.execute({ command: 'click', ref: 'e3' }, unattended))).toBe(false);
    const session = s.factory.sessions[0]!;
    // The page takes itself to a site nobody approved (a link, a redirect).
    session.navigate('https://elsewhere.test/landing', 'Elsewhere');
    await tool.execute({ command: 'snapshot' }, unattended); // reading needs no card under "ask on changes"; it gives the new page's refs
    const clicked = await tool.execute({ command: 'click', ref: 'e3' }, unattended);
    expect(isError(clicked, 'approval_unavailable')).toBe(true);
    expect(messageOf(clicked)).toBe(UNATTENDED_REASON);
    expect(session.actions).toEqual(['open https://example.com/', 'click e3']);
    expect(s.cards).toEqual([]);
    expect(s.audit().filter((a) => a.endsWith('deny:unattended'))).toHaveLength(1);
  });

  it('refuses even reading the page under "always ask", and a blocked site as itself, not as unattended', async () => {
    const s = setup({ answer: 'once', grants: [siteGrant('g1', 'example.com')] });
    const always = policy({ approvalMode: 'always_ask', browserBlockedHosts: ['ads.test'] });
    const tool = await s.browser(always);
    const unattended = ctx({ unattended: true });
    expect(isError(await tool.execute({ command: 'open', url: 'https://example.com/' }, unattended))).toBe(false);
    s.factory.sessions[0]!.navigate('https://elsewhere.test/', 'Elsewhere');
    expect(isError(await tool.execute({ command: 'snapshot' }, unattended), 'approval_unavailable')).toBe(true);
    const blocked = await tool.execute({ command: 'open', url: 'https://ads.test/' }, unattended);
    expect(isError(blocked, 'permission_denied')).toBe(true);
    expect(messageOf(blocked)).toBe('ads.test is blocked for this profile.');
    expect(s.cards).toEqual([]);
  });

  it('says what the refusal tells the model about the browser, and each half of it is true', async () => {
    expect(UNATTENDED_REASON).toContain('The browser needs an Always grant for each website it opens or acts on; with "Ask on changes" it can read a page that is already open without one.');
    const unattended = ctx({ unattended: true });
    // "an Always grant for each website it opens or acts on": without one both are refused, with one both run.
    const none = setup();
    const bare = await none.browser();
    expect(isError(await bare.execute({ command: 'open', url: 'https://example.com/' }, unattended), 'approval_unavailable')).toBe(true);
    const s = setup({ grants: [siteGrant('g1', 'example.com')] });
    const tool = await s.browser();
    expect(isError(await tool.execute({ command: 'open', url: 'https://example.com/' }, unattended))).toBe(false);
    expect(isError(await tool.execute({ command: 'click', ref: 'e3' }, unattended))).toBe(false);
    // "read a page that is already open without one": the page is now on a site with no grant.
    s.factory.sessions[0]!.navigate('https://elsewhere.test/', 'Elsewhere');
    expect(await tool.execute({ command: 'snapshot' }, unattended)).toMatchObject({ url: 'https://elsewhere.test/' });
    expect(isError(await tool.execute({ command: 'scroll', direction: 'down' }, unattended))).toBe(false);
    // Reading is all: acting on that page, or opening another on its site, is refused.
    expect(isError(await tool.execute({ command: 'click', ref: 'e3' }, unattended), 'approval_unavailable')).toBe(true);
    expect(isError(await tool.execute({ command: 'open', url: 'https://elsewhere.test/next' }, unattended), 'approval_unavailable')).toBe(true);
    // 'with "Ask on changes"': under "always ask" the read is refused too.
    const strict = await s.browser(policy({ approvalMode: 'always_ask' }));
    expect(isError(await strict.execute({ command: 'snapshot' }, unattended), 'approval_unavailable')).toBe(true);
    expect(s.cards).toEqual([]);
  });

  it("refuses the relayed browser the same way, and never hands it to Claude Code's auto mode", async () => {
    const s = setup({ answer: 'once' });
    const [spec] = (await s.provider.relayTools(policy()));
    const outcome = await s.provider.requestApproval(spec!, { command: 'open', url: 'https://example.com/' }, policy(), ctx({ unattended: true }), { deferAsk: true });
    expect(outcome).toEqual({ allowed: false, reason: UNATTENDED_REASON });
    // With someone watching, auto mode still doesn't get it: the card is OtherBench's.
    const watched = await s.provider.requestApproval(spec!, { command: 'open', url: 'https://example.com/' }, policy(), ctx(), { deferAsk: true });
    expect(watched).toMatchObject({ allowed: true, grantedBy: 'ask:once', args: { command: 'open', url: 'https://example.com/', host: 'example.com' } });
    expect(s.cards).toHaveLength(1);
  });
});

// --- sub-agents ---------------------------------------------------------------

const finish: EngineEvent = { type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
const connection: Connection = { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null };
const row = (id: string, name: string, toolPolicy: ToolPolicy): Profile => ({ id, name, description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1', systemPrompt: null, params: {}, toolPolicy, isDefault: false, archivedAt: null });
const resolve = (p: Profile): ResolvedProfile => ({ ...p, connection, apiKey: null, model: null });

interface TurnOptions {
  parent?: Partial<ToolPolicy>;
  /** A second profile, "Other", for the sub-agent to run as. */
  other?: Partial<ToolPolicy>;
  /** Pages the parent reply opens itself before it starts the sub-agent. */
  parentOpens?: string[];
  /** What the sub-agent does with its browser, in order. */
  subCalls?: Record<string, unknown>[];
  planMode?: boolean;
  unattended?: boolean;
  answer?: ApprovalChoice['choice'];
  grants?: Grant[];
}

async function turn(o: TurnOptions = {}) {
  const store = new InMemoryStore();
  store.connections.create(connection);
  const main = row('p-main', 'Main', policy({ subagents: true, ...o.parent }));
  store.profiles.create(main);
  const other = o.other ? row('p-other', 'Other', policy({ subagents: true, ...o.other })) : null;
  if (other) store.profiles.create(other);
  const factory = new FakeFactory();
  const proxy = fakeProxy();
  const manager = new BrowserManager({ factory, startProxy: proxy.start });
  const broker = new PermissionBroker(store);
  const provider = new OtherBenchToolProvider(store, broker, emptyMcp, { browser: manager });
  const cards: ApprovalRequest[] = [];
  provider.onApprovalEvent((e: ToolApprovalEvent) => {
    if (e.type !== 'request') return;
    cards.push(e.request);
    provider.resolveApproval(e.request.id, { choice: o.answer ?? 'deny' } as ApprovalChoice);
  });
  for (const grant of o.grants ?? []) store.grants.create(grant);
  store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p-main', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, planMode: o.planMode === true, autoMode: false });

  const seen = { parent: undefined as unknown, parentOpened: [] as unknown[], child: null as EngineRequest | null, offered: [] as string[], results: [] as unknown[] };
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      if (req.subagent) {
        seen.child = req;
        seen.offered = req.tools.map((t) => t.name);
        const tool = req.tools.find((t) => t.name === 'browser');
        for (const [i, args] of (o.subCalls ?? []).entries()) {
          seen.results.push(tool ? await tool.execute(args, toolContextFor(req, req.signal, `sub-${i}`)) : 'not offered');
        }
        yield { type: 'text-delta', text: 'Finished.' };
        yield finish;
        return;
      }
      const browser = req.tools.find((t) => t.name === 'browser');
      for (const [i, url] of (o.parentOpens ?? []).entries()) {
        seen.parentOpened.push(browser ? await browser.execute({ command: 'open', url }, toolContextFor(req, req.signal, `open-${i}`)) : 'not offered');
      }
      const tool = req.tools.find((t) => t.name === 'subagent');
      seen.parent = tool
        ? await tool.execute({ description: 'Helper', prompt: 'Do the work.', ...(other ? { profile: 'Other' } : {}) }, toolContextFor(req, req.signal, 'call-1'))
        : 'not offered';
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
    chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [resolve(main)],
    ...(o.unattended ? { unattended: true } : {}),
  });
  await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete'));
  return { store, broker, seen, cards, factory, proxy, audit: store.audit.list('chat-1') };
}

const openOf = (url: string): Record<string, unknown> => ({ command: 'open', url });

describe("a sub-agent and the model's browser", () => {
  it('gets the browser only when both the parent and the profile it runs as have it on', async () => {
    const both = await turn({ other: {}, subCalls: [] });
    expect(both.seen.parent).toBe('Finished.');
    expect(both.seen.offered).toContain('browser');
    expect(both.seen.child!.profile.toolPolicy).toMatchObject({ browser: true, browserBlockedHosts: [] });

    const parentOnly = await turn({ other: { browser: false }, subCalls: [openOf('https://example.com/')], answer: 'once' });
    expect(parentOnly.seen.offered).not.toContain('browser');
    expect(parentOnly.seen.child!.profile.toolPolicy.browser).toBe(false);

    // The chosen profile alone can't give it one: a parent with the browser off has no browser to pass on.
    const chosenOnly = await turn({ parent: { browser: false }, other: { browser: true }, subCalls: [openOf('https://example.com/')], answer: 'once' });
    expect(chosenOnly.seen.parent).toBe('Finished.');
    expect(chosenOnly.seen.offered).not.toContain('browser');
    expect(chosenOnly.factory.sessions).toHaveLength(0);
    expect(chosenOnly.cards).toEqual([]);

    // As its own profile it simply has the parent's.
    const own = await turn({ subCalls: [] });
    expect(own.seen.offered).toContain('browser');
  });

  it('may use no site either profile blocks: the broker refuses it before any card, and the proxy is given both lists', async () => {
    const r = await turn({
      parent: { browserBlockedHosts: ['ads.test'] },
      other: { browserBlockedHosts: ['casino.test'] },
      subCalls: [openOf('https://ads.test/'), openOf('https://play.casino.test/'), openOf('https://example.com/')],
      answer: 'once',
    });
    expect(r.seen.child!.profile.toolPolicy.browserBlockedHosts).toEqual(['ads.test', 'casino.test']);
    expect(isError(r.seen.results[0], 'permission_denied')).toBe(true);
    expect(messageOf(r.seen.results[0])).toBe('ads.test is blocked for this profile.');
    expect(isError(r.seen.results[1], 'permission_denied')).toBe(true);
    expect(messageOf(r.seen.results[1])).toBe('play.casino.test is blocked for this profile.');
    expect(isError(r.seen.results[2])).toBe(false);
    // One card, for the site neither blocks, naming the sub-agent.
    expect(r.cards.map((c) => [c.summary, c.subagent?.label, c.subagent?.profileName])).toEqual([['Use example.com: open https://example.com/', 'Helper', 'Other']]);
    const session = r.factory.sessions[0]!;
    expect(session.actions).toEqual(['open https://example.com/']);
    // What the page itself may fetch is held to both lists too.
    const check = r.proxy.options().check;
    expect(check(session.proxy.username, 'ads.test', 443)).toBe('ads.test is blocked for this profile.');
    expect(check(session.proxy.username, 'cdn.casino.test', 443)).toBe('cdn.casino.test is blocked for this profile.');
    expect(check(session.proxy.username, 'example.com', 443)).toBeNull();
  });

  it("never uses a site grant of the profile it runs as; the parent's counts, and its own answer is stored under the parent's profile", async () => {
    const chosenHasGrant = await turn({ other: {}, subCalls: [openOf('https://example.com/')], answer: 'chat', grants: [siteGrant('g-other', 'example.com', 'p-other')] });
    expect(chosenHasGrant.cards).toHaveLength(1);
    expect(isError(chosenHasGrant.seen.results[0])).toBe(false);
    const made = chosenHasGrant.store.grants.list().filter((g) => g.id !== 'g-other');
    expect(made).toEqual([expect.objectContaining({ profileId: 'p-main', chatId: 'chat-1', source: 'browser', scope: 'chat', constraint: { host: 'example.com' } })]);

    const parentHasGrant = await turn({ other: {}, subCalls: [openOf('https://example.com/')], answer: 'deny', grants: [siteGrant('g-main', 'example.com', 'p-main')] });
    expect(parentHasGrant.cards).toEqual([]);
    expect(isError(parentHasGrant.seen.results[0])).toBe(false);
    expect(parentHasGrant.audit.find((a) => a.toolName === 'browser')).toMatchObject({ grantedBy: 'grant:g-main' });
  });

  it("asks before every browser call when either profile asks before every call", async () => {
    // The parent reads without a card; run as an always-ask profile, the sub-agent's read of the same page asks.
    const r = await turn({
      other: { approvalMode: 'always_ask' },
      parentOpens: ['https://example.com/'],
      subCalls: [{ command: 'snapshot' }],
      answer: 'once',
    });
    expect(isError(r.seen.parentOpened[0])).toBe(false);
    expect(isError(r.seen.results[0])).toBe(false);
    expect(r.cards.map((c) => [c.summary, c.subagent?.label ?? null])).toEqual([
      ['Use example.com: open https://example.com/', null],
      ['Use example.com: read the page', 'Helper'],
    ]);
  });

  it("is held to its parent's plan gate: it may read the page the chat has open, and open or change nothing", async () => {
    const r = await turn({
      planMode: true,
      subCalls: [openOf('https://example.com/'), { command: 'snapshot' }],
      grants: [siteGrant('g-main', 'example.com')],
      answer: 'once',
    });
    expect(r.seen.parent).toBe('Finished.');
    expect(r.seen.child!.plan!.approved).toBe(false);
    expect(isError(r.seen.results[0], 'plan_mode')).toBe(true);
    expect(messageOf(r.seen.results[0])).toBe(PLAN_REFUSAL);
    // No page is open, so there is nothing to read either: refused before the broker, as for any reply.
    expect(isError(r.seen.results[1], 'permission_denied')).toBe(true);
    expect(r.factory.sessions).toHaveLength(0);
    expect(r.cards).toEqual([]);
    expect(r.audit.filter((a) => a.toolName === 'browser').map((a) => a.grantedBy)).toEqual(['deny:plan', 'deny:policy']);
  });

  it("is unattended in a scheduled run: a new site is refused without a card, and a site the parent's profile has an Always grant for works", async () => {
    const r = await turn({
      unattended: true,
      subCalls: [openOf('https://other.test/'), openOf('https://example.com/')],
      grants: [siteGrant('g-main', 'example.com')],
      answer: 'once',
    });
    expect(r.seen.child!.unattended).toBe(true);
    expect(isError(r.seen.results[0], 'approval_unavailable')).toBe(true);
    expect(messageOf(r.seen.results[0])).toBe(UNATTENDED_REASON);
    expect(isError(r.seen.results[1])).toBe(false);
    expect(r.cards).toEqual([]);
    expect(r.audit.filter((a) => a.toolName === 'browser').map((a) => a.grantedBy)).toEqual(['deny:unattended', 'grant:g-main']);
  });

  it("shares the chat's one browser with the reply that started it: same page, same holder", async () => {
    const r = await turn({ parentOpens: ['https://example.com/'], subCalls: [{ command: 'snapshot' }, { command: 'click', ref: 'e3' }], grants: [siteGrant('g-main', 'example.com')] });
    expect(isError(r.seen.parentOpened[0])).toBe(false);
    expect(r.seen.results[0]).toMatchObject({ url: 'https://example.com/' });
    expect(isError(r.seen.results[1])).toBe(false);
    // One browser for the chat, used by both: the sub-agent's click landed on the page the parent opened.
    expect(r.factory.sessions).toHaveLength(1);
    expect(r.factory.sessions[0]!.actions).toEqual(['open https://example.com/', 'click e3']);
  });
});
