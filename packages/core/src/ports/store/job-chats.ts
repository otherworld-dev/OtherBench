/**
 * Job chats (migration 051): which chats are unattended job chats, and the folder each is held to. Local to this
 * machine and never synced. TurnRunner reads it for every turn, so a chat listed here always runs under the job rules
 * (docs/features/jobs.md), whatever its profile says.
 */
export interface JobChatStore {
  /**
   * Marks a chat as a job chat held to `folder`. Called before the chat's first turn. `appContext` (migration 052)
   * says its turns get its app's notes and its linked project's instructions and memory; left out, they get none.
   */
  add(chatId: string, folder: string, options?: { appContext?: boolean }): void;
  /** The folder a job chat is held to, or null for any other chat. */
  folderFor(chatId: string): string | null;
  /** Whether a job chat was made with its app's knowledge. False for any other chat. */
  appContextFor(chatId: string): boolean;
  remove(chatId: string): void;
}
