import type { ToolPolicy } from '../types/config.js';

export type RiskClass = 'read' | 'mutate' | 'execute';

export interface ToolContext {
  chatId: string;
  messageId: string;
  workspaceRoot: string | null;
  signal: AbortSignal;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  risk: RiskClass;
  source: 'fs' | 'shell' | 'mcp';
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

export interface ToolProvider {
  listTools(policy: ToolPolicy): Promise<ToolSpec[]>;
  refreshMcp(serverId: string): Promise<void>;
  shutdown(): Promise<void>;
}
