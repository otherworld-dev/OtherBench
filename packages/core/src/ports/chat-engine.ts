import type { CanonMessage, SerializedError } from '../types/messages.js';
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
}

export type EngineEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; result: unknown; isError: boolean }
  | { type: 'finish'; usage: Usage; finishReason: string }
  | { type: 'error'; error: SerializedError };

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
}
