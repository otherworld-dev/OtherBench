import type { ToolContext } from './tool-provider.js';

/**
 * What the `message_chats` tool asks of the server (spec
 * 2026-11-06-chat-to-chat-design): the chats a reply could send work to, and
 * sending it. The server's ChatSendService implements it.
 */
export interface ChatTargetInfo {
  chatId: string;
  title: string;
  /** The app the chat is in, by name, or null. */
  app: string | null;
  /** A reply is being written there now, so a message waits for it. */
  busy: boolean;
}

/** One message: to an existing chat (`chatId`) or a new chat in an app (`app`, by name), never both. */
export interface SendTarget {
  chatId?: string;
  app?: string;
  text: string;
}

export type SendOutcome =
  | { sent: { sendId: string; chatId: string; title: string; app: string | null; createdChat: boolean; queued: boolean }[] }
  /** Nothing was sent; the sentence says why, for the model. */
  | { refused: string };

export interface ChatMessenger {
  list(ctx: ToolContext): ChatTargetInfo[];
  send(ctx: ToolContext, targets: SendTarget[]): Promise<SendOutcome>;
}
