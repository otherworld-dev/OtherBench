import { useState, type Dispatch, type SetStateAction } from 'react';
import { exportFilename } from '@otherbench/core/domain/export.js';
import { PROJECT_NAME_MAX } from '@otherbench/core/domain/projects.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import { saveFile } from '../../lib/saveFile.js';
import { api, type ChatPatchBody } from '../../state/api.js';
import { setChatPinned } from '../../state/chatActions.js';
import { modeOfChat } from '../../state/mode.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';
import { useOtherBenchStore } from '../../state/store.js';
import { schedulesDeletedLine, useScheduleCount } from '../../views/schedules/useScheduleCount.js';
import type { DropPosition, MenuSource } from './ChatRow.js';
import { errorText } from './errorText.js';
import { focusLater, LIST_SELECTOR, ROW_PREFIX, rowSelector, type RowKind } from './focus.js';
import { allGroups, moveTarget, placeChatPatches, type SidebarModel } from './model.js';

/** A list of chats as the sidebar shows them: Pinned, a project's own pinned chats, or the rest of one project's group (null = No project). */
export interface Section {
  chats: Chat[];
  pinned: boolean;
  projectPinned: boolean;
  projectId: string | null;
  /** In a group sorted by recent activity: its order isn't the user's to change. */
  recent: boolean;
}

/** The chat menu while it's open: whose, and where. */
export type ChatMenuAt = { chatId: string; position: { x: number; y: number } };

/**
 * What the sidebar does to a chat from its row, its menu or a drop: file it under a project or an app, place it in a
 * section, pin, rename, export, archive and delete it, with focus returned to the row the user was on. Opening a
 * chat's menu closes any heading's menu.
 */
