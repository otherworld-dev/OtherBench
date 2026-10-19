import { randomBytes } from 'node:crypto';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ARTIFACT_KINDS, ARTIFACT_TOOL, ARTIFACT_TOOL_DESCRIPTION } from '@otherbench/core/domain/artifacts.js';
import { RECALL_TOOL, RECALL_TOOL_DESCRIPTION } from '@otherbench/core/domain/recall.js';
import { PLAN_TOOL, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_PARAMETERS } from '@otherbench/core/domain/thread-tools.js';

const SHAPE = {
  command: z.enum(['create', 'update', 'rewrite', 'view']),
  id: z.string().optional(),
  kind: z.enum(ARTIFACT_KINDS as unknown as [string, ...string[]]).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  language: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
  // Live artifacts (spec 2026-10-12-live-artifacts): JSON text. The executor
  // takes an object too, since this server's raw handler doesn't validate.
  live: z.string().optional(),
};

/**
 * One tool on OtherBench's server: its JSON input schema as Claude Code is shown
 * it, and the call itself. Raw JSON schemas, rather than the SDK's zod-only
 * `tool()` helper, so the server can also carry tools relayed from OtherBench's
 * MCP servers with their own schemas (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §2).
 */
export interface OtherBenchServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Sent with every request rather than left to Claude Code's tool search.
   * OtherBench's own tools are (the system prompt tells the model to use
   * them); a relayed MCP tool isn't, so a server with dozens of tools costs
   * a line each until the model looks one up.
   */
  alwaysLoad: boolean;
  call(args: unknown): Promise<CallToolResult>;
}

/**
 * A fresh name for one process's OtherBench server. The gate lets that server's
 * artifact, recall and plan tools through as OtherBench's, so the name must be one a project's
 * MCP config can't take: any fixed name (`otherbench`) could be registered by a
 * repo's `.mcp.json`, and its tool would get the same pass.
 */
export function otherBenchServerName(): string {
  return `otherbench_${randomBytes(8).toString('hex')}`;
}

/** Claude Code's name for OtherBench's tool `tool` on the server `server`. */
export function otherBenchToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** The running reply's executor for one of OtherBench's tools, or undefined when none is running or the profile turns the tool off. */
type Current = () => ((args: unknown) => Promise<unknown>) | undefined;

/** Runs a call on the current executor; the outcome goes back as JSON, an error flagged so Claude Code reads it as one. */
async function answer(current: Current, args: unknown, off: string): Promise<CallToolResult> {
  const run = current();
  const outcome = run ? await run(args) : { error: true, code: 'unavailable', message: off };
  const isError = typeof outcome === 'object' && outcome !== null && (outcome as { error?: unknown }).error === true;
  return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }], isError };
}

/** A zod shape as the JSON schema Claude Code is shown. */
function jsonSchemaOf(shape: z.ZodRawShape): Record<string, unknown> {
  return z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
}

/** The `artifact` tool as Claude Code sees it, from OtherBench's in-process MCP server (Deck #896). */
export function otherBenchArtifactTool(current: Current): OtherBenchServerTool {
  return {
    name: ARTIFACT_TOOL,
    description: ARTIFACT_TOOL_DESCRIPTION,
    inputSchema: jsonSchemaOf(SHAPE),
    alwaysLoad: true,
    call: (args) => answer(current, args, 'Artifacts are turned off for this profile, or no OtherBench reply is running.'),
  };
}

const RECALL_SHAPE = {
  command: z.enum(['search', 'read']),
  query: z.string().optional(),
  chatId: z.string().optional(),
  messageId: z.string().optional(),
  project: z.string().optional(),
};

/** The `recall` tool as Claude Code sees it, on the same server as the artifact tool (spec 2026-10-09-recall-design). */
export function otherBenchRecallTool(current: Current): OtherBenchServerTool {
  return {
    name: RECALL_TOOL,
    description: RECALL_TOOL_DESCRIPTION,
    inputSchema: jsonSchemaOf(RECALL_SHAPE),
    alwaysLoad: true,
    call: (args) => answer(current, args, 'Searching past chats is turned off for this profile, or no OtherBench reply is running.'),
  };
}

/** Like `answer`, but a string outcome goes back as it is: the plan tool's result is words for the model, not data. */
async function answerText(current: Current, args: unknown, off: string): Promise<CallToolResult> {
  const run = current();
  const outcome = run ? await run(args) : { error: true, code: 'unavailable', message: off };
  const isError = typeof outcome === 'object' && outcome !== null && (outcome as { error?: unknown }).error === true;
  const message = isError ? (outcome as { message?: unknown }).message : undefined;
  const text = typeof outcome === 'string' ? outcome : typeof message === 'string' ? message : JSON.stringify(outcome);
  return { content: [{ type: 'text' as const, text }], isError };
}

/** `propose_plan` as Claude Code sees it, on OtherBench's server, only while the reply is planning (spec 2026-10-12-thread-cards-design §6). */
export function otherBenchPlanTool(current: Current): OtherBenchServerTool {
  return {
    name: PLAN_TOOL,
    description: PLAN_TOOL_DESCRIPTION,
    inputSchema: PLAN_TOOL_PARAMETERS,
    alwaysLoad: true,
    call: (args) => answerText(current, args, 'Plan mode is off for this reply, or no OtherBench reply is running.'),
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * OtherBench's MCP server for one Claude Code process, named by `otherBenchServerName`:
 * an in-process MCP server answering `tools/list` and `tools/call` itself.
 * A tool marked `alwaysLoad` is never deferred behind tool search; the rest
 * are, as Claude Code defers any MCP server's tools. A call to an unknown tool, or one that throws,
 * comes back as an error result rather than failing the request.
 */
export function otherBenchMcpServer(name: string, tools: OtherBenchServerTool[]): McpSdkServerConfigWithInstance {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const instance = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {}) })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return errorResult(`OtherBench has no tool called "${request.params.name}".`);
    try {
      return await tool.call(request.params.arguments ?? {});
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });
  return { type: 'sdk', name, instance };
}
