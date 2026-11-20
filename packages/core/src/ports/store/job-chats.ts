/**
 * Job chats (migration 051): which chats are unattended job chats, and the folder each is held to. Local to this
 * machine and never synced. TurnRunner reads it for every turn, so a chat listed here always runs under the job rules
 * (docs/features/jobs.md), whatever its profile says.
 */
export interface JobChatStore {
  /** Marks a chat as a job chat held to `folder`. Called before the chat's first turn. */
  add(chatId: string, folder: string): void;
  /** The folder a job chat is held to, or null for any other chat. */
  folderFor(chatId: string): string | null;
  remove(chatId: string): void;
}
