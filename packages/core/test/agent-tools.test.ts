import { describe, expect, it } from 'vitest';
import { agentDisallowedTools, agentPolicyDenial, classifyAgentTool } from '../src/domain/agent-tools.js';
import type { ToolPolicy } from '../src/types/config.js';

const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', ...o });

describe('classifyAgentTool', () => {
  it.each([
    ['Read', 'file-read', 'read'], ['Glob', 'file-read', 'read'], ['Grep', 'file-read', 'read'], ['LS', 'file-read', 'read'], ['NotebookRead', 'file-read', 'read'],
    ['Edit', 'file-write', 'mutate'], ['Write', 'file-write', 'mutate'], ['MultiEdit', 'file-write', 'mutate'], ['NotebookEdit', 'file-write', 'mutate'],
    ['Bash', 'shell', 'execute'], ['BashOutput', 'shell', 'execute'], ['KillShell', 'shell', 'execute'],
    ['WebFetch', 'web', 'mutate'], ['WebSearch', 'web', 'mutate'],
    ['mcp__nextcloud__deck_add_card', 'mcp', 'mutate'],
    ['TodoWrite', 'internal', 'read'], ['Task', 'internal', 'read'], ['Agent', 'internal', 'read'], ['ExitPlanMode', 'internal', 'read'],
    ['SomethingNew', 'other', 'mutate'],
  ])('%s -> %s/%s', (name, category, risk) => {
    expect(classifyAgentTool(name)).toEqual({ category, risk });
  });
});

describe('agentPolicyDenial', () => {
  it('denies writes under read-only fs and everything file-related under fs off', () => {
    expect(agentPolicyDenial('Edit', policy({ fs: 'read' }))).toMatch(/read/);
    expect(agentPolicyDenial('Read', policy({ fs: 'read' }))).toBeNull();
    expect(agentPolicyDenial('Read', policy({ fs: 'off' }))).toMatch(/disabled/);
  });
  it('honours shell, web and mcp switches; absent flags allow', () => {
    expect(agentPolicyDenial('Bash', policy({ shell: false }))).toMatch(/Bash/);
    expect(agentPolicyDenial('WebFetch', policy({ agentWeb: false }))).toMatch(/Web/);
    expect(agentPolicyDenial('WebFetch', policy())).toBeNull();
    expect(agentPolicyDenial('mcp__x__y', policy({ agentMcp: false }))).toMatch(/MCP/);
    expect(agentPolicyDenial('mcp__x__y', policy())).toBeNull();
    expect(agentPolicyDenial('SomethingNew', policy({ fs: 'off', shell: false }))).toBeNull();
  });
});

describe('agentDisallowedTools', () => {
  it('always removes AskUserQuestion', () => {
    expect(agentDisallowedTools(policy())).toEqual(['AskUserQuestion']);
  });
  it('removes tools the policy forbids', () => {
    const list = agentDisallowedTools(policy({ fs: 'off', shell: false, agentWeb: false }));
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch']) {
      expect(list).toContain(t);
    }
  });
});
