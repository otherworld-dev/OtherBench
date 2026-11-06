/**
 * The MCP side of `OtherBenchToolProvider` (`../provider.ts`): every
 * allowlisted server's cached tools as `ToolSpec`s, namespaced
 * `mcp__<server>__<tool>`, with the risk the server itself declared and the
 * SERVER id `PermissionBroker` checks against the profile's enabled servers.
 * The specs made here are bare: an API model only ever gets them through the
 * provider's `gate()`, and Claude Code through the relay, whose gate approves
 * each call with the very same spec first. Also the lookups a live artifact's
 * call needs (`liveTarget`, `whyUnavailable`) and the name deduplication that
 * every list of tools goes through.
 *
 * MCP tool wrapping: namespacing + collision suffixing (decision #1) + risk
 * classification from the server's own declared annotations.
 */
import type { RiskClass, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
import type { McpToolDescriptor } from '../mcp/client.js';
import type { McpServerManager } from '../mcp/manager.js';
import { toolError } from './outcomes.js';

/** An MCP tool's spec with where it came from: the server and the tool's own (unsanitised) name. */
export interface McpEntry {
  spec: ToolSpec;
  origin: { serverId: string; serverName: string; toolName: string };
}

/** `mcp__<server>__<tool>` as its two parts, for a name no server matches. */
export function splitToolName(name: string): [string, string] {
  if (!name.startsWith('mcp__')) return [name, ''];
  const rest = name.slice('mcp__'.length);
  const at = rest.indexOf('__');
  return at === -1 ? [rest, ''] : [rest.slice(0, at), rest.slice(at + 2)];
}

function sanitizeNameSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'x';
}

function mapMcpRisk(tool: McpToolDescriptor): RiskClass {
  if (tool.readOnlyHint === true) return 'read';
  if (tool.destructiveHint === true) return 'execute';
  return 'mutate'; // conservative default: an MCP tool that declares nothing is treated as capable of mutating something.
}

export function summarizeMcpContent(content: unknown): string {
  if (Array.isArray(content)) {
    const withText = content.find(
      (c): c is { text: string } => !!c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
    );
    if (withText) return withText.text.slice(0, 500);
  }
  return 'The MCP tool call reported an error.';
}

/**
 * The most text an MCP tool's result carries, across its text items. A tool
 * result is sent again with every later turn of the chat, and a server can
 * answer with anything (a whole page, a database dump).
 */
export const MCP_RESULT_MAX_CHARS = 100_000;

/**
 * An MCP result with its text items cut to MCP_RESULT_MAX_CHARS in all, in
 * order, and a note added when anything was cut. Images and other items pass
 * as they are: the image screening budgets them on its own.
 */
function capMcpText(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let room = MCP_RESULT_MAX_CHARS;
  let total = 0;
  const out: unknown[] = [];
  for (const item of content) {
    const text = item && typeof item === 'object' && (item as { type?: unknown }).type === 'text' ? (item as { text?: unknown }).text : undefined;
    if (typeof text !== 'string') {
      out.push(item);
      continue;
    }
    total += text.length;
    if (room <= 0) continue;
    out.push(text.length <= room ? item : { ...(item as object), text: text.slice(0, room) });
    room -= Math.min(room, text.length);
  }
  if (total <= MCP_RESULT_MAX_CHARS) return content;
  out.push({ type: 'text', text: `[OtherBench: this result's text was cut at ${MCP_RESULT_MAX_CHARS.toLocaleString('en-US')} characters of ${total.toLocaleString('en-US')}. Ask the tool for less, if it can narrow its answer.]` });
  return out;
}

/** Each MCP tool's spec with its origin, so a live call can reach the server under the tool's own name. */
export function mcpEntries(mcp: Pick<McpServerManager, 'listFor'>, serverIds: string[]): McpEntry[] {
  const entries: McpEntry[] = [];
  // A server that is reconnecting keeps its tools on offer (a call to one says it isn't connected), so the set stays the same.
  for (const { id, name, client } of mcp.listFor(serverIds, { reconnecting: true })) {
    for (const tool of client.tools) {
      const namespacedName = `mcp__${sanitizeNameSegment(name)}__${sanitizeNameSegment(tool.name)}`;
      entries.push({
        origin: { serverId: id, serverName: name, toolName: tool.name },
        spec: {
          name: namespacedName,
          description: tool.description,
          parameters: tool.inputSchema,
          risk: mapMcpRisk(tool),
          source: 'mcp',
          // The SERVER id, not the display name: `PermissionBroker` checks
          // this against `ToolPolicy.mcpServerIds` so a tool from a server
          // this profile never enabled is denied rather than riding on the
          // fact that some other server is enabled.
          serverId: id,
          // Looks the server's client up again at call time rather than
          // using the one it was listed with: turning a server off and on
          // replaces its client, and the Claude Code relay keeps these specs
          // for the life of a process, which can span that.
          execute: async (args: unknown) => {
            const live = mcp.listFor([id])[0]?.client;
            if (!live) return toolError('mcp_call_failed', `MCP server "${name}" isn't connected.`);
            try {
              const result = await live.callTool(tool.name, args);
              if (result.isError) return toolError('mcp_tool_error', summarizeMcpContent(result.content));
              return capMcpText(result.content);
            } catch (err) {
              return toolError('mcp_call_failed', err instanceof Error ? err.message : String(err));
            }
          },
        },
      });
    }
  }
  return entries;
}

