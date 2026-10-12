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

  it('fails closed for a source it has never heard of', () => {
    expect(allowedWhilePlanning(tool('teleport', 'teleport' as ToolSource, 'read'))).toBe(false);
  });
});
