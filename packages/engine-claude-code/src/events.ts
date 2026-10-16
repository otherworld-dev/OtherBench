import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SubagentEvent } from '@otherbench/core/domain/parts.js';
import type { EngineEvent } from '@otherbench/core/ports/chat-engine.js';
import type { HelperRegistry } from './helpers.js';

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

/**
 * A tool result as the transcript keeps it: its text items, one per line (a
 * computer result's screen-content line stays a line of its own), and nothing
 * that isn't text. A string or anything else is kept as it is.
 */
function resultText(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { text: string } => !!c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return content;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Claude Code's tools that start a helper (a subagent). */
const HELPER_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);
/** The longest error a failed helper's card shows. */
const HELPER_ERROR_MAX = 500;

export interface SdkEventMapperOptions {
  /** Tool names reported under another name (this process's own OtherBench tools as `artifact` and `recall`). */
  renames?: ReadonlyMap<string, string>;
  /** Where each helper and the tool calls it makes are recorded, for the approval gate. Without it helpers still get their cards. */
  helpers?: HelperRegistry;
  /** The reply's profile and model: a helper's card names them unless its call names another model. */
  profileId?: string;
  modelId?: string;
  now?: () => number;
}

/**
 * Turns the SDK's message stream into OtherBench engine events, one turn at a time.
 * Text comes from partial stream deltas (main agent only); an assistant
 * message's text blocks are used only when no deltas arrived for it.
 *
 * A helper the main agent starts with its Task or Agent tool becomes a
 * `subagent` card, keyed by that tool call's id: the calls and results it
 * makes (linked by `parent_tool_use_id`) go into its card instead of the
 * reply's own tool calls, and the Task call's result is its report. Every
 * call the gate approved is still shown, on the card that made it. A helper
 * Claude Code moved to the background finishes with its task notification,
 * not the placeholder result its Task call returns at once.
 */
export class SdkEventMapper {
  private readonly toolNames = new Map<string, string>();
  private sawDelta = false;
  private readonly renames: ReadonlyMap<string, string>;
  /** Helpers started and not finished yet, and those running in the background. */
  private readonly openHelpers = new Set<string>();
  private readonly backgrounded = new Set<string>();
  /** Claude Code's task ids by the tool call that started them, for its later task messages. */
  private readonly taskCalls = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: SdkEventMapperOptions = {}) {
    this.renames = options.renames ?? new Map();
    this.now = options.now ?? Date.now;
  }

  private helperEvent(callId: string, event: SubagentEvent): MappedEvent {
    return { type: 'subagent', callId, event };
  }

  /** The events that start a helper's card for the Task call `id`. */
  private startHelper(id: string, input: unknown): MappedEvent[] {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const kind = text(args['subagent_type']);
    const label = text(args['description']) ?? kind ?? 'Helper';
    this.openHelpers.add(id);
    this.options.helpers?.start(id, label);
    return [
      this.helperEvent(id, {
        type: 'start',
        label,
        prompt: text(args['prompt']) ?? '',
        profileId: this.options.profileId ?? '',
        profileName: kind ?? 'general-purpose',
        modelId: text(args['model']) ?? this.options.modelId ?? '',
      }),
      this.helperEvent(id, { type: 'running', at: this.now() }),
    ];
  }

  /** The events that finish a helper's card, once: its report (when there is one) and its end. */
  private endHelper(id: string, status: 'complete' | 'error' | 'cancelled', report: string | null, error?: string): MappedEvent[] {
    if (!this.openHelpers.delete(id)) return [];
    this.backgrounded.delete(id);
    return [
      ...(report ? [this.helperEvent(id, { type: 'text-delta', text: report })] : []),
      this.helperEvent(id, { type: 'end', status, ...(error ? { error: error.slice(0, HELPER_ERROR_MAX) } : {}), at: this.now() }),
    ];
  }

  /** The helper whose own call this message is, or null for the reply's own agent (or a helper it doesn't know). */
  private helperOf(m: Record<string, unknown>): string | null {
    const parent = m['parent_tool_use_id'];
    return typeof parent === 'string' && this.openHelpers.has(parent) ? parent : null;
  }

  map(msg: SDKMessage): MappedEvent[] {
    const m = msg as unknown as Record<string, unknown>;
    switch (m['type']) {
      case 'system': {
        if (m['subtype'] === 'task_started' || m['subtype'] === 'task_updated' || m['subtype'] === 'task_notification') return this.taskMessage(m);
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
        const helper = this.helperOf(m);
        for (const block of blocksOf(m['message'])) {
          if (block.type === 'tool_use') {
            const id = String(block['id']);
            const sdkName = String(block['name']);
            const name = this.renames.get(sdkName) ?? sdkName;
            this.toolNames.set(id, name);
            if (helper !== null) {
              this.options.helpers?.own(id, helper);
              out.push(this.helperEvent(helper, { type: 'tool-call', id, name, args: block['input'] }));
              continue;
            }
            out.push({ type: 'tool-call', id, name, args: block['input'] });
            if (isMain && HELPER_TOOLS.has(sdkName) && !this.openHelpers.has(id)) out.push(...this.startHelper(id, block['input']));
          } else if (block.type === 'text' && isMain && !this.sawDelta && typeof block['text'] === 'string') {
            out.push({ type: 'text-delta', text: block['text'] });
          }
        }
        if (isMain) this.sawDelta = false;
        return out;
      }
      case 'user': {
        const out: MappedEvent[] = [];
        const helper = this.helperOf(m);
        for (const block of blocksOf(m['message'])) {
          if (block.type !== 'tool_result') continue;
          const id = String(block['tool_use_id']);
          const result = resultText(block['content']);
          const isError = block['is_error'] === true;
          const name = this.toolNames.get(id) ?? 'unknown';
          if (helper !== null) {
            out.push(this.helperEvent(helper, { type: 'tool-result', id, name, result, isError }));
            continue;
          }
          out.push({ type: 'tool-result', id, name, result, isError });
          // A helper's Task call returning is its report, unless it went to the background (its notification ends it).
          if (this.openHelpers.has(id) && !this.backgrounded.has(id)) {
            const report = typeof result === 'string' ? result : null;
            out.push(...(isError ? this.endHelper(id, 'error', null, report ?? 'The helper failed.') : this.endHelper(id, 'complete', text(report))));
          }
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

  /** Claude Code's task messages: a helper moving to the background, and a background helper finishing. */
  private taskMessage(m: Record<string, unknown>): MappedEvent[] {
    const taskId = typeof m['task_id'] === 'string' ? m['task_id'] : null;
    const callId = typeof m['tool_use_id'] === 'string' ? m['tool_use_id'] : taskId !== null ? (this.taskCalls.get(taskId) ?? null) : null;
    if (callId === null || !this.openHelpers.has(callId)) return [];
    if (taskId !== null) this.taskCalls.set(taskId, callId);
    if (m['subtype'] === 'task_started') {
      if (m['is_backgrounded'] === true) this.backgrounded.add(callId);
      return [];
    }
    if (m['subtype'] === 'task_updated') {
      const patch = m['patch'] as { is_backgrounded?: unknown } | undefined;
      if (patch?.is_backgrounded === true) this.backgrounded.add(callId);
      return [];
    }
    const summary = text(m['summary']);
    if (m['status'] === 'completed') return this.endHelper(callId, 'complete', this.backgrounded.has(callId) ? summary : null);
    if (m['status'] === 'failed') return this.endHelper(callId, 'error', null, summary ?? 'The helper failed.');
    if (m['status'] === 'stopped') return this.endHelper(callId, 'cancelled', null);
    return [];
  }
}