/**
 * The profile's MCP tool called `name` (as listTools names it), with its
 * origin; null when it has none, or `{ reason }` when the name could mean
 * more than one tool. `mcp_server.name` isn't unique, sanitising collapses
 * distinct names, and the `_2` suffix follows listing order, which moves as
 * servers connect and drop. A grant is keyed on the name, so honouring an
 * ambiguous one could run another server's tool under it. (It is keyed on
 * the server's id too, so a server renamed or replaced into a granted name
 * needs its own OK.)
 */
export function liveTarget(store: Store, mcp: Pick<McpServerManager, 'listFor'>, policy: ToolPolicy, name: string): { entry: McpEntry } | { reason: string } | null {
  if (policy.mcpServerIds.length === 0) return null;
  const entries = mcpEntries(mcp, policy.mcpServerIds);
  // Deduplicated as listTools does, so a suffixed name means the same tool here.
  const specs = deduplicateNames(entries.map((e) => e.spec), false);
  const at = specs.findIndex((s) => s.name === name);
  if (at === -1) return null;
  const entry: McpEntry = { spec: specs[at]!, origin: entries[at]!.origin };
  const baseName = entries[at]!.spec.name;
  const serverSegment = sanitizeNameSegment(entry.origin.serverName);
  const ambiguous =
    specs.filter((s) => s.name === name).length > 1 ||
    entries.filter((e) => e.spec.name === baseName).length > 1 ||
    // Another enabled server of this profile that shares the name but isn't connected right now: its tool may come back under this one.
    store.mcpServers
      .list()
      .some((r) => r.enabled && r.id !== entry.origin.serverId && policy.mcpServerIds.includes(r.id) && sanitizeNameSegment(r.name) === serverSegment);
  if (ambiguous) return { reason: `"${name}" names more than one tool; rename one of the MCP servers so each has its own name.` };
  return { entry };
}

/** Why the profile has no tool called `name`, in words the viewer shows. */
export function whyUnavailable(store: Store, mcp: Pick<McpServerManager, 'listFor'>, policy: ToolPolicy, name: string): string {
  const rows = store.mcpServers.list().filter((r) => name.startsWith(`mcp__${sanitizeNameSegment(r.name)}__`));
  if (rows.length === 0) return `MCP server "${splitToolName(name)[0]}" isn't set up on this machine.`;
  const enabled = rows.filter((r) => r.enabled);
  if (enabled.length === 0) return `MCP server "${rows[0]!.name}" is turned off.`;
  const inProfile = enabled.filter((r) => policy.mcpServerIds.includes(r.id));
  if (inProfile.length === 0) return `MCP server "${enabled[0]!.name}" isn't turned on for this chat's profile.`;
  const connected = mcp.listFor(inProfile.map((r) => r.id));
  if (connected.length === 0) return `MCP server "${inProfile[0]!.name}" isn't connected.`;
  const server = connected[0]!.name;
  return `MCP server "${server}" has no tool "${name.slice(`mcp__${sanitizeNameSegment(server)}__`.length)}".`;
}

/**
 * A model must never be handed two distinct tools under one name (decision
 * #1). The `mcp__<server>__<tool>` namespace already prevents same-named
 * tools on different servers from colliding; this closes the residual
 * case where sanitization or a builtin name still produces a duplicate --
 * later entries (stable insertion order: fs, then shell, then each MCP
 * server in policy order, each server's own tools in `tools/list` order)
 * are suffixed `_2`, `_3`, ... deterministically, and the collision is
 * logged so it's diagnosable rather than silently masking one tool.
 */
export function deduplicateNames(specs: ToolSpec[], log = true): ToolSpec[] {
  const seen = new Map<string, number>();
  return specs.map((spec) => {
    const priorCount = seen.get(spec.name) ?? 0;
    seen.set(spec.name, priorCount + 1);
    if (priorCount === 0) return spec;
    const suffixed = `${spec.name}_${priorCount + 1}`;
    if (log) console.warn(`[OtherBenchToolProvider] tool name collision on "${spec.name}"; suffixed to "${suffixed}".`);
    return { ...spec, name: suffixed };
  });
}
