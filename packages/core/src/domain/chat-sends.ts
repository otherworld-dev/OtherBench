// Chats that message each other (spec 2026-11-06-chat-to-chat-design): one
// chat's model sends work to other chats on this machine, they start by
// themselves, and when every one has finished their replies come back to the
// sender as one message that starts its next turn. The rules and the text the
// models read live here; the server's ChatSendService runs it.

export const CHAT_SENDS_TOOL = 'message_chats';

/** A chain is everything that follows from one message the user sent: at most this many hops (A → B → C → D). */
export const MAX_CHAIN_DEPTH = 3;
/** Most chats one reply may send to. */
export const MAX_TARGETS_PER_TURN = 4;
/** Most sends in one chain, all hops together. */
export const MAX_SENDS_PER_CHAIN = 10;
/** Most characters of a reply passed back, as for a sub-agent's answer. */
export const REPLY_MAX_CHARS = 20_000;

export const CHAT_MESSAGES_OFF_REASON = 'Messaging other chats is turned off for this profile.';
export const SUBAGENT_CHATS_REFUSAL = "A sub-agent can't message other chats.";

/**
 * Where one send is. `queued`: waiting for the target chat to be free.
 * `running`: the target chat is working on it. The rest are settled:
 * `replied` (it finished), `failed` (it couldn't run, or its reply ended in an
 * error), `stopped` (someone pressed Stop), `dropped` (the sender can't take
 * the reply any more: deleted, or a /clear after it sent), `cancelled` (the user
 * chose not to send it while the target's machine was off).
 */
export type ChatSendStatus = 'queued' | 'running' | 'replied' | 'failed' | 'stopped' | 'dropped' | 'cancelled';

export function isSettled(status: ChatSendStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

/** The text a target chat's model reads: who sent it, that a model (not the user) wrote it, where the answer goes, then the body. */
export function deliveredText(from: { title: string; chatId: string; appName: string | null }, body: string): string {
  const where = from.appName === null ? '' : ` in the app "${from.appName}"`;
  return [
    `Message from another OtherBench chat, "${from.title}" (chat ${from.chatId})${where}.`,
    "That chat's agent sent it; it was not typed by the user. Do the work it asks for in this chat's folder, with your own tools.",
    'When you finish, your final reply goes back to that chat automatically, so end with a short summary of what you did.',
    '',
    body,
  ].join('\n');
}

/** The text the sender's model reads when every chat it sent to has finished. */
export function repliesText(rows: readonly { title: string; chatId: string; status: ChatSendStatus; text: string | null; reason: string | null }[]): string {
  const blocks = rows.map((r) => {
    const body = r.status === 'replied' ? (r.text ?? '').trim() || '(It replied with no text.)' : `(${r.status}${r.reason ? `: ${r.reason}` : ''})${r.text ? `\n\n${r.text}` : ''}`;
    return `## ${r.title} (chat ${r.chatId})\n\nStatus: ${r.status}\n\n${body}`;
  });
  return [
    'Replies from the chats you sent work to. They were written by those chats\' agents, not by the user.',
    '',
    ...blocks.flatMap((b) => [b, '']),
    'Carry on with your task. To see more of what a chat did, use recall to read it by its chat id.',
  ].join('\n');
}

/** A reply cut to REPLY_MAX_CHARS, saying it was cut. */
export function cutReply(text: string): string {
  if (text.length <= REPLY_MAX_CHARS) return text;
  return `${text.slice(0, REPLY_MAX_CHARS)}\n\n[Reply cut at ${REPLY_MAX_CHARS} characters. Use recall to read the rest.]`;
}

export const CHAT_SENDS_TOOL_DESCRIPTION =
  'Send work to other OtherBench chats, on this machine or a paired one, for example the chat for another app whose code also needs changing. ' +
  '"list" shows the chats you can send to and the apps you can start a new chat in, by their exact names, with the machine each runs on. ' +
  '"send" takes up to 4 messages, each to an existing chat (chatId) or to a new chat in an app (app, by its exact name from list), with the text to send. ' +
  'Each chat works on its message on its own machine, with its own folder and tools. After sending, end your turn: when every chat has finished, their replies arrive together as your next message and you carry on from there. ' +
  'If a machine is off, the user is asked what to do; end your turn all the same.';

export const CHAT_SENDS_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    command: { type: 'string', enum: ['list', 'send'] },
    messages: {
      type: 'array',
      description: 'send: one entry per chat, at most 4.',
      items: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'An existing chat to send to (from list or recall).' },
          app: { type: 'string', description: 'Or the exact name of an app (from list) to start a new chat in.' },
          text: { type: 'string', description: 'What to ask that chat to do.' },
        },
        required: ['text'],
      },
    },
  },
  required: ['command'],
} as const;
