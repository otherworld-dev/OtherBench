import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '@grunt/core/ports/chat-engine.js';

export type MappedEvent =
  | EngineEvent
  | { type: 'init'; sessionId: string; tools: string[]; mcpServers: { name: string; status: string }[]; permissionMode: string | null }
  | { type: 'result-error'; text: string }
  | { type: 'rate-limited'; resetsAt: number | null };

type Block = { type: string; [k: string]: unknown };

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function resultText(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('');
  }
  return content;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Turns the SDK's message stream into Grunt engine events, one turn at a time.
 * Text comes from partial stream deltas (main agent only); an assistant
 * message's text blocks are used only when no deltas arrived for it. Tool
 * calls include subagent calls, so everything the gate approved is visible.
 */
export class SdkEventMapper {
  private readonly toolNames = new Map<string, string>();
  private sawDelta = false;

  map(msg: SDKMessage): MappedEvent[] {
    const m = msg as unknown as Record<string, unknown>;
    switch (m['type']) {
      case 'system': {
        if (m['subtype'] !== 'init') return [];
        const servers = (m['mcp_servers'] as { name: string; status: string }[] | undefined) ?? [];
        return [{ type: 'init', sessionId: String(m['session_id']), tools: (m['tools'] as string[] | undefined) ?? [], mcpServers: servers.map(({ name, status }) => ({ name, status })), permissionMode: typeof m['permissionMode'] === 'string' ? (m['permissionMode'] as string) : null }];
      }
      case 'stream_event': {
        if (m['parent_tool_use_id'] !== null) return [];
        const event = m['event'] as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | null | undefined;
        if (event?.type !== 'content_block_delta' || !event.delta) return [];
        if (event.delta.type === 'text_delta' && event.delta.text) { this.sawDelta = true; return [{ type: 'text-delta', text: event.delta.text }]; }
        if (event.delta.type === 'thinking_delta' && event.delta.thinking) { this.sawDelta = true; return [{ type: 'reasoning-delta', text: event.delta.thinking }]; }
        return [];
      }
      case 'assistant': {
        const out: MappedEvent[] = [];
        const isMain = m['parent_tool_use_id'] === null;
        for (const block of blocksOf(m['message'])) {
          if (block.type === 'tool_use') {
            const id = String(block['id']);
            const name = String(block['name']);
            this.toolNames.set(id, name);
            out.push({ type: 'tool-call', id, name, args: block['input'] });
          } else if (block.type === 'text' && isMain && !this.sawDelta && typeof block['text'] === 'string') {
            out.push({ type: 'text-delta', text: block['text'] });
          }
        }
        if (isMain) this.sawDelta = false;
        return out;
      }
      case 'user': {
        const out: MappedEvent[] = [];
        for (const block of blocksOf(m['message'])) {
          if (block.type !== 'tool_result') continue;
          const id = String(block['tool_use_id']);
          out.push({ type: 'tool-result', id, name: this.toolNames.get(id) ?? 'unknown', result: resultText(block['content']), isError: block['is_error'] === true });
        }
        return out;
      }
      case 'rate_limit_event': {
        const info = m['rate_limit_info'] as { status?: string; resetsAt?: number } | undefined;
        return info?.status === 'rejected' ? [{ type: 'rate-limited', resetsAt: info.resetsAt ?? null }] : [];
      }
      case 'result': {
        if (m['subtype'] !== 'success' || m['is_error'] === true) {
          const errors = (m['errors'] as string[] | undefined) ?? [];
          const text = errors.join('\n') || String(m['result'] ?? m['subtype'] ?? 'Claude Code reported an error.');
          return [{ type: 'result-error', text }];
        }
        const u = (m['usage'] ?? {}) as Record<string, unknown>;
        const cached = num(u['cache_read_input_tokens']);
        return [{
          type: 'finish',
          finishReason: typeof m['stop_reason'] === 'string' ? (m['stop_reason'] as string) : 'stop',
          usage: { tokensIn: num(u['input_tokens']) + cached + num(u['cache_creation_input_tokens']), tokensOut: num(u['output_tokens']), tokensCached: cached, tokensReasoning: 0 },
        }];
      }
      default:
        return [];
    }
  }
}
