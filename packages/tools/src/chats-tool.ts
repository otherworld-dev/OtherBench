import { CHAT_SENDS_TOOL, CHAT_SENDS_TOOL_DESCRIPTION, CHAT_SENDS_TOOL_PARAMETERS, MAX_TARGETS_PER_TURN } from '@otherbench/core/domain/chat-sends.js';
import type { ChatMessenger, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { ToolSpec } from '@otherbench/core/ports/tool-provider.js';

const SENT_NOTE = 'Sent. End your turn now: when every chat has finished, their replies arrive together as your next message.';

function toolError(message: string): { error: true; code: 'invalid_arguments'; message: string } {
  return { error: true, code: 'invalid_arguments', message };
}

/** The model's messages as targets, or the sentence that says what's wrong with them. */
function targetsOf(raw: unknown): SendTarget[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'send needs "messages": at least one { chatId or app, text }.';
  if (raw.length > MAX_TARGETS_PER_TURN) return `send takes at most ${MAX_TARGETS_PER_TURN} messages at once.`;
  const targets: SendTarget[] = [];
  for (const m of raw) {
    const entry = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
    const chatId = typeof entry['chatId'] === 'string' && entry['chatId'].trim() !== '' ? entry['chatId'].trim() : undefined;
    const app = typeof entry['app'] === 'string' && entry['app'].trim() !== '' ? entry['app'].trim() : undefined;
    const text = typeof entry['text'] === 'string' ? entry['text'] : '';
    if ((chatId === undefined) === (app === undefined)) return 'Each message names either a chatId or an app, not both and not neither.';
    if (text.trim() === '') return 'Each message needs some text.';
    targets.push(chatId !== undefined ? { chatId, text } : { app: app!, text });
  }
  return targets;
}

/**
 * The `message_chats` tool (spec 2026-11-06-chat-to-chat-design), for API
 * engines and, relayed, Claude Code. The broker asks once per chat (source
 * `'chats'`); the messenger does the rest. `describeCall` copies the
 * arguments, which is what makes the Claude Code relay run only an argument
 * object an approval stands behind.
 */
export function chatsTool(messenger: ChatMessenger): ToolSpec {
  return {
    name: CHAT_SENDS_TOOL,
    description: CHAT_SENDS_TOOL_DESCRIPTION,
    parameters: CHAT_SENDS_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    risk: 'execute',
    source: 'chats',
    describeCall: async (args) => ({ args: typeof args === 'object' && args !== null && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {}, risk: 'execute' }),
    execute: async (args, ctx) => {
      const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
      if (a['command'] === 'list') return { chats: messenger.list(ctx) };
      if (a['command'] !== 'send') return toolError('command must be "list" or "send".');
      const targets = targetsOf(a['messages']);
      if (typeof targets === 'string') return toolError(targets);
      const outcome = await messenger.send(ctx, targets);
      if ('refused' in outcome) return { error: true, code: 'refused', message: outcome.refused };
      return { sent: outcome.sent, note: SENT_NOTE };
    },
  };
}
