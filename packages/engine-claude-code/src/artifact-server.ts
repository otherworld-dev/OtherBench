import { randomBytes } from 'node:crypto';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ARTIFACT_KINDS, ARTIFACT_TOOL, ARTIFACT_TOOL_DESCRIPTION } from '@grunt/core/domain/artifacts.js';

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
 * A fresh name for one process's Grunt server. The gate lets that server's
 * artifact tool through without a card, so the name must be one a project's
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

/**
 * The `artifact` tool as Claude Code sees it, from Grunt's in-process MCP
 * server (Deck #896). `current` returns the running reply's executor, or
 * undefined when none is running or the profile turns artifacts off; the
 * outcome goes back as JSON, an error flagged so Claude Code reads it as one.
 */
export function gruntArtifactTool(current: () => ((args: unknown) => Promise<unknown>) | undefined): SdkMcpToolDefinition<typeof SHAPE> {
  return tool(ARTIFACT_TOOL, ARTIFACT_TOOL_DESCRIPTION, SHAPE, async (args) => {
    const run = current();
    const outcome = run ? await run(args) : { error: true, code: 'unavailable', message: 'Artifacts are turned off for this profile, or no Grunt reply is running.' };
    const isError = typeof outcome === 'object' && outcome !== null && (outcome as { error?: unknown }).error === true;
    return { content: [{ type: 'text', text: JSON.stringify(outcome) }], isError };
  });
}

/** Grunt's MCP server for one Claude Code process, named by `gruntServerName`. */
export function gruntMcpServer(name: string, tools: SdkMcpToolDefinition<any>[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name, version: '1.0.0', tools, alwaysLoad: true });
}
