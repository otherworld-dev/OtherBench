import { randomBytes } from 'node:crypto';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ARTIFACT_KINDS, ARTIFACT_TOOL, ARTIFACT_TOOL_DESCRIPTION } from '@grunt/core/domain/artifacts.js';
import { RECALL_TOOL, RECALL_TOOL_DESCRIPTION } from '@grunt/core/domain/recall.js';

const SHAPE = {
  command: z.enum(['create', 'update', 'rewrite', 'view']),
  id: z.string().optional(),
  kind: z.enum(ARTIFACT_KINDS as unknown as [string, ...string[]]).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  language: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
};

/**
 * One tool on Grunt's server: its JSON input schema as Claude Code is shown
 * it, and the call itself. Raw JSON schemas, rather than the SDK's zod-only
 * `tool()` helper, so the server can also carry tools relayed from Grunt's
 * MCP servers with their own schemas (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §2).
 */
export interface GruntServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: unknown): Promise<CallToolResult>;
}

/**
 * A fresh name for one process's Grunt server. The gate lets that server's
 * artifact and recall tools through without a card, so the name must be one a project's
 * MCP config can't take: any fixed name (`grunt`) could be registered by a
 * repo's `.mcp.json`, and its tool would get the same pass.
 */
export function gruntServerName(): string {
  return `grunt_${randomBytes(8).toString('hex')}`;
}

/** Claude Code's name for the artifact tool on the server `server`. */
export function gruntArtifactToolName(server: string): string {
  return `mcp__${server}__${ARTIFACT_TOOL}`;
}

/** The running reply's executor for one of Grunt's tools, or undefined when none is running or the profile turns the tool off. */
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

/** The `artifact` tool as Claude Code sees it, from Grunt's in-process MCP server (Deck #896). */
export function gruntArtifactTool(current: Current): GruntServerTool {
  return {
    name: ARTIFACT_TOOL,
    description: ARTIFACT_TOOL_DESCRIPTION,
    inputSchema: jsonSchemaOf(SHAPE),
    call: (args) => answer(current, args, 'Artifacts are turned off for this profile, or no Grunt reply is running.'),
  };
}

/** Claude Code's name for the recall tool on the server `server`. */
export function gruntRecallToolName(server: string): string {
  return `mcp__${server}__${RECALL_TOOL}`;
}

const RECALL_SHAPE = {
  command: z.enum(['search', 'read']),
  query: z.string().optional(),
  chatId: z.string().optional(),
  messageId: z.string().optional(),
  project: z.string().optional(),
};

/** The `recall` tool as Claude Code sees it, on the same server as the artifact tool (spec 2026-10-09-recall-design). */
export function gruntRecallTool(current: Current): GruntServerTool {
  return {
    name: RECALL_TOOL,
    description: RECALL_TOOL_DESCRIPTION,
    inputSchema: jsonSchemaOf(RECALL_SHAPE),
    call: (args) => answer(current, args, 'Searching past chats is turned off for this profile, or no Grunt reply is running.'),
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Grunt's MCP server for one Claude Code process, named by `gruntServerName`:
 * an in-process MCP server answering `tools/list` and `tools/call` itself.
 * Every tool is always loaded (never deferred behind tool search, which a
 * clean chat doesn't have). A call to an unknown tool, or one that throws,
 * comes back as an error result rather than failing the request.
 */
export function gruntMcpServer(name: string, tools: GruntServerTool[]): McpSdkServerConfigWithInstance {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const instance = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, _meta: { 'anthropic/alwaysLoad': true } })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return errorResult(`Grunt has no tool called "${request.params.name}".`);
    try {
      return await tool.call(request.params.arguments ?? {});
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });
  return { type: 'sdk', name, instance };
}
