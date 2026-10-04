import type { CanonMessage, EngineMeta, SerializedError } from '../types/messages.js';
import type { Connection, ResolvedProfile } from '../types/config.js';
import type { Usage } from '../types/usage.js';
import type { ToolSpec } from './tool-provider.js';

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
  /** Stops anything the engine keeps running between turns (Claude Code's live processes). Called once, at shutdown. */
  dispose?(): void;
}
