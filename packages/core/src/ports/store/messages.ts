import type { CanonMessage, EngineMeta, MessageStatus, Part, Role, SerializedError, SubagentStatus } from '../../types/messages.js';
import type { ChatHead } from '../../types/overview.js';

// --- messages ----------------------------------------------------------------

/** A message's place in its chat's tree, without its content: what `MessageRepo.outline` lists. */
export interface MessageOutline {
  id: string;
  parentId: string | null;
  role: Role;
}

export interface MessageRepo {
  create(m: Omit<CanonMessage, 'createdAt'> & { createdAt?: number }): CanonMessage;
  get(id: string): CanonMessage | null;
  children(parentId: string): CanonMessage[];
  roots(chatId: string): CanonMessage[];
  pathToRoot(messageId: string): CanonMessage[];   // ordered root -> leaf
  /** A streaming reply's checkpoint: not a change paired machines are sent (the reply is sent once it finishes). */
  updateParts(id: string, parts: Part[]): void;
  /**
   * Changes a finished message's parts as a change paired machines are sent,
   * unlike `updateParts`: a background helper's card in an earlier reply
   * brought up to date, or closed at startup. Throws when the id does not exist.
   */
  reviseParts(id: string, parts: Part[]): void;
  /**
   * Also records when the message stopped being written (`ChatHead.finishedAt`): now for any status but
   * `streaming`, cleared for `streaming` (a retry). Throws when the id does not exist.
   */
  updateStatus(id: string, status: MessageStatus, error?: SerializedError | null): void;
  /** Messages with every word of `query` in their text, best match first; `offset` skips that many, to page through. */
  searchText(query: string, limit: number, offset?: number): { messageId: string; chatId: string; snippet: string }[];
  /**
   * The chats with a message matching `query` (every word in one message, as
   * `searchText`), each once, best match first. The sidebar's search: unlike
   * `searchText`, one long chat can't use up the whole `limit`.
   */
  searchChats(query: string, limit: number): string[];
  /**
   * Every message across every chat currently at `status`, in no particular
   * order. Exists for startup reconciliation (see
   * `domain/reconcile.ts`'s `reconcileInterruptedTurns`), which needs to
   * find every orphaned `streaming` row without walking each chat's message
   * tree one at a time via `roots`/`children`.
   */
  listByStatus(status: MessageStatus): CanonMessage[];
  /**
   * Every message across every chat, at any status, with a top-level
   * `subagent` card at `status`, in no particular order. For startup
   * reconciliation too: a helper card left 'background' by a process that
   * died, found without reading every finished message.
   */
  listWithSubagentStatus(status: SubagentStatus): CanonMessage[];
  /** One row per non-archived chat that has a head message: the tip of the current branch (newest message at or below the head, by time then id): its role, status and time. For the Overview. */
  /** Each unarchived chat's tip, or only `chatId`'s. */
  heads(chatId?: string): ChatHead[];
  /** Stores engine-owned state on a message. Throws when the id does not exist. */
  updateEngineMeta(id: string, meta: EngineMeta): void;
  /** The newest message in `chatId` whose `engineMeta.sessionId` is `sessionId` (by createdAt, then id), or null. */
  latestBySession(chatId: string, sessionId: string): CanonMessage | null;
  /** The id of the newest message in `chatId` (by createdAt, then id), or null: lets the memory sweeps skip an up-to-date chat without reading it. */
  latestId(chatId: string): string | null;
  /**
   * Every message in `chatId`, oldest first (by createdAt, then id), as its
   * id, parent and role only: a re-import works out what a chat lacks from
   * this without reading every message's parts.
   */
  outline(chatId: string): MessageOutline[];
  /** Records that the user kept this compare variant at `at` (see `CanonMessage.keptAt`). Throws when the id does not exist. */
  markKept(id: string, at: number): void;
}
