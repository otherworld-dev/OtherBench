import { describe, expect, it } from 'vitest';
import { classifyAgentTool } from '../src/domain/agent-tools.js';
import { allowedWhilePlanning, PermissionBroker } from '../src/domain/permissions.js';
import { createPlanGate, PLAN_REFUSAL } from '../src/domain/thread-tools.js';
import type { RiskClass, ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import type { ToolPolicy, ToolSource } from '../src/types/config.js';

const tool = (name: string, source: ToolSource, risk: RiskClass, o: Partial<ToolSpec> = {}): ToolSpec => ({ name, description: '', parameters: {}, risk, source, execute: async () => null, ...o });
const agent = (name: string): ToolSpec => tool(name, 'agent', classifyAgentTool(name).risk);
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, mcpServerIds: ['srv-1'], approvalMode: 'ask_on_mutate', ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'c1', messageId: 'm1', profileId: 'p1', workspaceRoot: '/ws', signal: new AbortController().signal, ...o });
const planning = () => ctx({ plan: createPlanGate() });

describe('plan mode in the broker', () => {
  it('refuses anything that could change something, with no card and the plan flag', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const refused = [
      tool('write_file', 'fs', 'mutate'),
      tool('run_command', 'shell', 'execute'),
      tool('mcp__srv__send', 'mcp', 'mutate', { serverId: 'srv-1' }),
      agent('Write'),
      agent('Bash'),
      agent('mcp__github__create_issue'),
      agent('SomethingNew'),
    ];
    for (const t of refused) {
      expect(b.decide(t, { path: 'a.txt', command: 'ls' }, policy(), planning())).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
    }
    expect(b.pendingCount).toBe(0);
  });

  it('lets reads, web, internal, artifact, recall and thread calls reach their usual outcome', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(tool('read_file', 'fs', 'read'), { path: 'a.txt' }, policy(), planning())).toMatchObject({ kind: 'allow', grantedBy: 'auto_read' });
    expect(b.decide(tool('mcp__srv__get', 'mcp', 'read', { serverId: 'srv-1' }), {}, policy(), planning())).toMatchObject({ kind: 'allow' });
    expect(b.decide(agent('Read'), { path: 'a.txt' }, policy(), planning())).toMatchObject({ kind: 'allow', grantedBy: 'auto_read' });
    expect(b.decide(agent('WebFetch'), { url: 'https://example.com' }, policy(), planning()).kind).toBe('ask');
    expect(b.decide(agent('TodoWrite'), {}, policy(), planning())).toMatchObject({ kind: 'allow', grantedBy: 'policy' });
    expect(b.decide(tool('artifact', 'artifact', 'read'), {}, policy(), planning())).toMatchObject({ kind: 'allow' });
    expect(b.decide(tool('recall', 'recall', 'read'), { command: 'search', query: 'x' }, policy(), planning()).kind).toBe('ask');
    expect(b.decide(tool('ask_user', 'thread', 'read'), {}, policy(), planning())).toMatchObject({ kind: 'allow', grantedBy: 'policy' });
  });

  it('changes nothing once the plan is approved, or with no gate at all', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const gate = createPlanGate();
    gate.approve();
    expect(b.decide(tool('write_file', 'fs', 'mutate'), { path: 'a.txt' }, policy(), ctx({ plan: gate })).kind).toBe('ask');
    expect(b.decide(tool('write_file', 'fs', 'mutate'), { path: 'a.txt' }, policy(), ctx()).kind).toBe('ask');
  });

  it('still applies the policy ceiling first', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const decision = b.decide(tool('run_command', 'shell', 'execute'), { command: 'ls' }, policy({ shell: false }), planning());
    expect(decision.kind).toBe('deny');
    expect(decision).not.toHaveProperty('plan');
  });

  it('allows thread tools by policy even under "always ask"', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(tool('update_todos', 'thread', 'read'), {}, policy({ approvalMode: 'always_ask' }), ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
  });

  it("lets a clean chat's internal Claude Code tools through without a folder, but not Bash", () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(agent('TodoWrite'), {}, policy(), ctx({ workspaceRoot: null }))).toMatchObject({ kind: 'allow' });
    expect(b.decide(agent('Bash'), { command: 'ls' }, policy(), ctx({ workspaceRoot: null })).kind).toBe('deny');
  });

  it("refuses the sandbox's run_command and its network requests like the host shell, before the sandbox's no-card pass or any host grant", () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    const sandboxed = policy({ shellRuns: 'sandbox' });
    const runCommand = tool('run_command', 'sandbox', 'execute');
    const network = tool('sandbox_network', 'network', 'execute');
    store.grants.create({ id: 'g1', chatId: null, profileId: 'p1', toolName: 'sandbox_network', source: 'network', scope: 'always', constraint: { host: 'pypi.org' }, expiresAt: null });
    expect(allowedWhilePlanning(runCommand)).toBe(false);
    expect(allowedWhilePlanning(network)).toBe(false);
    for (const approvalMode of ['ask_on_mutate', 'always_ask'] as const) {
      const p = { ...sandboxed, approvalMode };
      expect(b.decide(runCommand, { command: 'touch x' }, p, planning())).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
      expect(b.decide(network, { host: 'pypi.org' }, p, planning())).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
    }
    expect(b.pendingCount).toBe(0);
    // Once the plan is approved both are back to what the sandbox decides: no card for the command, the grant for the host.
    const gate = createPlanGate();
    gate.approve();
    expect(b.decide(runCommand, { command: 'touch x' }, sandboxed, ctx({ plan: gate }))).toEqual({ kind: 'allow', grantedBy: 'sandbox' });
    expect(b.decide(network, { host: 'pypi.org' }, sandboxed, ctx({ plan: gate }))).toMatchObject({ kind: 'allow', grantedBy: 'grant', grantId: 'g1' });
  });

  // Integration with sub-agents: a planning reply may start one, and the
  // sub-agent's own calls meet the same gate (its request carries it).
  it('lets a planning reply start a sub-agent, when the profile has sub-agents on', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const subagent = tool('subagent', 'subagent', 'read');
    expect(allowedWhilePlanning(subagent)).toBe(true);
    for (const approvalMode of ['ask_on_mutate', 'always_ask'] as const) {
      expect(b.decide(subagent, { description: 'Look', prompt: 'Read it.' }, policy({ subagents: true, approvalMode }), planning())).toEqual({ kind: 'allow', grantedBy: 'policy' });
    }
    // The profile's switch still comes first, and a sub-agent still can't start another.
    expect(b.decide(subagent, {}, policy(), planning())).toEqual({ kind: 'deny', reason: 'Sub-agents are turned off for this profile.' });
    const nested = ctx({ plan: createPlanGate(), subagent: { callId: 'c1', label: 'Helper', parentProfileId: 'p1' } });
    expect(b.decide(subagent, {}, policy({ subagents: true }), nested)).toEqual({ kind: 'deny', reason: "A sub-agent can't start another sub-agent." });
    expect(b.pendingCount).toBe(0);
  });

  it("refuses a sub-agent's own changes while its parent's plan waits: files, the host shell, the sandbox, its network and MCP", () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    const gate = createPlanGate();
    const asSubagent = (): ToolContext => ctx({ plan: gate, subagent: { callId: 'c1', label: 'Helper', parentProfileId: 'p1', profileName: 'Other' } });
    // Grants that would otherwise let each one through with no card.
    store.grants.create({ id: 'g-write', chatId: null, profileId: 'p1', toolName: 'write_file', source: 'fs', scope: 'always', constraint: null, expiresAt: null });
    store.grants.create({ id: 'g-ls', chatId: null, profileId: 'p1', toolName: 'run_command', source: 'shell', scope: 'always', constraint: { commandExact: 'ls' }, expiresAt: null });
    store.grants.create({ id: 'g-host', chatId: null, profileId: 'p1', toolName: 'sandbox_network', source: 'network', scope: 'always', constraint: { host: 'pypi.org' }, expiresAt: null });
    const sandboxed = policy({ shellRuns: 'sandbox' });
    const refused: [ToolSpec, unknown, ToolPolicy][] = [
      [tool('write_file', 'fs', 'mutate'), { path: 'a.txt' }, policy()],
      [tool('run_command', 'shell', 'execute'), { command: 'ls' }, policy()],
      [tool('run_command', 'sandbox', 'execute'), { command: 'touch x' }, sandboxed],
      [tool('sandbox_network', 'network', 'execute'), { host: 'pypi.org' }, sandboxed],
      [tool('mcp__srv__send', 'mcp', 'mutate', { serverId: 'srv-1' }), {}, policy()],
    ];
    for (const [t, args, p] of refused) {
      for (const approvalMode of ['ask_on_mutate', 'always_ask'] as const) {
        expect(b.decide(t, args, { ...p, approvalMode }, asSubagent()), `${t.name} (${t.source})`).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
      }
    }
    expect(b.pendingCount).toBe(0);
    // It can still look around.
    expect(b.decide(tool('read_file', 'fs', 'read'), { path: 'a.txt' }, policy(), asSubagent())).toMatchObject({ kind: 'allow', grantedBy: 'auto_read' });
    // The same gate, approved by the user for the parent, opens them for the sub-agent too.
    gate.approve();
    expect(b.decide(tool('write_file', 'fs', 'mutate'), { path: 'a.txt' }, policy(), asSubagent())).toMatchObject({ kind: 'allow', grantedBy: 'grant', grantId: 'g-write' });
    expect(b.decide(tool('run_command', 'sandbox', 'execute'), { command: 'touch x' }, sandboxed, asSubagent())).toEqual({ kind: 'allow', grantedBy: 'sandbox' });
  });

  // Integration with the model's browser: a planning reply may read the page
  // that is already open, and nothing else.
  it('lets a planning reply read the open page, and refuses opening one and every change to it, with no card and whatever grants there are', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    const browser = (risk: RiskClass = 'mutate'): ToolSpec => tool('browser', 'browser', risk);
    const on = (o: Partial<ToolPolicy> = {}): ToolPolicy => policy({ browser: true, ...o });
    // An Always grant for the site, which would let every call below through with no card.
    store.grants.create({ id: 'g-site', chatId: null, profileId: 'p1', toolName: 'browser', source: 'browser', scope: 'always', constraint: { host: 'example.com' }, expiresAt: null });
    const page = { host: 'example.com', nav: 1 };
    const changes: Record<string, unknown>[] = [
      { command: 'open', url: 'https://example.com/?q=secret', host: 'example.com' },
      { command: 'click', ref: 'e1', gen: 1, ...page },
      { command: 'click', ref: 'e1', double: true, gen: 1, ...page },
      { command: 'type', ref: 'e2', text: 'hello', gen: 1, ...page },
      { command: 'type', ref: 'e2', text: 'hello', submit: true, gen: 1, ...page },
      { command: 'select', ref: 'e3', values: ['Red'], gen: 1, ...page },
      { command: 'press', key: 'Enter', ...page },
      { command: 'back', ...page },
      // No command, and one Grunt doesn't know: refused too.
      { ...page },
      { command: 'download', ...page },
    ];
    const reads: Record<string, unknown>[] = [{ command: 'snapshot', ...page }, { command: 'scroll', direction: 'down', ...page }, { command: 'close', host: 'example.com' }];
    for (const args of changes) expect(allowedWhilePlanning(browser(), args), JSON.stringify(args)).toBe(false);
    for (const args of reads) expect(allowedWhilePlanning(browser(), args), JSON.stringify(args)).toBe(true);
    // By command name, never by declared risk: a click that calls itself a read is still refused.
    expect(allowedWhilePlanning(browser('read'), { command: 'click', ref: 'e1', ...page })).toBe(false);
    expect(allowedWhilePlanning(browser('read'))).toBe(false);

    for (const approvalMode of ['ask_on_mutate', 'always_ask'] as const) {
      for (const args of changes) {
        for (const risk of ['mutate', 'read'] as const) {
          expect(b.decide(browser(risk), args, on({ approvalMode }), planning()), `${approvalMode}, ${JSON.stringify(args)}`).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
        }
      }
    }
    expect(b.pendingCount).toBe(0);
    // Reads go on to what the browser's own rules decide: no card under "ask on changes", the site's grant under "always ask".
    for (const args of reads) {
      expect(b.decide(browser('read'), args, on(), planning()), JSON.stringify(args)).toEqual({ kind: 'allow', grantedBy: 'auto_read' });
      expect(b.decide(browser('read'), args, on({ approvalMode: 'always_ask' }), planning()), JSON.stringify(args)).toMatchObject({ kind: 'allow', grantedBy: 'grant', grantId: 'g-site' });
    }
    // Plan mode only adds refusals: a blocked or local site and a switched-off browser are still refused as themselves.
    expect(b.decide(browser('read'), { command: 'snapshot', host: '192.168.1.1', nav: 1 }, on(), planning())).toMatchObject({ kind: 'deny', reason: expect.stringContaining('local or private') });
    expect(b.decide(browser('read'), { command: 'snapshot', ...page }, on({ browserBlockedHosts: ['example.com'] }), planning())).toMatchObject({ kind: 'deny', reason: 'example.com is blocked for this profile.' });
    expect(b.decide(browser('read'), { command: 'snapshot', ...page }, policy(), planning())).toEqual({ kind: 'deny', reason: 'The browser is turned off for this profile.' });
    // A site with no grant: a read under "always ask" raises its card as usual.
    const ask = b.decide(browser('read'), { command: 'snapshot', host: 'other.test', nav: 1 }, on({ approvalMode: 'always_ask' }), planning());
    expect(ask.kind).toBe('ask');
    if (ask.kind === 'ask') b.discard(ask.request.id);

    // Once the plan is approved the changes are back to the site's grant.
    const gate = createPlanGate();
    gate.approve();
    for (const args of changes.slice(0, 8)) {
      expect(b.decide(browser(), args, on(), ctx({ plan: gate })), JSON.stringify(args)).toMatchObject({ kind: 'allow', grantedBy: 'grant', grantId: 'g-site' });
    }
  });

  it("holds a sub-agent's browser to its parent's plan gate too", () => {
    const b = new PermissionBroker(new InMemoryStore());
    const asSubagent = ctx({ plan: createPlanGate(), subagent: { callId: 'c1', label: 'Helper', parentProfileId: 'p1' } });
    const on = policy({ browser: true });
    expect(b.decide(tool('browser', 'browser', 'mutate'), { command: 'open', url: 'https://example.com/', host: 'example.com' }, on, asSubagent)).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
    expect(b.decide(tool('browser', 'browser', 'read'), { command: 'snapshot', host: 'example.com', nav: 1 }, on, asSubagent)).toEqual({ kind: 'allow', grantedBy: 'auto_read' });
    expect(b.pendingCount).toBe(0);
  });

  it('refuses every computer action while the plan waits, the looks included, with no card and whatever grants there are', () => {
    // Integration (cowork-parity step 5). Fail closed: a look starts the control session (the shell's native dialog)
    // and sends whatever is on the screen to the model, so it is not treated like the browser's snapshot of an open page.
    const store = new InMemoryStore();
    const app = 'C:\\Program Files\\Fake App\\FakeApp.exe';
    store.grants.create({ id: 'g1', chatId: null, profileId: 'p1', toolName: 'computer', source: 'computer', scope: 'always', constraint: { app }, expiresAt: null });
    const b = new PermissionBroker(store);
    const on = policy({ computer: true });
    const computer = tool('computer', 'computer', 'mutate');
    const described = { app, appName: 'FakeApp.exe', appTitle: 'Fake', appRisk: 'normal', appShellView: false, appWindow: 'hwnd-1', appPid: 4242, appStarted: 't0' };
    const calls = [
      { action: 'screenshot', app: null },
      { action: 'cursor_position', app: null },
      { action: 'wait', duration: 1, app: null },
      { action: 'left_click', coordinate: [10, 20], ...described },
      { action: 'type', text: 'hello', ...described },
    ];
    for (const args of calls) {
      for (const risk of ['read', 'mutate'] as const) {
        expect(allowedWhilePlanning({ ...computer, risk }, args)).toBe(false);
        expect(b.decide({ ...computer, risk }, args, on, planning()), JSON.stringify(args)).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
      }
    }
    expect(b.pendingCount).toBe(0);
    // Approved: the look needs no card and the click goes on to its grant.
    const gate = createPlanGate();
    gate.approve();
    expect(b.decide({ ...computer, risk: 'read' }, calls[0], on, ctx({ plan: gate }))).toEqual({ kind: 'allow', grantedBy: 'policy' });
    expect(b.decide(computer, calls[3], on, ctx({ plan: gate }))).toMatchObject({ kind: 'allow', grantedBy: 'grant', grantId: 'g1' });
    // The policy ceiling still comes first.
    expect(b.decide(computer, calls[0], policy({ computer: false }), planning())).toEqual({ kind: 'deny', reason: 'Computer use is turned off for this profile.' });
  });

  it('fails closed for a source it has never heard of', () => {
    expect(allowedWhilePlanning(tool('teleport', 'teleport' as ToolSource, 'read'))).toBe(false);
  });
});
