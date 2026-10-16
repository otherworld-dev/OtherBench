import type { Usage } from './usage.js';

/** Where a sub-agent is (spec 2026-10-12-api-subagents-design): waiting for a slot, working, or finished one way or another. */
export type SubagentStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';

/**
 * The mark on a reference to a file that has not been checked yet. Sync can
 * bring a message before the file rows it names; until the row arrives, the
 * store keeps the reference with `pending: true` (only ever `true`; a checked
 * reference has no such field). The mark is set and cleared by the store on
 * sync apply (store-sqlite `SqliteSyncRepo`) and by nothing else.
 *
 * A reader must treat a pending item as NOT shown: it names an attachment id
 * nothing has verified, so it is not replayed to a model, not served, not
 * offered to a peer as an image, and a UI shows a placeholder, not the file.
 * It is carried by a user's `image` and `file` parts and by a tool result's
 * image reference (`ToolImageRef` in domain/tool-images.ts).
 */
export interface PendingMark {
  pending?: true;
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ({ type: 'image'; attachmentId: string; mime: string } & PendingMark)
  | ({ type: 'file'; attachmentId: string; mime: string; filename: string } & PendingMark)
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; result: unknown; isError: boolean }
  /**
   * A UI-only, non-model-authored annotation -- e.g. TurnRunner's honest
   * disclosure that an `image` part in this variant's request was degraded
   * to a text placeholder because the profile's model does not declare
   * vision support (task 21 decision #3: "the user must be told which
   * happened, not silently downgraded"). Never produced by a `ChatEngine`,
   * and deliberately dropped by `toModelMessages` (engine-aisdk/convert.ts)
   * rather than replayed into any provider -- it describes what OtherBench did,
   * not something the model said, so forwarding it as conversation history
   * would misattribute it as assistant output.
   */
  | { type: 'notice'; text: string }
  /**
   * A sub-agent this reply started: one an API profile started with the
   * `subagent` tool, or a helper Claude Code started with its Task or Agent
   * tool (`callId` is that tool call's id). Its own transcript is in `parts`: text, reasoning, tool-call,
   * tool-result and notice parts, never another `subagent` part. Tool results
   * in it are a cut copy (the sub-agent's model saw them whole). Added when
   * the call starts and updated as it runs (domain/parts.ts folds it). The
   * parent model never sees it: `toModelMessages` drops it, and the parent
   * only sees its own `subagent` tool call and result.
   */
  | {
      type: 'subagent';
      callId: string;
      label: string;
      prompt: string;
      profileId: string;
      profileName: string;
      modelId: string;
      status: SubagentStatus;
      parts: Part[];
      /** Why it failed, for a person; set with status `error`. */
      error?: string;
      /** What its model reported when it finished. Absent when it never finished. */
      usage?: Usage;
      /** When it started working and when it finished (ms), for its running time. Absent on cards made before these were kept. */
      startedAt?: number;
      finishedAt?: number;
    };

export type Role = 'system' | 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled';

export interface ProducedBy {
  profileId: string;
  profileName: string;
  connectionId: string;
  modelId: string;
  /**
   * Set on a reply added by "Regenerate": another sibling under a user
   * message whose first reply already exists. It is what tells such a
   * sibling set (switched with a `‹ 2 / 3 ›` control) apart from a compare
   * turn (replies fanned out together, shown as tabs). Absent otherwise.
   */
  regenerated?: boolean;
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
  /** The machine (node id) that wrote this message. Filled in by the store when not given. */
  originNode?: string;
  /**
   * When the user last kept this reply as the chosen variant of a compare
   * turn (set by moving the head onto it). Absent otherwise (never null). It
   * is how a kept-but-not-yet-continued variant stays chosen after the head
   * moves elsewhere and back -- see `extendToTip`.
   */
  keptAt?: number;
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
  | 'model_not_found' | 'capability' | 'transient' | 'cancelled' | 'unknown'
  /** The chat's folder doesn't resolve on the machine the turn runs on (v2 spec §6). Never sent to the engine. */
  | 'workspace_unresolved'
  /** The machine the chat runs on stopped responding mid-reply (v2 spec §5). */
  | 'peer_unreachable';
