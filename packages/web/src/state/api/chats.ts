/** Chat, turn, reply note, chat-to-chat send and search calls and shapes. */
import type { Chat, ChatSend, ChatSendView } from '@otherbench/core/ports/store.js';
import type { CommandRow } from '@otherbench/core/domain/context-lines.js';
import type { ClaudeEffort } from '@otherbench/core/types/config.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import type { RecordedUsage } from '@otherbench/core/types/usage.js';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import type { FolderEntry } from './projects.js';
import { apiFetch } from '../transport.js';
import { ApiError, extractErrorMessage, request, post, patch, del } from './http.js';

/** `POST /api/chats/:id/notes`: the server reads each attachment's type and name from its own row. */
export interface SendNoteBody {
  text: string;
  attachments: { attachmentId: string }[];
  parentId: string | null;
  profileIds: string[];
  clientId: string;
}

export interface CreateChatBody {
  title?: string;
  /** Required unless `projectId` is given: the server then uses the project's default profile, else the app default. */
  profileId?: string;
  /** An absolute path on this machine; stored relative to a location when it's inside one. */
  workspacePath?: string | null;
  workspaceRoot?: string | null;
  /** Files the new chat in this project; it starts with the project's folder unless a folder is given. */
  projectId?: string;
  /**
   * Files the new chat in this app (spec 2026-10-20-code-tab-design): it takes the app's folder and,
   * when usable, its default profile. Never with `projectId` or a folder (both 400).
   */
  appId?: string;
}

export type ChatPatchBody = Partial<{
  title: string;
  profileId: string;
  /** An absolute path on this machine; stored relative to a location when it's inside one. */
  workspacePath: string | null;
  workspaceRoot: string | null;
  /** Only null: no folder. */
  workspace: null;
  /** The machine its turns run on: this one or a paired one (v2 spec §5). */
  runsOn: string;
  pinned: boolean;
  /** Plan first, from the next message (spec 2026-10-12-thread-cards-design §4). */
  planMode: boolean;
  /** Pinned at the top of its own project's group; refused (400) for a chat with no project. */
  projectPinned: boolean;
  archivedAt: number | null;
  /** Ticks the chat off the Overview until it needs him again (spec 2026-10-26-overview): `true` is now, stamped by the server's clock; null puts it back. */
  dealtWithAt: true | null;
  autoMode: boolean;
  /** The Claude account slug the chat is pinned to; null = Default (main, overflowing to the others). */
  claudeAccount: string | null;
  /** Switch to another Claude account when this one hits its limit. */
  accountAutoSwitch: boolean;
  /** Claude Code's effort from the next message; null follows the user's Claude Code settings. */
  effort: ClaudeEffort | null;
  /** The chat's extra folders, the whole list (spec 2026-10-07-extra-folders). */
  folders: FolderEntry[];
  /** Moves the chat between projects (null = No project); never changes its folder or profile. A project also takes it out of its app. */
  projectId: string | null;
  /**
   * Moves the chat into an app ("Move to app"): it takes the app's folder, leaves its project and,
   * with no `profileId` here, takes the app's default profile. Null takes it out of its app and leaves the folder alone.
   */
  appId: string | null;
  /** "Don't add to project memory": the summariser skips this chat. Never changes its place in the list. */
  memoryExcluded: boolean;
  /** Where the fresh chat card asks again after Not now (tokens per call); null uses the setting. Not chat activity. */
  handoverAskAt: number | null;
  /** False stops the fresh chat card for this chat. Not chat activity. */
  handoverSuggest: boolean;
  /** Its place in its sidebar section, higher first (#823). Not chat activity: leaves updatedAt alone. */
  sortOrder: number;
  /** False marks a finished reply as seen, clearing the sidebar's dot. Not chat activity either. */
  unread: boolean;
}>;

export interface CreateTurnBody {
  parentId: string | null;
  parts: Part[];
  profileIds: string[];
}

