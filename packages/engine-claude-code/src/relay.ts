import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { desktopTextForResult, screenContentError } from '@otherbench/core/domain/computer-apps.js';
import { LIVE_IMAGE_LIMITS, screenToolResult, VIDEO_FOR_USER_NOTE, type ToolImageBudget } from '@otherbench/core/domain/tool-images.js';
import { NO_APPROVAL_REASON, type ToolContext, type ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { OtherBenchServerTool } from './otherbench-server.js';
import type { ApprovalTickets } from './tickets.js';

/**
 * Relaying OtherBench's MCP servers into Claude Code (spec
 * 2026-10-11-claude-code-clean-chat-and-mcp-design §2). Each tool of a
 * profile's allowlisted servers goes on OtherBench's per-process server under a
 * relay name; Claude Code calls it as `mcp__otherbench_<16 hex>__<relay name>`.
 * The gate approves the call with the tool's own ToolSpec (exactly as for an
 * API model), and only then does the server run the spec's executor.
 */

/** The model API's limit on a tool name, which Claude Code's full MCP name must fit. */
const MAX_TOOL_NAME = 64;
/** `mcp__otherbench_<16 hex>__`, the part of the full name before the relay name. */
const SERVER_PART = 'mcp__otherbench_0123456789abcdef__'.length;
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

/**
 * The spec to run for a relayed call the gate approved as `approved` (the spec
 * the process started with). It is this reply's own spec for that tool, so an
 * edit that leaves the tool's shape alone (the sandbox allowlist) applies
 * without a new process. Fail closed: a tool this reply doesn't relay is
 * refused rather than run from the old spec, and so is one whose source or
 * risk differs from what the gate approved (a card for one kind of tool must
 * never run another).
 */
export function currentRelayed(relay: Relay, approved: ToolSpec): ToolSpec {
  const current = relay.tools.get(relayName(approved.name));
  if (!current) throw new Error(`"${approved.name}" is not relayed for this reply.`);
  if (current.source !== approved.source || current.risk !== approved.risk) throw new Error(`"${approved.name}" changed since it was approved, so it was not run.`);
  return current;
}

/** A relayed call with no ticket: core's one sentence for a call nothing approved. */
export const NO_TICKET = NO_APPROVAL_REASON;

/**
 * What OtherBench's server knows of one relayed call from its MCP request:
 * Claude Code's tool-use id, when the request carries one, and the request's
 * own signal (aborted when Claude Code gives up on the call).
 */
export interface RelayedCall {
  toolUseId?: string;
  signal?: AbortSignal;
}

/**
 * Runs a relayed call for the running reply, with the spec `currentRelayed`
 * chose. A spec with `describeCall` (the
 * browser, the computer tool, the generators) runs only with the arguments its approval
 * ticket holds, never with Claude Code's raw input; with no ticket nothing
 * runs. Other specs (MCP tools, the sandboxed run_command) run as before.
 *
 * The ticket is this engine's half of the rule: it ties Claude Code's raw
 * input to what the gate approved for this reply. The tool provider holds the
 * other half itself: the `execute` of a spec from `relayOtherBenchTools` runs only
 * an argument object its own `requestApproval` approved, for the same chat,
 * reply and profile, once, and audits what came of it. So a call that got
 * past this function some other way still runs nothing.
 *
 * The call runs under its tool-use id (the request's own, else the hook's kept
 * on the ticket), as an API model's call runs under its own: a generator's
 * progress is sent by it. Its signal ends with the reply's or the request's.
 * `keep` is handed whatever ran, errors included, by that id, when there is one.
 */
export async function runRelayed(spec: ToolSpec, args: unknown, ctx: ToolContext, tickets: ApprovalTickets, call: RelayedCall = {}, keep?: (toolUseId: string, output: unknown) => void): Promise<unknown> {
  const signal = call.signal ? AbortSignal.any([ctx.signal, call.signal]) : ctx.signal;
  const run = async (runArgs: unknown, toolUseId: string | undefined): Promise<unknown> => {
    const output = await spec.execute(runArgs, { ...ctx, signal, ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}) });
    if (toolUseId !== undefined) keep?.(toolUseId, output);
    return output;
  };
  if (!spec.describeCall) return run(args, call.toolUseId);
  const ticket = tickets.take(spec.name, args, call.toolUseId);
  if (!ticket) return { error: true, code: 'no_approval', message: NO_TICKET };
  return run(ticket.args, call.toolUseId ?? ticket.toolUseId);
}

/** The running reply's relay executor, or undefined when no OtherBench reply is running. */
type CurrentRelay = () => ((spec: ToolSpec, args: unknown, call?: RelayedCall) => Promise<unknown>) | undefined;

/**
 * An error as MCP content. `about` is the line a tool put first in its error
 * to say whose words the message holds (the computer tool: content from the
 * screen, not from the user); it stays first, as an item of its own.
 */
function errorResult(text: string, about?: unknown): CallToolResult {
  const said: { type: 'text'; text: string }[] = typeof about === 'string' && about.length > 0 ? [{ type: 'text', text: about }] : [];
  return { content: [...said, { type: 'text', text }], isError: true };
}

function isToolError(value: unknown): value is { error: true; message: string; about?: unknown } {
  return typeof value === 'object' && value !== null && (value as { error?: unknown }).error === true && typeof (value as { message?: unknown }).message === 'string';
}

/** An item that claims to be a video, inline or a reference, whatever else it carries. */
function isVideoItem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'video';
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
 * A relayed tool as OtherBench's server lists it: the server's own description and
 * JSON schema. A call runs on the running reply; the executor's MCP content
 * comes back as is, and its error (or a throw, say the server went away)
 * as an error result.
 */
export function relayServerTool(name: string, spec: ToolSpec, current: CurrentRelay): OtherBenchServerTool {
  return {
    name,
    description: spec.description,
    inputSchema: spec.parameters as Record<string, unknown>,
    // An MCP server's tools wait for tool search; the browser, the computer and the sandboxed shell are few and always there.
    alwaysLoad: spec.source !== 'mcp',
    call: async (args, call) => {
      const run = current();
      if (!run) return errorResult('No OtherBench reply is waiting on this tool call.');
      try {
        const out = await run(spec, args, call);
        if (isToolError(out)) return errorResult(out.message, out.about);
        if (Array.isArray(out)) {
          // MCP content goes to Claude Code only after the same screening an API
          // model's tool result gets: images by their bytes and within the reply's
          // budget, audio and resource blobs as a note. A video is never shown to
          // a model: Claude gets the note an API model gets. Nothing from here is
          // stored; a generator's own result reaches the reply by its tool-use id
          // (TurnBinding.results).
          const shown = out.map((item: unknown) => (isVideoItem(item) ? { type: 'text', text: VIDEO_FOR_USER_NOTE } : item));
          const screened = screenToolResult(shown, budgetFor(run), LIVE_IMAGE_LIMITS);
          if (screened.forged) console.warn(`[claude-code relay] a "${spec.name}" result carried a reference to a stored image; removed.`);
          return { content: screened.result as CallToolResult['content'] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The tool provider answers a computer call's every failure itself, so this is not reached for one. Were it,
        // the words could be the desktop app's: one clean line of them, under the line that says so (core's builder).
        if (spec.source === 'computer') {
          const failed = screenContentError('computer_failed', desktopTextForResult(message));
          return errorResult(failed.message, failed.about);
        }
        return errorResult(message);
      }
    },
  };
}
