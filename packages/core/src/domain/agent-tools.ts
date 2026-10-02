import type { RiskClass } from '../ports/tool-provider.js';
import type { ToolPolicy } from '../types/config.js';

/**
 * How Grunt treats each Claude Code built-in tool. Claude Code executes these
 * itself; Grunt only decides whether each call may run (PermissionBroker,
 * `source: 'agent'`). Anything unrecognised is `other`/`mutate` so a new
 * Claude Code tool fails closed into an approval card.
 */
export type AgentToolCategory = 'file-read' | 'file-write' | 'shell' | 'web' | 'mcp' | 'internal' | 'other';

const FILE_READ = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
const FILE_WRITE = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SHELL = ['Bash', 'BashOutput', 'KillShell', 'PowerShell', 'Monitor'];
const MCP_RESOURCE = ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'];
const WEB = ['WebFetch', 'WebSearch'];
// No side effects of their own; a Task/Agent subagent's own tool calls are gated individually.
const INTERNAL = ['TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode', 'ToolSearch', 'Skill'];
// Grunt has no UI to answer it; Claude asks in plain text instead.
const ALWAYS_DISALLOWED = ['AskUserQuestion'];

/** Argument keys Claude Code tools use for a filesystem path. */
export const AGENT_PATH_ARG_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path'];

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
      return policy.shell ? null : 'Shell (Bash) is disabled by policy.';
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
 * model isn't offered tools every call to which would be denied. MCP tools are
 * not listed here: `agentMcp: false` is enforced by the gate (agentPolicyDenial).
 */
export function agentDisallowedTools(policy: ToolPolicy): string[] {
  const out = [...ALWAYS_DISALLOWED];
  if (policy.fs !== 'readwrite') out.push(...FILE_WRITE);
  if (policy.fs === 'off') out.push(...FILE_READ);
  if (!policy.shell) out.push(...SHELL);
  if (policy.agentWeb === false) out.push(...WEB);
  return out;
}