export interface TurnResult {
  userMessageId: string;
  assistantMessageIds: string[];
  /** The profiles actually run, in `assistantMessageIds` order (a /compact runs one, whatever was selected). */
  profileIds?: string[];
  /** The user message's parts as stored (a typed "/clear" becomes a context part). */
  userParts?: Part[];
}

/** What `POST /chats/:id/regenerate` returns: the new reply, under the same user message. */
export interface RegenerateResult {
  userMessageId: string;
  assistantMessageId: string;
}

export interface ChatMessagesResult {
  messages: CanonMessage[];
  headMessageId: string | null;
  /** Each finished reply's recorded usage, by message id (#819). */
  usage?: Record<string, RecordedUsage>;
}

export interface SearchResult {
  messageId: string;
  chatId: string;
  snippet: string;
}

export const chatsApi = {
  list: () => request<Chat[]>('/chats'),
  create: (body: CreateChatBody) => post<Chat>('/chats', body),
  get: (id: string) => request<Chat>(`/chats/${id}`),
  patch: (id: string, body: ChatPatchBody) => patch<Chat>(`/chats/${id}`, body),
  /** The commands the `/` menu offers in this chat; `warning` when the chat's own couldn't be loaded. */
  commands: (chatId: string, profileId: string) => request<{ commands: CommandRow[]; warning?: string }>(`/chats/${chatId}/commands?profileId=${encodeURIComponent(profileId)}`),
  /** Stops one of the chat's background tasks (spec 2026-10-17-claude-background-helpers-design). */
  stopHelper: (chatId: string, taskId: string) => post<{ stopped: boolean }>(`/chats/${chatId}/helpers/${encodeURIComponent(taskId)}/stop`, {}),
  /** Re-runs the reply to `messageId` on another Claude account (202). */
  continueOnAccount: (chatId: string, body: { messageId: string; account: string }) =>
    post<{ userMessageId: string; assistantMessageIds: string[] }>(`/chats/${chatId}/continue-on-account`, body),
  /** Start fresh chat on the fresh chat card (202): the summary turn's ids; the new chat follows as `chat-handed-over`. */
  handover: (chatId: string, body: { messageId: string }) => post<{ userMessageId: string; assistantMessageIds: string[] }>(`/chats/${chatId}/handover`, body),
  delete: (id: string) => del(`/chats/${id}`),
  messages: (id: string) => request<ChatMessagesResult>(`/chats/${id}/messages`),
  /** The chat as a file (#820): the shown conversation as Markdown, or the whole tree as JSON. */
  export: async (id: string, format: 'markdown' | 'json'): Promise<Blob> => {
    const res = await apiFetch(`/chats/${id}/export?format=${format}`);
    if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
    return res.blob();
  },
  /** Ends the chat's computer-use session and stops its reply (the banner's Stop): `POST /api/chats/:id/computer/stop`. */
  stopComputer: (id: string) => post<void>(`/chats/${encodeURIComponent(id)}/computer/stop`),
  /**
   * Starts computer use for a chat that runs on a paired machine, there (`POST /api/chats/:id/computer/start`):
   * 202 once asked, after which that machine's own start dialog asks; refused when it doesn't let paired machines,
   * computer use is off there, or the chat's profile doesn't use it.
   */
  startComputer: (id: string) => post<{ starting: true }>(`/chats/${encodeURIComponent(id)}/computer/start`),
  /** Stops every reply running in the chat, here or on the paired machine running it (the reply's Stop): `POST /api/chats/:id/stop`. */
  stop: (id: string) => post<{ stopped: string[] }>(`/chats/${encodeURIComponent(id)}/stop`),
};

/** Computer use (spec 2026-10-12-computer-use-design section 7). */
export const computerApi = {
  /** Whether this server can offer the computer tool (the desktop shell on Windows said it can). Authenticated. */
  status: () => request<{ computerUse: boolean }>('/computer/status'),
};

