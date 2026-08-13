export type ConnectionKind =
  | 'anthropic' | 'openai' | 'openai_compatible' | 'google' | 'ollama' | 'mock';

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
 */
export type ToolSource = 'fs' | 'shell' | 'mcp';

export interface ToolPolicy {
  fs: FsMode;
  shell: boolean;
  mcpServerIds: string[];
  approvalMode: 'always_ask' | 'ask_on_mutate';
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
}

export interface ResolvedProfile extends Profile {
  connection: Connection;
  apiKey: string | null;
  model: ModelInfo | null;
}
