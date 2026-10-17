import type { ChatEngine, ConnectionTestResult, DiscoveredModel, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { Connection } from '@otherbench/core/types/config.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';

/** Sends `claude_code` connections to the Claude Code engine and everything else to the AI SDK engine. */
export class RoutingChatEngine implements ChatEngine {
  constructor(private readonly aisdk: ChatEngine, private readonly claudeCode: ChatEngine) {}

  private pick(kind: Connection['kind']): ChatEngine {
    return kind === 'claude_code' ? this.claudeCode : this.aisdk;
  }

  stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    return this.pick(req.profile.connection.kind).stream(req);
  }

  listModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]> {
    return this.pick(conn.kind).listModels(conn, apiKey);
  }

  testConnection(conn: Connection, apiKey: string | null): Promise<ConnectionTestResult> {
    return this.pick(conn.kind).testConnection(conn, apiKey);
  }

  onBackground(handler: Parameters<NonNullable<ChatEngine['onBackground']>>[0]): void {
    this.aisdk.onBackground?.(handler);
    this.claudeCode.onBackground?.(handler);
  }

  async stopHelper(chatId: string, taskId: string): Promise<boolean> {
    if (this.claudeCode.stopHelper && (await this.claudeCode.stopHelper(chatId, taskId))) return true;
    return this.aisdk.stopHelper ? this.aisdk.stopHelper(chatId, taskId) : false;
  }

  closeChats(gone: (chatId: string) => boolean): void {
    this.aisdk.closeChats?.(gone);
    this.claudeCode.closeChats?.(gone);
  }

  async planUsage(conn: Connection): Promise<PlanUsage | null> {
    const engine = this.pick(conn.kind);
    return engine.planUsage ? engine.planUsage(conn) : null;
  }

  dispose(): void {
    this.aisdk.dispose?.();
    this.claudeCode.dispose?.();
  }
}

/**
 * Model listing for a Claude Code endpoint backend. Claude Code wants the bare
 * Anthropic-compatible base (`http://localhost:11434`); the AI SDK engine's
 * Ollama path wants the OpenAI-compatible `/v1` base and also seeds
 * capabilities from Ollama's native API.
 */
export function endpointModelLister(aisdk: ChatEngine): (conn: Connection, token: string | null) => Promise<DiscoveredModel[]> {
  return (conn, token) => aisdk.listModels({ ...conn, kind: 'ollama', baseUrl: `${(conn.baseUrl ?? '').replace(/\/+$/, '')}/v1` }, token);
}
