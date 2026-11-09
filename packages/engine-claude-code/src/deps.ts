import type { McpServerConfig, Options, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { DiscoveredModel } from '@otherbench/core/ports/chat-engine.js';
import type { ToolProvider, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { Connection, ToolPolicy } from '@otherbench/core/types/config.js';
import type { OtherBenchServerTool } from './otherbench-server.js';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  /** Drops one queued message by its uuid: true when it was still queued, false once started. Untyped in SDK 0.3.287. */
  cancelAsyncMessage?(uuid: string): Promise<boolean>;
  /** Stops one background task (a helper, a background command) by Claude Code's task id. */
  stopTask?(taskId: string): Promise<unknown>;
  /** Switches the running Claude Code's permission mode. */
  setPermissionMode?(mode: 'default' | 'auto'): Promise<unknown>;
  supportedModels(): Promise<{ value: string; displayName: string }[]>;
  accountInfo(): Promise<{ email?: string; subscriptionType?: string }>;
  /** The slash commands Claude Code offers in this session. Optional: an older Claude Code may not have it. */
  supportedCommands?(): Promise<SlashCommand[]>;
  /** The data behind /usage. Experimental in the SDK and may go away, hence optional; its answer is checked, not trusted (plan-usage.ts). */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
};

export interface ClaudeCodeEngineDeps {
  query: QueryFn;
  /** `askUser` answers Claude Code's AskUserQuestion and OtherBench's propose_plan through cards; without it both are refused. */
  approvals: Pick<ToolProvider, 'requestApproval' | 'recordAgentDenial'> & Partial<Pick<ToolProvider, 'askUser'>>;
  /**
   * A chat's settings as they are now (spec 2026-10-17-claude-background-helpers-design):
   * a background helper's call between replies is gated with these, not the
   * last reply's, so turning Auto off or plan mode on holds a running helper
   * too, and with the current policy of the profile the helper runs under.
   * Null when the chat or profile is gone, which refuses the call. Without it
   * the last reply's settings are used.
   */
  chatSettings?: (chatId: string, profileId: string) => { autoMode: boolean; planMode: boolean; policy: ToolPolicy } | null;
  /** Model listing for an endpoint backend (e.g. Ollama), supplied by the server. */
  listEndpointModels: (conn: Connection, token: string | null) => Promise<DiscoveredModel[]>;
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** How long a model-list / connection-test probe may take. Defaults to 20 s. */
  probeTimeoutMs?: number;
  /** How long an idle Claude Code process waits for the next message. Defaults to 30 minutes. */
  liveIdleMs?: number;
  /** How many idle Claude Code processes are kept. Defaults to 3. */
  maxLive?: number;
  /**
   * Runs an `artifact` tool call for a reply (Deck #896): the server's
   * executor. `mcpServerIds` are the profile's, so a live declaration (spec
   * 2026-10-12-live-artifacts) is checked against its tools. Without it,
   * Claude Code gets no artifact tool.
   */
  artifactTool?: (ctx: { chatId: string; messageId: string; mcpServerIds: string[] }, args: unknown) => Promise<unknown>;
  /** Runs a `recall` tool call for a reply (spec 2026-10-09-recall-design): the server's executor. Without it, Claude Code gets no recall tool. */
  recallTool?: (ctx: { chatId: string }, args: unknown) => Promise<unknown>;
  /**
   * Where a chat with no folder runs (a clean chat, spec
   * 2026-10-11-claude-code-clean-chat-and-mcp-design §1): each such chat gets
   * `<scratchRoot>/<chat id>`, the same folder every turn so its session
   * resumes. Without it, a private folder made in the system temp folder for
   * this engine (never a fixed path there, which another user could make first).
   */
  scratchRoot?: string;
  /**
   * What OtherBench relays to Claude Code through its own server for this policy,
   * as an API model gets it but ungated (OtherBenchToolProvider.relayTools): the
   * allowlisted MCP servers' tools (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §2),
   * the sandboxed run_command when the shell runs in the sandbox (spec
   * 2026-10-12-sandbox-design), and the browser when the profile turns it on
   * (spec 2026-10-12-model-browser-design §4). The gate approves each call
   * first, and a tool that describes its calls (the browser) runs only with
   * the arguments the gate approved. Without it, no relay.
   */
  relayTools?: (policy: ToolPolicy) => ToolSpec[] | Promise<ToolSpec[]>;
  /** Builds OtherBench's MCP server from its name and tools; defaults to the SDK's in-process server. Tests pass a fake. */
  mcpServer?: (name: string, tools: OtherBenchServerTool[]) => McpServerConfig;
}
