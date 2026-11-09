import type { ClaudeEffort } from '../../types/config.js';
import type { ExtraFolder, FolderView, Workspace, WorkspaceStatus } from '../../types/workspace.js';
import type { ChatHead } from '../../types/overview.js';

// --- chats ----------------------------------------------------------------

export interface Chat {
  id: string;
  title: string;
  profileId: string;
  headMessageId: string | null;
  /** The chat's folder, portable across machines (v2 spec §6); null for none. */
  workspace: Workspace | null;
  /** The machine (node id) this chat's turns run on: its folder, tools and node-bound models. */
  runsOn: string;
  /**
   * API only: the folder on THIS machine, resolved from `workspace` (null when
   * there is none or it doesn't resolve here), and why it did or didn't
   * resolve. The server fills both on every chat it returns
   * (server/src/workspace-view.ts); the store never does, so server code
   * must resolve `workspace` itself.
   */
  workspaceRoot?: string | null;
  workspaceStatus?: WorkspaceStatus;
  /**
   * Folders the chat may use besides its workspace (spec 2026-10-07-extra-folders),
   * on top of its project's; absent means none. `folderViews` is API only:
   * each of them resolved on the machine that runs the chat.
   */
  folders?: ExtraFolder[];
  folderViews?: FolderView[];
  pinned: boolean;
  /**
   * Kept at the top of its own project's group in the sidebar (spec
   * 2026-10-11-sidebar-layout-design §5), separate from `pinned`. Cleared
   * when the chat changes project, unless the same update sets it.
   */
  projectPinned: boolean;
  /**
   * A reply finished (or failed) here that the user hasn't had on screen
   * since: the sidebar marks the chat. Set by the server when a turn ends
   * complete or in error, cleared by the client once the chat is shown.
   */
  unread: boolean;
  /**
   * When the user ticked this chat off on the Overview ("dealt with"); it
   * needs them again only once a newer reply arrives. Absent is null.
   */
  dealtWithAt?: number | null;
  /**
   * The message at the chat's tip, or null when it has none (or is archived). Only in what the API sends, never
   * stored: the sidebar needs it to tell which chats need the user (`chatNeedsYou`).
   */
  head?: ChatHead | null;
  archivedAt: number | null;
  /**
   * Claude Code auto mode for this chat's turns (spec
   * 2026-10-03-claude-code-auto-mode-design): Claude Code's classifier decides
   * routine tool calls instead of an OtherBench card. Off by default; read fresh by
   * TurnRunner on every turn. Other engines ignore it.
   */
  autoMode: boolean;
  /**
   * Plan mode (spec 2026-10-12-thread-cards-design §4): every new message
   * plans first; tools that change things are refused until the user approves
   * the reply's plan. Read fresh by TurnRunner on every reply. Repositories
   * always fill it (false by default); optional only so older objects type-check.
   */
  planMode?: boolean;
  /**
   * Claude Code's effort for this chat's turns, chosen in the chat window;
   * absent or null follows the user's Claude Code settings. Read fresh by
   * TurnRunner on every turn, so a change applies from the next message.
   * Other engines ignore it.
   */
  effort?: ClaudeEffort | null;
  /**
   * The Claude account (slug) this chat's Claude Code turns run on; null follows the default (main, or another
   * account when main is out of usage). Read fresh by TurnRunner on every turn. Repositories always fill it.
   */
  claudeAccount?: string | null;
  /** Move to another Claude account on a usage limit and carry on. Repositories always fill it (false by default). */
  accountAutoSwitch?: boolean;
  /**
   * How much context the chat's latest reply's last model call read (`Usage.contextTokens`), or null before
   * any was measured. What the fresh chat card compares with its threshold. Repositories always fill it.
   */
  contextTokens?: number | null;
  /** The context size at which the fresh chat card asks again after "Not now"; null uses the setting. Repositories always fill it. */
  handoverAskAt?: number | null;
  /** False when "Don't ask again for this chat" was chosen: no fresh chat card. Repositories always fill it (true by default). */
  handoverSuggest?: boolean;
  /**
   * The project this chat is filed under, or null for "No project" (spec
   * 2026-10-03-projects-design). Purely organisational: moving a chat never
   * changes its folder or profile. Set to null when the project is deleted.
   */
  projectId: string | null;
  /**
   * The app this chat is filed under in Code mode (spec 2026-10-20-code-tab-design), or null. A chat has an app or a
   * project, never both. Not a foreign key (sync order, migration 029): `AppRepo.delete` clears it.
   */
  appId: string | null;
  /**
   * Project memory (spec 2026-10-03-project-memory-design §1): the id of the
   * last message already folded into the project's note, or null when none
   * has been. `ChatRepo.update` resets it whenever `projectId` changes.
   */
  memoryCursor: string | null;
  /**
   * "Don't add to memory": the summariser folds this chat into neither its
   * project's note nor the global note (spec 2026-10-08-global-memory-design).
   * It still receives both.
   */
  memoryExcluded: boolean;
  /**
   * Global memory: the id of the last message already folded into the global
   * note, or null (also when absent) when none has been. Unlike `memoryCursor`
   * it survives a move between projects.
   */
  globalMemoryCursor?: string | null;
  /**
   * The chat's place in its sidebar section, higher first (#823). Set by
   * dragging or Move up/down; chat activity never changes it. Defaults to
   * `createdAt`, so a new chat lands at the top.
   */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * What `ChatRepo.create` takes: timestamps default to now, `sortOrder` to
 * `createdAt`, `autoMode` and `memoryExcluded` to false, `projectId` and
 * `memoryCursor` to null, `runsOn` to this machine. `workspace` defaults to
 * null; a bare `workspaceRoot` is still accepted and stored as a folder
 * bound to this machine (callers that know about locations classify first).
 */
export type NewChat = Omit<
  Chat,
  'createdAt' | 'updatedAt' | 'autoMode' | 'projectId' | 'appId' | 'projectPinned' | 'unread' | 'memoryCursor' | 'memoryExcluded' | 'sortOrder' | 'workspace' | 'runsOn' | 'workspaceRoot' | 'workspaceStatus'
> & {
  workspace?: Workspace | null;
  workspaceRoot?: string | null;
  runsOn?: string;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
  autoMode?: boolean;
  projectId?: string | null;
  appId?: string | null;
  memoryCursor?: string | null;
  memoryExcluded?: boolean;
  projectPinned?: boolean;
  unread?: boolean;
};

export interface ChatRepo {
  create(c: NewChat): Chat;
  get(id: string): Chat | null;
  list(): Chat[];
  /**
   * A patch that changes `projectId` also sets `memoryCursor: null`: the chat
   * starts over in its new project's memory. It also clears `projectPinned`,
   * unless the patch sets that too. A `workspaceRoot` in the patch
   * (and no `workspace`) is stored as a folder bound to this machine.
   */
  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat;
  delete(id: string): void;
}
