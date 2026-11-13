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
  /** The machine the chat runs on, by name (spec 2026-11-13-chat-sends-across-machines-design). */
  machine: string;
  /** Whether that machine takes sends from this one: false it said no, null it hasn't said (or is off). */
  acceptsSends: boolean | null;
}

/** An app a new chat can be started in, by its exact name, and the machine that chat would run on. */
export interface AppTargetInfo {
  name: string;
  machine: string;
  acceptsSends: boolean | null;
}

/** One message: to an existing chat (`chatId`) or a new chat in an app (`app`, by name), never both. */
export interface SendTarget {
  chatId?: string;
  app?: string;
  text: string;
}

export type SendOutcome =
  | {
      sent: {
        sendId: string;
        chatId: string;
        title: string;
        app: string | null;
        createdChat: boolean;
        queued: boolean;
        /** The machine the target runs on, by name. */
        machine: string;
        /** That machine is off or busy: the send waits, and the user has been asked what to do. */
        held: boolean;
      }[];
    }
  /** Nothing was sent; the sentence says why, for the model. */
  | { refused: string };

export interface ChatMessenger {
  list(ctx: ToolContext): Promise<{ chats: ChatTargetInfo[]; apps: AppTargetInfo[] }>;
  send(ctx: ToolContext, targets: SendTarget[]): Promise<SendOutcome>;
}
