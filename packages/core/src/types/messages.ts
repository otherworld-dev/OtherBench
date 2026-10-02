export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachmentId: string; mime: string }
  | { type: 'file'; attachmentId: string; mime: string; filename: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; result: unknown; isError: boolean }
  /**
   * A UI-only, non-model-authored annotation -- e.g. TurnRunner's honest
   * disclosure that an `image` part in this variant's request was degraded
   * to a text placeholder because the profile's model does not declare
   * vision support (task 21 decision #3: "the user must be told which
   * happened, not silently downgraded"). Never produced by a `ChatEngine`,
   * and deliberately dropped by `toModelMessages` (engine-aisdk/convert.ts)
   * rather than replayed into any provider -- it describes what Grunt did,
   * not something the model said, so forwarding it as conversation history
   * would misattribute it as assistant output.
   */
  | { type: 'notice'; text: string };

export type Role = 'system' | 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled';

export interface ProducedBy {
  profileId: string;
  profileName: string;
  connectionId: string;
  modelId: string;
}

/**
 * Engine-owned state stored on an assistant message. Only Claude Code uses it:
 * the session id lets the next turn continue the Claude Code session
 * this message was produced in. See engine-claude-code/src/session.ts.
 */
export interface EngineMeta {
  engine: 'claude_code';
  sessionId: string;
  /** `'claude'` for the Claude login, or the endpoint base URL. */
  backend: string;
  /** The workspace root the session ran in (Claude Code keys sessions by folder). */
  cwd: string;
  /** Tools Claude Code reported at session start. */
  tools?: string[];
  /** MCP servers Claude Code reported at session start. */
  mcpServers?: { name: string; status: string }[];
}

export interface CanonMessage {
  id: string;
  chatId: string;
  parentId: string | null;
  role: Role;
  parts: Part[];
  status: MessageStatus;
  error: SerializedError | null;
  producedBy: ProducedBy | null;
  /** Present only on assistant messages produced by an engine that keeps its own state. Absent otherwise (never null). */
  engineMeta?: EngineMeta;
  createdAt: number;
}

export interface SerializedError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

export type ErrorKind =
  | 'auth' | 'rate_limit' | 'context_overflow' | 'content_filter'
  | 'model_not_found' | 'capability' | 'transient' | 'cancelled' | 'unknown';
