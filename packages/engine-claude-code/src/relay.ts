import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LIVE_IMAGE_LIMITS, screenToolResult, type ToolImageBudget } from '@grunt/core/domain/tool-images.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { GruntServerTool } from './grunt-server.js';
import type { ApprovalTickets } from './tickets.js';

/**
 * Relaying Grunt's MCP servers into Claude Code (spec
 * 2026-10-11-claude-code-clean-chat-and-mcp-design §2). Each tool of a
 * profile's allowlisted servers goes on Grunt's per-process server under a
 * relay name; Claude Code calls it as `mcp__grunt_<16 hex>__<relay name>`.
 * The gate approves the call with the tool's own ToolSpec (exactly as for an
 * API model), and only then does the server run the spec's executor.
 */

/** The model API's limit on a tool name, which Claude Code's full MCP name must fit. */
const MAX_TOOL_NAME = 64;
/** `mcp__grunt_<16 hex>__`, the part of the full name before the relay name. */
const SERVER_PART = 'mcp__grunt_0123456789abcdef__'.length;
const MAX_RELAY_NAME = MAX_TOOL_NAME - SERVER_PART;

/**
 * The relay name for a tool the provider calls `mcp__<server>__<tool>`: that
 * name without its `mcp__`, cut to fit with a short hash of the whole name
 * when it would be too long, so two long names that start alike stay apart.
 */
export function relayName(specName: string): string {
  const bare = specName.startsWith('mcp__') ? specName.slice('mcp__'.length) : specName;
  if (bare.length <= MAX_RELAY_NAME) return bare;
  const hash = createHash('sha256').update(bare).digest('hex').slice(0, 6);
  return `${bare.slice(0, MAX_RELAY_NAME - 7)}_${hash}`;
}

export interface Relay {
  /** Relay name -> the tool's ToolSpec (its executor is ungated: the gate decides first). */
  tools: Map<string, ToolSpec>;
  /** Changes whenever any relayed tool does; '' when there are none. Part of the live-process key. */
  hash: string;
}

export function buildRelay(specs: ToolSpec[]): Relay {
  const tools = new Map(specs.map((s) => [relayName(s.name), s] as const));
  if (tools.size === 0) return { tools, hash: '' };
  const shape = [...tools].map(([name, s]) => [name, s.name, s.serverId ?? null, s.risk, s.description, s.parameters]);
  return { tools, hash: createHash('sha256').update(JSON.stringify(shape)).digest('hex') };
}

export const NO_TICKET = 'Grunt has no approval for this call.';

/**
 * Runs a relayed call for the running reply. A spec with `describeCall` (the
 * browser) runs only with the arguments its approval ticket holds, never with
 * Claude Code's raw input; with no ticket nothing runs. Other specs (MCP
 * tools) run as before.
 */
export async function runRelayed(spec: ToolSpec, args: unknown, ctx: ToolContext, tickets: ApprovalTickets): Promise<unknown> {
  if (!spec.describeCall) return spec.execute(args, ctx);
  const ticket = tickets.take(spec.name, args);
  if (!ticket) return { error: true, code: 'no_approval', message: NO_TICKET };
  return spec.execute(ticket.args, ctx);
}

/** The running reply's relay executor, or undefined when no Grunt reply is running. */
type CurrentRelay = () => ((spec: ToolSpec, args: unknown) => Promise<unknown>) | undefined;

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isToolError(value: unknown): value is { error: true; message: string } {
  return typeof value === 'object' && value !== null && (value as { error?: unknown }).error === true && typeof (value as { message?: unknown }).message === 'string';
}

/**
 * What each running reply has been given in images so far, so a loop of calls
 * cannot hand Claude Code more than one reply may show. Keyed by the reply's
 * executor, which lives exactly as long as the reply.
 */
const imageBudgets = new WeakMap<object, ToolImageBudget>();

function budgetFor(run: object): ToolImageBudget {
  let budget = imageBudgets.get(run);
  if (!budget) {
    budget = { images: 0, bytes: 0 };
    imageBudgets.set(run, budget);
  }
  return budget;
}

/**
 * A relayed tool as Grunt's server lists it: the server's own description and
 * JSON schema. A call runs on the running reply; the executor's MCP content
 * comes back as is, and its error (or a throw, say the server went away)
 * as an error result.
 */
export function relayServerTool(name: string, spec: ToolSpec, current: CurrentRelay): GruntServerTool {
  return {
    name,
    description: spec.description,
    inputSchema: spec.parameters as Record<string, unknown>,
    call: async (args) => {
      const run = current();
      if (!run) return errorResult('No Grunt reply is waiting on this tool call.');
      try {
        const out = await run(spec, args);
        if (isToolError(out)) return errorResult(out.message);
        if (Array.isArray(out)) {
          // MCP content goes to Claude Code only after the same screening an API
          // model's tool result gets: images by their bytes and within the reply's
          // budget, audio and resource blobs as a note. Nothing from here is stored.
          const screened = screenToolResult(out, budgetFor(run), LIVE_IMAGE_LIMITS);
          if (screened.forged) console.warn(`[claude-code relay] a "${spec.name}" result carried a reference to a stored image; removed.`);
          return { content: screened.result as CallToolResult['content'] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
