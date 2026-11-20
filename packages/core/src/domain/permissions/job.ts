/**
 * The broker's rules for a call in a job chat (`ToolContext.job`,
 * docs/features/jobs.md), applied after the policy ceiling and before
 * every source's own branch, the grants and any card. A job runs untrusted
 * instructions with nobody watching, so nothing here asks: a call is allowed
 * or refused by rule.
 *
 *   - Writes (OtherBench's fs tools, Claude Code's Edit/Write/MultiEdit/
 *     NotebookEdit) are allowed in the job folder (`grantedBy: 'job'`), except
 *     to a protected path (`isJobProtectedPath`: `.git`, `.claude`, editor and
 *     shell config), which is refused outright, never sent to a classifier.
 *   - Reads, Claude Code's internal tools, the sandboxed `run_command` and the
 *     thread tools go on to their usual branches (ask-on-mutate passes them).
 *   - Every other source and Claude Code category is refused: the network
 *     from the sandbox, Claude Code's shell, web, MCP, SendMessage and any tool
 *     OtherBench doesn't know. The job policy turns most of these off already;
 *     this holds whatever reaches here.
 */
import { relative, sep } from 'node:path';
import { AGENT_PATH_ARG_KEYS, classifyAgentTool } from '../agent-tools.js';
import { isJobProtectedPath, JOB_NETWORK_REFUSAL, JOB_TOOL_REFUSAL, jobProtectedReason, plantedCommandIn } from '../job.js';
import { containPath } from '../paths.js';
import type { ToolContext, ToolSpec } from '../../ports/tool-provider.js';
import type { Decision } from './decision.js';

/** The argument keys a write tool names its file with: Claude Code's, and OtherBench's fs tools' `path`. */
const WRITE_PATH_KEYS: readonly string[] = AGENT_PATH_ARG_KEYS;

/** The job's decision for this call, or null to carry on to the usual branches. Only for `ctx.job`. */
export function jobDecision(tool: ToolSpec, args: unknown, ctx: ToolContext): Decision | null {
  switch (tool.source) {
    case 'fs':
      return tool.risk === 'read' ? null : writeDecision(tool, args, ctx);
    case 'agent': {
      const category = classifyAgentTool(tool.name).category;
      if (category === 'file-write') return writeDecision(tool, args, ctx);
      if (category === 'file-read' || category === 'internal') return null;
      return deny(JOB_TOOL_REFUSAL);
    }
    case 'sandbox':
    case 'thread':
      return null;
    case 'network':
      return deny(JOB_NETWORK_REFUSAL);
    default:
      return deny(JOB_TOOL_REFUSAL);
  }
}

function deny(reason: string): Decision {
  return { kind: 'deny', reason, job: true };
}

/**
 * A write is allowed when every path it names resolves inside the job folder
 * (by `containPath`, the same resolution the tool itself uses) to a path that
 * isn't protected. A write naming no usable path, or one that doesn't
 * resolve, is refused: it can't be checked.
 */
function writeDecision(tool: ToolSpec, args: unknown, ctx: ToolContext): Decision {
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const raws = WRITE_PATH_KEYS.map((key) => record[key]).filter((v) => v !== undefined);
  if (raws.length === 0) return deny(`"${tool.name}" names no file, so this job can't check where it writes.`);
  const root = ctx.workspaceRoot;
  if (!root) return deny(`"${tool.name}" needs the job's folder, and this chat has none.`);
  for (const raw of raws) {
    if (typeof raw !== 'string' || raw.trim() === '') return deny(`"${tool.name}" has a path this job can't check.`);
    let rel: string;
    try {
      rel = relative(containPath(root, '.'), containPath(root, raw.trim())).split(sep).join('/');
    } catch {
      return deny(`"${tool.name}" was blocked: ${raw} is outside this job's folder.`);
    }
    if (rel === '' || isJobProtectedPath(rel)) return deny(jobProtectedReason(raw));
    // A file at the top level named like a program started by name (git.exe, node.cmd): Windows could run it from here.
    if (!rel.includes('/') && plantedCommandIn([rel]) !== null) return deny(`jobs can't make ${rel} at the top of the folder: it is named like a program, which Windows could run from here in place of the real one. Put it in a subfolder.`);
  }
  return { kind: 'allow', grantedBy: 'job' };
}
