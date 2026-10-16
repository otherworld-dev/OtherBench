import type { RiskClass } from '../ports/tool-provider.js';
import type { ToolPolicy } from '../types/config.js';

/**
 * How OtherBench treats each Claude Code built-in tool. Claude Code executes these
 * itself; OtherBench only decides whether each call may run (PermissionBroker,
 * `source: 'agent'`). Anything unrecognised is `other`/`mutate` so a new
 * Claude Code tool fails closed into an approval card.
 */
export type AgentToolCategory = 'file-read' | 'file-write' | 'shell' | 'web' | 'mcp' | 'internal' | 'other';

const FILE_READ = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
const FILE_WRITE = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SHELL = ['Bash', 'BashOutput', 'KillShell', 'PowerShell', 'Monitor'];
const MCP_RESOURCE = ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'];
const WEB = ['WebFetch', 'WebSearch'];
// No side effects of their own; a Task/Agent subagent's own tool calls are gated
// individually. AskUserQuestion is answered through OtherBench's question card (the
// engine's gate, spec 2026-10-12-thread-cards-design section 6). SubagentHandback is
// how a subagent hands its final report back to the agent that started it (Claude
// Code gives subagents it in auto mode): it carries text and touches nothing else.
const INTERNAL = ['TodoWrite', 'Task', 'Agent', 'ToolSearch', 'Skill', 'AskUserQuestion', 'SubagentHandback'];
// Claude Code's own plan mode writes its plan outside the workspace and switches
// the session's permission mode, which OtherBench doesn't track; OtherBench's Plan mode
// (propose_plan) replaces it. Out of INTERNAL too, so a call that somehow
// arrives is `other` and gets a card.
const ALWAYS_DISALLOWED = ['EnterPlanMode', 'ExitPlanMode'];

/** The internal tools a clean chat (no folder) is given besides web search and fetch. */
export const CLEAN_CHAT_AGENT_TOOLS: readonly string[] = ['TodoWrite', 'AskUserQuestion'];

/** Argument keys Claude Code tools use for a filesystem path. */
export const AGENT_PATH_ARG_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/**
 * True for a workspace-relative path that Claude Code itself reads as
 * configuration: anything under a `.claude` directory (settings and
 * settings.local.json with their hooks, skills, commands, agents), a
 * `.mcp.json` file, or a `CLAUDE.md` / `CLAUDE.local.md` file in any
 * directory. Writing one of these can make Claude Code run commands on a later
 * turn with no Bash card (a hook, a skill's inline shell, an MCP server
 * command), so the broker never lets a stored grant cover a write to one.
 *
 * Case-insensitive, and each segment is compared the way Windows opens it:
 * trailing dots and spaces dropped, and an NTFS stream suffix (`:$DATA`) cut,
 * so `.claude./settings.json` or `CLAUDE.md::$DATA` still count. Pass the
 * path relative to the workspace root -- an absolute path would match a
 * `.claude` directory the workspace itself happens to sit under.
 *
 * Any segment that looks like a Windows 8.3 short name (`CLAUDE~1`,
 * `MCP~1.JSO`) also counts. `containPath` resolves with `realpathSync`, which
 * leaves short names unexpanded, so `CLAUDE~1/settings.local.json` would
 * otherwise reach here looking harmless while Windows opens
 * `.claude/settings.local.json`. A short name can't be mapped back to its long
 * name without the filesystem, so this fails closed: a write through any
 * short-name segment always gets a card.
 */
export function isProtectedAgentPath(relPath: string): boolean {
  const segments = relPath
    .split(/[\\/]+/)
    .map((s) => s.replace(/:.*$/, '').replace(/[. ]+$/, '').toLowerCase())
    .filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return (
    segments.includes('.claude') ||
    segments.some((s) => /~\d/.test(s)) ||
    last === '.mcp.json' ||
    last === 'claude.md' ||
    last === 'claude.local.md'
  );
}

export function classifyAgentTool(name: string): { category: AgentToolCategory; risk: RiskClass } {
  if (FILE_READ.includes(name)) return { category: 'file-read', risk: 'read' };
  if (FILE_WRITE.includes(name)) return { category: 'file-write', risk: 'mutate' };
  if (SHELL.includes(name)) return { category: 'shell', risk: 'execute' };
  if (WEB.includes(name)) return { category: 'web', risk: 'mutate' };
  if (name.startsWith('mcp__') || MCP_RESOURCE.includes(name)) return { category: 'mcp', risk: 'mutate' };
  if (INTERNAL.includes(name)) return { category: 'internal', risk: 'read' };
  return { category: 'other', risk: 'mutate' };
}

/** The policy-ceiling check for an agent tool; null = policy permits it. */
export function agentPolicyDenial(name: string, policy: ToolPolicy): string | null {
  switch (classifyAgentTool(name).category) {
    case 'file-read':
      return policy.fs === 'off' ? 'File tools are disabled by policy.' : null;
    case 'file-write':
      return policy.fs === 'readwrite' ? null : `"${name}" changes files, but policy only permits ${policy.fs === 'off' ? 'no' : 'read'} file access.`;
    case 'shell':
      if (!policy.shell) return 'Shell (Bash) is disabled by policy.';
      return policy.shellRuns === 'sandbox' ? "This profile runs shell commands in OtherBench's sandbox: use the run_command tool instead." : null;
    case 'web':
      return policy.agentWeb === false ? 'Web tools are disabled by policy.' : null;
    case 'mcp':
      return policy.agentMcp === false ? 'MCP tools are disabled by policy.' : null;
    case 'internal':
    case 'other':
      return null;
  }
}

/**
 * Tools to hide from Claude Code entirely (SDK `disallowedTools`), so the
 * model isn't offered tools every call to which would be denied. Individual
 * `mcp__*` tools are not listed here: under `agentMcp: false` the engine loads
 * no MCP servers at all (`strictMcpConfig`), and the gate still denies any
 * MCP call (agentPolicyDenial).
 */
export function agentDisallowedTools(policy: ToolPolicy): string[] {
  const out = [...ALWAYS_DISALLOWED];
  if (policy.fs !== 'readwrite') out.push(...FILE_WRITE);
  if (policy.fs === 'off') out.push(...FILE_READ);
  // Under the sandbox, OtherBench's sandboxed run_command (relayed) is the shell.
  if (!policy.shell || policy.shellRuns === 'sandbox') out.push(...SHELL);
  if (policy.agentWeb === false) out.push(...WEB);
  if (policy.agentMcp === false) out.push(...MCP_RESOURCE);
  return out;
}
