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

  it('fails closed for a source it has never heard of', () => {
    expect(allowedWhilePlanning(tool('teleport', 'teleport' as ToolSource, 'read'))).toBe(false);
  });
});
