import type { CanonMessage, SerializedError } from '../types/messages.js';
import type { Connection, ResolvedProfile } from '../types/config.js';
import type { Usage } from '../types/usage.js';
import type { ToolSpec } from './tool-provider.js';

export interface EngineRequest {
  profile: ResolvedProfile;
  messages: CanonMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
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
