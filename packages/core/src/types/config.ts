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
