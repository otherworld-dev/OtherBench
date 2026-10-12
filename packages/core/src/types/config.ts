export type ConnectionKind =
  | 'anthropic' | 'openai' | 'openai_compatible' | 'google' | 'ollama' | 'claude_code' | 'mock';

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string | null;
  secretRef: string | null;
  extraHeaders: Record<string, string>;
  status: 'unknown' | 'ok' | 'error';
  statusMessage: string | null;
  checkedAt: number | null;
  /**
   * Where it can be used (v2 spec §5): 'anywhere' (a cloud API), or a node
   * id for a connection only that machine can reach (Ollama on the PC, say).
   * Absent means 'anywhere'.
   */
  availability?: string;
  /** False keeps its API key on this machine when it syncs. Absent means true. */
  syncSecret?: boolean;
}

export interface ModelInfo {
  id: string;
  connectionId: string;
  modelId: string;
  displayName: string;
  source: 'discovered' | 'manual';
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow: number | null;
  maxOutput: number | null;
  priceInPer1m: number | null;
  priceOutPer1m: number | null;
  priceCachedPer1m: number | null;
  currency: string;
}

export type FsMode = 'off' | 'read' | 'readwrite';

/**
 * Where a tool comes from, and therefore which policy rules and which
 * approval rules apply to it. Lives here, next to `ToolPolicy`, rather than
 * on either port, because BOTH ports need it: `ToolSpec` (ports/tool-provider)
 * declares it and `Grant` (ports/store) records it, and a grant must match on
 * source as well as name -- a tool merely sharing the shell tool's name must
 * not be able to satisfy, or to mint, a grant meant for the real shell.
 * `'agent'` is a tool run by an external agent (Claude Code) whose execution
 * Grunt only gates, never performs.
 */
export type ToolSource = 'fs' | 'shell' | 'mcp' | 'agent' | 'artifact' | 'recall';

/** How much Claude Code thinks before and while it answers (the Agent SDK's `effort`), lowest first. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === 'string' && (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

/** Where a profile's shell commands run (spec 2026-10-12-sandbox-design): on this machine, or in Grunt's sandbox. */
export type ShellRuns = 'host' | 'sandbox';

export interface ToolPolicy {
  fs: FsMode;
  shell: boolean;
  mcpServerIds: string[];
  approvalMode: 'always_ask' | 'ask_on_mutate';
  /** Claude Code profiles only: WebFetch/WebSearch allowed. Absent = allowed. */
  agentWeb?: boolean;
  /** Claude Code profiles only: MCP tools from the user's Claude config allowed. Absent = allowed. */
  agentMcp?: boolean;
  /** Artifacts (Deck #896): the `artifact` tool, for both engines. Absent = on. */
  artifacts?: boolean;
  /** Search past chats (spec 2026-10-09-recall-design): the `recall` tool, for both engines. Absent = on. */
  recall?: boolean;
  /** Where `run_command` runs when `shell` is on (spec 2026-10-12-sandbox-design). Absent = 'host'. */
  shellRuns?: ShellRuns;
  /**
   * Hosts a sandboxed command may reach without asking, as the sandbox
   * runtime takes them (`pypi.org`, `*.example.com`, optional `:port`).
   * Absent = DEFAULT_SANDBOX_HOSTS. Any other host raises a card.
   */
  sandboxHosts?: string[];
}

/** What a sandboxed command may reach when the profile names no hosts of its own (spec 2026-10-12-sandbox-design). */
export const DEFAULT_SANDBOX_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
];

/** Whether this policy's `run_command` is the sandboxed one: shell on and set to run in the sandbox. */
export function runsShellInSandbox(policy: ToolPolicy): boolean {
  return policy.shell && policy.shellRuns === 'sandbox';
}

/** The hosts a sandboxed command may reach without asking, as a fresh array. */
export function sandboxHostsOf(policy: ToolPolicy): string[] {
  return [...(policy.sandboxHosts ?? DEFAULT_SANDBOX_HOSTS)];
}

export interface ModelParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  thinkingBudgetTokens?: number;
}

export interface Profile {
  id: string;
  name: string;
  description: string | null;
  colour: string | null;
  connectionId: string;
  modelId: string;
  systemPrompt: string | null;
  params: ModelParams;
  toolPolicy: ToolPolicy;
  isDefault: boolean;
  archivedAt: number | null;
  /** Whether chats on this profile get global memory (spec 2026-10-08-global-memory-design). Absent means on. */
  useGlobalMemory?: boolean;
}

export interface ResolvedProfile extends Profile {
  connection: Connection;
  apiKey: string | null;
  model: ModelInfo | null;
}
