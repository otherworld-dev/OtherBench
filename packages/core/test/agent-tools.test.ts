import { describe, expect, it } from 'vitest';
import { CLEAN_CHAT_AGENT_TOOLS, agentDisallowedTools, agentPolicyDenial, classifyAgentTool, hasShortNameSegment, isProtectedAgentPath, isSecretAgentPath } from '../src/domain/agent-tools.js';
import type { ToolPolicy } from '../src/types/config.js';

const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', ...o });

describe('classifyAgentTool', () => {
  it.each([
    ['Read', 'file-read', 'read'], ['Glob', 'file-read', 'read'], ['Grep', 'file-read', 'read'], ['LS', 'file-read', 'read'], ['NotebookRead', 'file-read', 'read'],
    ['Edit', 'file-write', 'mutate'], ['Write', 'file-write', 'mutate'], ['MultiEdit', 'file-write', 'mutate'], ['NotebookEdit', 'file-write', 'mutate'],
    ['Bash', 'shell', 'execute'], ['BashOutput', 'shell', 'execute'], ['KillShell', 'shell', 'execute'],
    ['WebFetch', 'web', 'mutate'], ['WebSearch', 'web', 'mutate'],
    ['mcp__nextcloud__deck_add_card', 'mcp', 'mutate'],
    ['TodoWrite', 'internal', 'read'], ['Task', 'internal', 'read'], ['Agent', 'internal', 'read'], ['AskUserQuestion', 'internal', 'read'], ['SubagentHandback', 'internal', 'read'], ['SendMessage', 'agent-message', 'mutate'],
    ['ExitPlanMode', 'other', 'mutate'], ['EnterPlanMode', 'other', 'mutate'],
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
  it("always removes Claude Code's own plan mode tools, and no longer AskUserQuestion", () => {
    expect(agentDisallowedTools(policy())).toEqual(['EnterPlanMode', 'ExitPlanMode']);
  });
  it('lists the internal tools a clean chat gets', () => expect(CLEAN_CHAT_AGENT_TOOLS).toEqual(['TodoWrite', 'AskUserQuestion', 'ToolSearch']));
  it('removes tools the policy forbids', () => {
    const list = agentDisallowedTools(policy({ fs: 'off', shell: false, agentWeb: false }));
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch']) {
      expect(list).toContain(t);
    }
  });
});

describe('isProtectedAgentPath', () => {
  it.each([
    '.claude/settings.local.json', '.claude/settings.json', '.claude', '.claude/skills/x/SKILL.md', '.claude/commands/go.md',
    '.claude/agents/a.md', '.claude/hooks/h.sh', 'sub/.claude/settings.json', 'sub\\.Claude\\settings.json', '.CLAUDE/x',
    '.mcp.json', 'pkg/.MCP.json', 'CLAUDE.md', 'docs/claude.md', 'CLAUDE.local.md', 'a/b/Claude.Local.MD',
    // Windows opens these as the same files.
    '.claude./settings.json', '.claude /settings.json', 'CLAUDE.md.', 'CLAUDE.md::$DATA', '.mcp.json ',
    // 8.3 short names: containPath's realpathSync does not expand them, and
    // Windows opens CLAUDE~1 as .claude (or CLAUDE.local.md), MCP~1.JSO as .mcp.json.
    'CLAUDE~1/settings.local.json', 'claude~2\\settings.json', 'CLAUDE~1.MD', 'docs/CLAUDE~1.MD', 'MCP~1.JSO', 'sub/CLAUDE~12/x',
  ])('protects %s', (p) => {
    expect(isProtectedAgentPath(p)).toBe(true);
  });
  it.each(['src/a.ts', '.', 'README.md', 'claude.mdx', 'my.claude/x', '.claudex/settings.json', 'mcp.json', '.mcp.json.bak', 'CLAUDE.md/inner.txt', 'docs/CLAUDE-notes.md'])('does not protect %s', (p) => {
    expect(isProtectedAgentPath(p)).toBe(false);
  });

  // The claude-setup standard's data folders: Claude Code never loads private/
  // or scratch/, and memory/ holds plain notes. Everything else under .claude stays protected.
  it.each([
    '.claude/private/plan.md', '.claude/private/specs/2026-10-18-x-design.md',
    '.claude/memory/MEMORY.md', '.claude/memory/user_role.md', '.Claude/Private/x.md', 'sub/.claude/private/x.md',
    '.claude/private./x.md',
    '.claude/scratch/unlink-check.php', '.claude/scratch/probe/run.sh', '.Claude/Scratch/x.png', 'sub/.claude/scratch/x.txt',
    // Claude Code's own exemptions: its helpers' worktrees, and agent memory notes.
    '.claude/worktrees/agent-ac386f1830c42d696/crates/schema-gen/tests/read_xsd.rs', '.claude/worktrees/x/src/main.ts', '.Claude/Worktrees/x/a.txt',
    '.claude/agent-memory/reviewer/notes.md', '.claude/agent-memory/MEMORY.md',
  ])('treats %s as data', (p) => {
    expect(isProtectedAgentPath(p)).toBe(false);
  });
  it.each([
    '.claude/private', '.claude/history', '.claude/memory', '.claude/memory/notes.txt', '.claude/memory/sub/x.md', '.claude/memory/settings.json',
    '.claude/private/.claude/settings.json', '.claude/history/x/.claude/hooks/h.sh', '.claude/private/CLAUDE.md', '.claude/memory/CLAUDE.md',
    '.claude/private/.mcp.json', '.claude/memory/CLAUDE~1.MD', 'CLAUDE~1/private/x.md', '.claude/PRIVAT~1/x.md', '.claude/certificates/key.pem',
    '.claude/specs/x.md', '.claude/rules/r.md', '.claude/setup-version',
    // history/ is copied back into Claude Code's session store by /pull, so a transcript there is resumed.
    '.claude/history/abc.jsonl', '.claude/history/abc/tool-results/1.txt',
    // A raw path key isn't resolved: a `..` after the data folder fails closed.
    '.claude/private/../settings.json', '.claude/private/x/../../hooks/h.sh', '.claude/memory/../x.md', '.claude\\private\\..\\settings.json',
    '.claude/private/.../x.md', '.claude/private/.. /settings.json',
    // scratch/ gets the same limits as private/.
    '.claude/scratch', '.claude/scratch/.claude/settings.json', '.claude/scratch/CLAUDE.md', '.claude/scratch/.mcp.json',
    '.claude/SCRATC~1/x.php', '.claude/scratch/../settings.json', '.claude/tmp/x.txt',
    // A worktree is a checkout of the repo: its own Claude Code config is still config.
    '.claude/worktrees', '.claude/worktrees/x/.claude/settings.json', '.claude/worktrees/x/.claude/hooks/h.sh', '.claude/worktrees/x/CLAUDE.md',
    '.claude/worktrees/x/.mcp.json', '.claude/worktrees/../settings.json', '.claude/WORKTR~1/x/a.ts',
    '.claude/agent-memory', '.claude/agent-memory/reviewer/hook.sh', '.claude/agent-memory/settings.json',
  ])('still protects %s', (p) => {
    expect(isProtectedAgentPath(p)).toBe(true);
  });
});

describe('isSecretAgentPath', () => {
  it.each([
    '.claude/certificates/key.pem', '.claude/certificates', 'sub/.claude/certificates/a/b.p12', '.Claude/Certificates/x', '.claude./certificates /x',
    '.env', '.env.local', '.env.production', 'app/.env', 'E:\\Git\\X\\.env', 'E:/Git/X/.claude/certificates/k', '.ENV', '.env.', '.env::$DATA',
  ])('keeps %s from Claude Code', (p) => {
    expect(isSecretAgentPath(p)).toBe(true);
  });
  it.each(['.envrc', 'env', 'x.env', '.environment', 'certificates/key.pem', '.claude/private/certificates.md', 'src/.env-loader.ts', '.'])('lets %s through', (p) => {
    expect(isSecretAgentPath(p)).toBe(false);
  });
});

describe('R7 additions', () => {
  it.each([
    ['PowerShell', 'shell', 'execute'], ['Monitor', 'shell', 'execute'],
    ['ToolSearch', 'internal', 'read'], ['Skill', 'internal', 'read'],
    ['ListMcpResourcesTool', 'mcp', 'mutate'], ['ReadMcpResourceTool', 'mcp', 'mutate'], ['ReadMcpResourceDirTool', 'mcp', 'mutate'],
  ])('%s -> %s/%s', (name, category, risk) => {
    expect(classifyAgentTool(name)).toEqual({ category, risk });
  });
  it('shell:false denies and hides PowerShell and Monitor', () => {
    expect(agentPolicyDenial('PowerShell', policy({ shell: false }))).not.toBeNull();
    expect(agentDisallowedTools(policy({ shell: false }))).toEqual(expect.arrayContaining(['PowerShell', 'Monitor']));
    expect(agentPolicyDenial('ListMcpResourcesTool', policy({ agentMcp: false }))).toMatch(/MCP/);
  });
  it('agentMcp:false hides the MCP resource tools', () => {
    expect(agentDisallowedTools(policy({ agentMcp: false }))).toEqual(expect.arrayContaining(['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool']));
    expect(agentDisallowedTools(policy())).not.toContain('ListMcpResourcesTool');
  });
});

describe('hasShortNameSegment', () => {
  it.each(['CERTIF~1/k.pem', '.claude/CERTIF~1/k', 'ENV~1', 'ENVLOC~1.LOC', 'CLAUDE~12/x'])('sees a short name in %s', (p) => {
    expect(hasShortNameSegment(p)).toBe(true);
  });
  it.each(['notes~1.txt.bak', 'my-long-name~1.txt', 'a~b', '.env~1', 'src/x.ts'])('sees none in %s', (p) => {
    expect(hasShortNameSegment(p)).toBe(false);
  });
});
