import type { CanonMessage, EngineMeta, SerializedError } from '../types/messages.js';
import type { ClaudeEffort, Connection, ResolvedProfile } from '../types/config.js';
import type { PlanUsage, Usage } from '../types/usage.js';
import type { ResolvedFolder } from '../types/workspace.js';
import type { PlanGate } from '../types/thread.js';
import type { SubagentHost, SubagentTag, ToolSpec } from './tool-provider.js';

/**
 * Loads the bytes of an image a tool result in the history refers to.
 * The reference is named with the chat and the message that holds it, and the
 * loader answers `null` unless that attachment was stored for exactly that
 * chat and message: an id that came from tool output, MCP, a sub-agent or
 * another chat's history gets no bytes. It is the only way an engine turns a
 * stored tool image back into bytes (`loadAttachment` is for what the user
 * attached, and is never used for these).
 */
export type ToolImageLoader = (ref: { chatId: string; messageId: string; attachmentId: string }) => Promise<Buffer | null>;

/**
 * The size a stored tool image's row states, in bytes, for the same reference a
 * `ToolImageLoader` is given; `null` when it isn't stored for that chat and
 * message (then nothing is loaded). It lets an engine decide what a request may
 * carry before it reads any bytes.
 */
export type ToolImageSizer = (ref: { chatId: string; messageId: string; attachmentId: string }) => number | null;

export interface EngineRequest {
  profile: ResolvedProfile;
  messages: CanonMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** The chat this turn belongs to -- every message in `messages` shares it. */
  chatId: string;
  /**
   * The id of the assistant message this stream is producing. The caller
   * (the TurnRunner) allocates this id and persists the row *before*
   * calling `stream()`, so it is always available here -- unlike `chatId`,
   * it cannot be derived from `messages` (the message doesn't exist yet).
   * Tool executions need this for `ToolContext.messageId` correlation.
   */
  messageId: string;
  /**
   * The chat's configured workspace root (`Chat.workspaceRoot`), or `null`
   * if none is set. Threaded through so the engine can populate
   * `ToolContext.workspaceRoot` for every tool execution -- fs/shell tools
   * (and `PermissionBroker.decide()`) require this to be non-null to operate
   * at all (see `containPath`/`PermissionBroker`). Added alongside
   * `chatId`/`messageId` for the same reason: tool execution needs it and it
   * cannot be derived from `messages`.
   */
  workspaceRoot: string | null;
  /** The chat's extra folders on this machine, for `ToolContext.folders` (and Claude Code's additional directories). */
  folders?: ResolvedFolder[];
  /**
   * Loads an attachment's raw bytes by id, for `toModelMessages`
   * (engine-aisdk/convert.ts) to embed real image/file content when the
   * target model's declared capabilities allow it. Optional -- and
   * deliberately never called when it's absent -- because plenty of callers
   * (every pre-task-21 test, any request whose messages carry no `image`/
   * `file` parts) have no attachments to load at all. Populated by whoever
   * assembles the request (`TurnRunner`, via `TurnRunnerOptions.loadAttachment`)
   * from the same `AttachmentRepo` + content-addressed blob store that
   * `routes/attachments.ts` writes to on upload.
   */
  loadAttachment?: (id: string) => Promise<Buffer>;
  /** Loads a stored tool image for replay, checked against this chat and thread (see `ToolImageLoader`). Absent: stored tool images are replayed as a text note. */
  loadToolImage?: ToolImageLoader;
  /** The size of a stored tool image (see `ToolImageSizer`), so the engine can budget a request without reading bytes. */
  toolImageSize?: ToolImageSizer;
  /** The size of a user's attachment in this chat, or null when it isn't available here: the same use, for `loadAttachment`. */
  attachmentSize?: (id: string) => number | null;
  /**
   * `'utility'` marks a tool-less side call (auto-title, summaries) that must
   * not create a resumable session or load user settings. Default `'turn'`.
   */
  purpose?: 'turn' | 'utility';
  /**
   * The id of the newest message in this chat whose `engineMeta.sessionId`
   * equals `sessionId`, or null. Lets a session-keeping engine tell whether
   * the message it continues from is still that session's tip.
   */
  latestMessageForSession?: (sessionId: string) => string | null;
  /**
   * The chat's Auto toggle (`Chat.autoMode`), read fresh for every turn, so a
   * change applies from the next turn and never mid-turn. Only the Claude Code
   * engine reads it (Claude login only, never for utility calls); every other
   * engine ignores it.
   */
  autoMode?: boolean;
  /** The chat's effort (`Chat.effort`), read fresh for every turn. Only the Claude Code engine reads it; unset follows the user's Claude Code settings. */
  effort?: ClaudeEffort;
  /** This reply's plan approval when the chat's Plan mode is on (TurnRunner makes one per reply); copied onto every ToolContext. */
  plan?: PlanGate;
  /**
   * A scheduled run with nobody watching: every engine copies it onto each
   * tool call's `ToolContext.unattended` (Claude Code onto its gate's
   * context), so a call that would need a card is refused instead.
   */
  unattended?: boolean;
  /** The reply's sub-agent runner, handed to tools on `ToolContext.subagents`. Absent: the `subagent` tool says sub-agents aren't available. */
  subagents?: SubagentHost;
  /** Set on a sub-agent's own request: every tool call it makes carries it. */
  subagent?: SubagentTag;
}

export type EngineEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; result: unknown; isError: boolean }
  | { type: 'finish'; usage: Usage; finishReason: string }
  | { type: 'error'; error: SerializedError }
  | { type: 'engine-meta'; meta: EngineMeta }
  | { type: 'notice'; text: string };

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  supportsVision: boolean | null;
  supportsTools: boolean | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface ChatEngine {
  stream(req: EngineRequest): AsyncIterable<EngineEvent>;
  listModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]>;
  testConnection(conn: Connection, apiKey: string | null): Promise<ConnectionTestResult>;
  /**
   * How much of the subscription's usage limits `conn`'s login has used, or
   * null when it has no plan limits (an API key or endpoint, or the engine
   * can't tell). Only the Claude Code engine answers (Deck #825). Rejects
   * when the reading fails.
   */
  planUsage?(conn: Connection): Promise<PlanUsage | null>;
  /** Stops anything the engine keeps running between turns (Claude Code's live processes). Called once, at shutdown. */
  dispose?(): void;
}