export const search = (q: string, limit?: number) =>
  request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`);

/** The chats with a message matching `q`, each once, best match first (the sidebar's search). */
export const searchChats = (q: string) => request<{ chatId: string }[]>(`/search?scope=chats&q=${encodeURIComponent(q)}`);

/**
 * Chats that message each other (spec 2026-11-06-chat-to-chat-design). The chat-scoped calls are answered by the
 * machine the chat runs on (spec 2026-11-13-chat-sends-across-machines-design), so the card works from either one.
 */
export const chatSendsApi = {
  /** Every send from or to the chat, newest first, each with its machine and whether it could run here. */
  forChat: (chatId: string) => request<{ sends: ChatSendView[] }>(`/chats/${encodeURIComponent(chatId)}/sends`),
  /** The chats with sends of theirs still out, and those with a send held for a machine that is off. */
  waiting: () => request<{ chatIds: string[]; heldChatIds?: string[] }>('/chat-sends/waiting'),
  /** The send card's Stop: everything that reply sent stops, and it doesn't carry on. */
  stop: (fromMessageId: string) => post<{ sends: ChatSend[] }>(`/chat-sends/${encodeURIComponent(fromMessageId)}/stop`),
  /** The same Stop, scoped to its chat so it reaches the machine the chat runs on. */
  stopIn: (chatId: string, fromMessageId: string) => post<{ sends: ChatSendView[] }>(`/chats/${encodeURIComponent(chatId)}/sends/stop`, { fromMessageId }),
  /** A held send: go when its machine is back, and stop asking. */
  wait: (chatId: string, sendId: string) => post<{ sends: ChatSendView[] }>(`/chats/${encodeURIComponent(chatId)}/sends/${encodeURIComponent(sendId)}/wait`),
  /** A held send: don't send it; the chat carries on without it. */
  cancel: (chatId: string, sendId: string) => post<{ sends: ChatSendView[] }>(`/chats/${encodeURIComponent(chatId)}/sends/${encodeURIComponent(sendId)}/cancel`),
  /** A held send: run its chat on this machine instead. */
  runHere: (chatId: string, sendId: string) => post<{ sends: ChatSendView[] }>(`/chats/${encodeURIComponent(chatId)}/sends/${encodeURIComponent(sendId)}/run-here`),
};

export const turnsApi = {
  create: (chatId: string, body: CreateTurnBody) => post<TurnResult>(`/chats/${chatId}/turns`, body),
  cancel: (messageId: string) => post<void>(`/messages/${messageId}/cancel`),
  retry: (messageId: string) => post<{ messageId: string }>(`/messages/${messageId}/retry`),
  setHead: (chatId: string, messageId: string) => post<Chat>(`/chats/${chatId}/head`, { messageId }),
  /** One more reply under the user message `messageId` answers, by the profile that wrote `messageId` (or `profileId`). Makes the new reply the head. */
  regenerate: (chatId: string, messageId: string, profileId?: string) =>
    post<RegenerateResult>(`/chats/${chatId}/regenerate`, { messageId, ...(profileId ? { profileId } : {}) }),
};

export const notesApi = {
  /** Sends a message while a reply runs; 409 `kind` `idle` means nothing is running (send it as a normal turn). */
  send: async (chatId: string, body: SendNoteBody): Promise<ReplyNote> => (await post<{ note: ReplyNote }>(`/chats/${chatId}/notes`, body)).note,
  /** Takes a waiting note back; null when Claude has already read it or it has gone out (409 `read`). */
  withdraw: async (chatId: string, noteId: string): Promise<ReplyNote | null> => {
    try {
      return (await request<{ note: ReplyNote }>(`/chats/${chatId}/notes/${noteId}`, { method: 'DELETE' })).note;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.kind === 'read') return null;
      throw err;
    }
  },
};