export function useChatActions({
  chats,
  sidebar,
  codeMode,
  searching,
  needsYouIds,
  chatMenu,
  setChatMenu,
  setProjectMenu,
  setNoProjectMenu,
  setAppMenu,
  setError,
}: {
  chats: Chat[];
  sidebar: SidebarModel;
  codeMode: boolean;
  searching: boolean;
  needsYouIds: ReadonlySet<string>;
  chatMenu: ChatMenuAt | null;
  setChatMenu: Dispatch<SetStateAction<ChatMenuAt | null>>;
  setProjectMenu: Dispatch<SetStateAction<{ projectId: string; position: { x: number; y: number } } | null>>;
  setNoProjectMenu: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  setAppMenu: Dispatch<SetStateAction<{ appId: string; position: { x: number; y: number } } | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const upsertProject = useOtherBenchStore((s) => s.upsertProject);
  const removeChat = useOtherBenchStore((s) => s.removeChat);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  // Which row the chat menu was opened from, for a chat with a row under Pinned or in Needs you as well as in its group.
  const [menuRow, setMenuRow] = useState<RowKind>('group');
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const deletingChat = deletingChatId ? (chats.find((c) => c.id === deletingChatId) ?? null) : null;
  // Deleting a chat or project deletes its schedules: its delete dialog says how many.
  const chatSchedulesLine = schedulesDeletedLine(useScheduleCount(deletingChatId ? { kind: 'chat', chatId: deletingChatId } : null));

  async function patchChat(chat: Chat, body: ChatPatchBody, action: string): Promise<Chat | null> {
    setError(null);
    try {
      const updated = await api.chats.patch(chat.id, body);
      upsertChat(updated);
      return updated;
    } catch (err) {
      console.error(`[otherbench-web] failed to update chat ${chat.id}:`, err);
      setError(errorText(err, action));
      return null;
    }
  }

  /**
   * Files a chat under a project (null = No project), at the top of that
   * group. A pinned chat keeps its sortOrder, so its place under Pinned, and
   * shows in the group where that puts it. A no-op when it's already there.
   */
  async function moveChat(chatId: string, projectId: string | null): Promise<void> {
    const chat = useOtherBenchStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.projectId === projectId) return;
    const group = (allGroups(sidebar).find((g) => g.key === (projectId ?? NO_PROJECT_KEY))?.chats ?? []).filter((c) => !c.pinned);
    const top = chat.pinned ? [] : placeChatPatches(group, chat, group[0]?.id ?? null).filter((p) => p.id === chat.id);
    const body: ChatPatchBody = { projectId, ...(top[0] ? { sortOrder: top[0].sortOrder } : {}) };
    // An app chat moved to a project leaves its app (the server clears appId), so it changes mode too.
    await moveAcrossModes(chat, body, "Couldn't move the chat");
  }

  /**
   * Sends a PATCH that may take the chat into or out of an app, so out of the
   * mode showing. The store then drops it from this mode's tabs (a chat lives
   * in one mode only, spec 2026-10-20-code-tab-design); when it was the open
   * chat, the window follows it into its new mode rather than losing it.
   */
  async function moveAcrossModes(chat: Chat, body: ChatPatchBody, action: string): Promise<void> {
    const wasOpen = useOtherBenchStore.getState().activeChatId === chat.id;
    const updated = await patchChat(chat, body, action);
    if (!updated) return;
    if (wasOpen && modeOfChat(updated) !== modeOfChat(chat)) setActiveChatId(updated.id);
    focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  /**
   * "Move to app…" (spec 2026-10-20-code-tab-design, Goal 8): the server sets the chat's folder and profile from
   * the app and takes it out of its project. Null is "Move out of app": back to Chat mode, folder kept.
   */
  async function moveChatToApp(chatId: string, appId: string | null): Promise<void> {
    const chat = useOtherBenchStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.appId === appId) return;
    await moveAcrossModes(chat, { appId }, appId === null ? "Couldn't move the chat out of its app" : "Couldn't move the chat to the app");
  }

  /**
   * Puts chat `chatId` in `section` just above `beforeId` (null = the bottom),
   * filing it, or pinning it in its project or not, to match the section
   * (#823). Dropped under Pinned it is pinned; dropped in a group a pinned chat
   * stays pinned, since it shows in its group as well (Deck d961) and only
   * Unpin takes it out of Pinned. Usually one PATCH; a renumbered section
   * sends one per chat that changes.
   */
  async function placeChat(chatId: string, section: Section, beforeId: string | null): Promise<void> {
    const chat = useOtherBenchStore.getState().chats.find((c) => c.id === chatId);
    if (!chat || chat.archivedAt !== null) return;
    const patches = placeChatPatches(section.chats, chat, beforeId);
    const own = patches.find((p) => p.id === chatId);
    const body: ChatPatchBody = {
      ...(own ? { sortOrder: own.sortOrder } : {}),
      ...(section.pinned && !chat.pinned ? { pinned: true } : {}),
      // Pinned in its project when dropped among that project's pinned chats, unpinned when dropped among the rest.
      ...(!section.pinned && chat.projectPinned !== section.projectPinned ? { projectPinned: section.projectPinned } : {}),
      ...(!section.pinned && chat.projectId !== section.projectId ? { projectId: section.projectId } : {}),
    };
    if (Object.keys(body).length === 0) return;
    setError(null);
    try {
      upsertChat(await api.chats.patch(chatId, body));
      for (const p of patches) {
        if (p.id === chatId) continue;
        upsertChat(await api.chats.patch(p.id, { sortOrder: p.sortOrder }));
      }
    } catch (err) {
      console.error('[otherbench-web] failed to reorder chats:', err);
      setError(errorText(err, "Couldn't move the chat"));
      // Part of the reorder may have landed: show the server's order, not a guess.
      try {
        useOtherBenchStore.getState().setChats(await api.chats.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(currentRowSelector(chatId), LIST_SELECTOR);
  }

  /** The chat that a drop `position` relative to row `targetId` lands above, skipping the dragged chat itself. */
  function beforeIdFor(section: Section, targetId: string, position: DropPosition, movingId: string): string | null {
    if (position === 'before') return targetId;
    const rest = section.chats.filter((c) => c.id !== movingId);
    return rest[rest.findIndex((c) => c.id === targetId) + 1]?.id ?? null;
  }

  /**
   * The section the sidebar shows `chat`'s row in, or null when it isn't shown in one: archived, or an app chat. A
   * pinned chat has two: Pinned for its row there (`kind` 'pinned'), else its group. Code mode
   * has no Pinned section and no ordering by hand (a pinned app chat leads its group), so an app chat is in none of
   * Chat mode's sections and its menu offers no Move up / Move down (spec 2026-10-20-code-tab-design, Goal 1).
   */
  function sectionOf(chat: Chat, kind: RowKind = rowKindOf(chat.id)): Section | null {
    if (chat.archivedAt !== null || chat.appId !== null || codeMode) return null;
    if (kind === 'pinned' && chat.pinned) return { chats: sidebar.pinned, pinned: true, projectPinned: false, projectId: null, recent: false };
    for (const group of allGroups(sidebar)) {
      const projectId = group.project?.id ?? null;
      const recent = group.sort === 'recent';
      if (group.pinnedChats.some((c) => c.id === chat.id)) return { chats: group.pinnedChats, pinned: false, projectPinned: true, projectId, recent };
      // A globally pinned chat leads its group, so it moves among the group's other pinned chats (as sidebarRenderers draws them).
      if (group.chats.some((c) => c.id === chat.id)) return { chats: group.chats.filter((c) => c.pinned === chat.pinned), pinned: false, projectPinned: false, projectId, recent };
    }
    return null;
  }

  /** The chat's place in its section, for the menu's Move up / Move down; null while searching, when archived, or in a recent group. */
  function menuPosition(chat: Chat): { index: number; count: number } | null {
    const section = searching ? null : sectionOf(chat);
    if (section?.recent) return null;
    return section ? { index: section.chats.findIndex((c) => c.id === chat.id), count: section.chats.length } : null;
  }

  async function reorderChat(chat: Chat, dir: -1 | 1): Promise<void> {
    const section = sectionOf(chat);
    const target = section ? moveTarget(section.chats, chat.id, dir) : undefined;
    if (section && target) await placeChat(chat.id, section, target.beforeId);
  }

  /** A new project named after the chat, with the chat moved into it, so its conversations can open as tabs (#824). */
  async function moveToNewProject(chat: Chat): Promise<void> {
    setError(null);
    try {
      const name = chat.title.trim().slice(0, PROJECT_NAME_MAX) || 'New project';
      const project = await api.projects.create({ name });
      upsertProject(project);
      await moveChat(chat.id, project.id);
    } catch (err) {
      console.error('[otherbench-web] failed to create a project for the chat:', err);
      setError(errorText(err, "Couldn't create the project"));
    }
  }

  /**
   * Which of a chat's rows its menu and rename belong to: the one the menu was opened from while that row is still
   * shown, else the one in its group.
   */
  function rowKindOf(chatId: string): RowKind {
    if (menuRow === 'list' && needsYouIds.has(chatId)) return 'list';
    if (menuRow === 'pinned' && !codeMode && sidebar.pinned.some((c) => c.id === chatId)) return 'pinned';
    return 'group';
  }

  /**
   * The row to return focus to: the one the user was on (`kind`, by default the menu's), so focus doesn't scroll the
   * sidebar to the chat's other row. From under Pinned, the row in its group once that one is gone (unpinned).
   */
  function currentRowSelector(chatId: string, kind: RowKind = rowKindOf(chatId)): string {
    // Pinned sits above the groups, so a selector list finds the row under Pinned first while there is one.
    return kind === 'pinned' ? `${rowSelector(chatId, 'pinned')}, ${rowSelector(chatId, 'group')}` : rowSelector(chatId, kind);
  }

  /**
   * The row to focus once `chatId`'s row is gone: the next one in the list, else the previous one. Within Needs you
   * or Pinned when the user was there, as a row in a group further down would scroll the sidebar away from where they were.
   */
  function neighbourSelector(chatId: string): string {
    const kind = rowKindOf(chatId);
    const prefix = ROW_PREFIX[kind];
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`));
    const i = rows.findIndex((el) => el.getAttribute('data-testid') === `${prefix}${chatId}`);
    const neighbour = i === -1 ? undefined : (rows[i + 1] ?? rows[i - 1]);
    const id = neighbour?.getAttribute('data-testid')?.slice(prefix.length);
    return id ? rowSelector(id, kind) : LIST_SELECTOR;
  }

  function openChatMenu(chatId: string, position: { x: number; y: number }, source: MenuSource): void {
    setProjectMenu(null);
    setNoProjectMenu(null);
    setAppMenu(null);
    if (source === 'button' && chatMenu?.chatId === chatId) {
      setChatMenu(null);
      focusLater(currentRowSelector(chatId), LIST_SELECTOR);
      return;
    }
    setChatMenu({ chatId, position });
  }

  async function renameChat(chat: Chat, title: string): Promise<void> {
    setRenamingChatId(null);
    if (await patchChat(chat, { title }, "Couldn't rename the chat")) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  /**
   * `row`: which row's pin button, when it was one (else the menu's row). `preventScroll` for the row's own pin
   * button: unpinning from under Pinned sends focus to the chat's row in its group, and following it there would
   * lose the user's place when unpinning several chats.
   */
  async function setPinned(chat: Chat, pinned: boolean, preventScroll = false, row?: RowKind): Promise<void> {
    setError(null);
    try {
      await setChatPinned(chat.id, pinned);
      focusLater(currentRowSelector(chat.id, row), LIST_SELECTOR, preventScroll ? { preventScroll: true } : undefined);
    } catch (err) {
      console.error(`[otherbench-web] failed to update chat ${chat.id}:`, err);
      setError(errorText(err, pinned ? "Couldn't pin the chat" : "Couldn't unpin the chat"));
    }
  }

  async function setProjectPinned(chat: Chat, pinned: boolean): Promise<void> {
    const action = pinned ? "Couldn't pin the chat in its project" : "Couldn't unpin the chat from its project";
    if (await patchChat(chat, { projectPinned: pinned }, action)) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  async function setMemoryExcluded(chat: Chat, excluded: boolean): Promise<void> {
    const action = excluded ? "Couldn't stop this chat adding to project memory" : "Couldn't let this chat add to project memory";
    if (await patchChat(chat, { memoryExcluded: excluded }, action)) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  async function exportChat(chat: Chat, format: 'markdown' | 'json'): Promise<void> {
    setError(null);
    try {
      await saveFile(await api.chats.export(chat.id, format), exportFilename(chat.title, format === 'json' ? 'json' : 'md'));
    } catch (err) {
      console.error(`[otherbench-web] failed to export chat ${chat.id}:`, err);
      setError(errorText(err, "Couldn't export the chat"));
    }
    focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  /** Hides the chat from the sidebar (spec §3: reuses `archivedAt`). */
  async function archiveChat(chat: Chat): Promise<void> {
    const next = neighbourSelector(chat.id);
    // eslint-disable-next-line react-hooks/purity -- runs from the menu's Archive, never in render; the compiler assumes chatMenuItems, called while rendering, may call the actions it is handed.
    const updated = await patchChat(chat, { archivedAt: Date.now() }, "Couldn't archive the chat");
    if (!updated) return;
    if (useOtherBenchStore.getState().activeChatId === chat.id) setActiveChatId(null);
    focusLater(next, LIST_SELECTOR);
  }

  async function unarchiveChat(chat: Chat): Promise<void> {
    if (await patchChat(chat, { archivedAt: null }, "Couldn't unarchive the chat")) focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
  }

  /** Rejects on failure, which keeps the confirmation dialog open with the message. */
  async function deleteChat(chatId: string): Promise<void> {
    const next = neighbourSelector(chatId);
    await api.chats.delete(chatId);
    removeChat(chatId);
    if (useOtherBenchStore.getState().activeChatId === chatId) setActiveChatId(null);
    setDeletingChatId(null);
    focusLater(next, LIST_SELECTOR);
  }

  /** Ticks a chat off: nothing to do here until a newer reply lands. The server stamps it, never before the reply, whatever this device's clock says. */
  function tickOff(chat: Chat): void {
    void patchChat(chat, { dealtWithAt: true }, 'tick off the chat');
  }

  return {
    renamingChatId,
    setRenamingChatId,
    setMenuRow,
    deletingChat,
    setDeletingChatId,
    chatSchedulesLine,
    moveChat,
    moveChatToApp,
    placeChat,
    beforeIdFor,
    menuPosition,
    reorderChat,
    moveToNewProject,
    rowKindOf,
    currentRowSelector,
    openChatMenu,
    renameChat,
    setPinned,
    setProjectPinned,
    setMemoryExcluded,
    exportChat,
    archiveChat,
    unarchiveChat,
    deleteChat,
    tickOff,
  };
}

export type ChatActions = ReturnType<typeof useChatActions>;
