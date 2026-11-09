import { useState, type Dispatch, type SetStateAction } from 'react';
import { APP_NAME_MAX } from '@otherbench/core/domain/apps.js';
import type { App, AppFolder } from '@otherbench/core/ports/store.js';
import { setAppOpen } from '../../code/appOpen.js';
import { toast } from '../../lib/toasts.js';
import { ApiError, api } from '../../state/api.js';
import { appTabId } from '../../state/appTab.js';
import { useOtherBenchStore } from '../../state/store.js';
import type { DropPosition, MenuSource } from './ChatRow.js';
import { errorText } from './errorText.js';
import { focusLater, headingSelector, LIST_SELECTOR, neighbourHeadingSelector } from './focus.js';
import { appSiblings, placeAppPatches, shownAppSiblings, sidebarAppBeforeId } from './model.js';
import type { ProjectGroupProps } from './ProjectGroup.js';
import type { ChatMenuAt } from './useChatActions.js';

/**
 * Code mode's app headings: each one's menu, rename, delete, close (with Undo) and Keep in sidebar, and reordering
 * among the shown apps of its folder by drag or Move up / Move down. Opening an app's menu closes the chat menu.
 */
export function useAppHeadings({
  apps,
  appFolders,
  searching,
  shownAppIds,
  activeChatId,
  setError,
  setChatMenu,
}: {
  apps: App[];
  appFolders: AppFolder[];
  searching: boolean;
  shownAppIds: ReadonlySet<string>;
  activeChatId: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  setChatMenu: Dispatch<SetStateAction<ChatMenuAt | null>>;
}) {
  const openAppHome = useOtherBenchStore((s) => s.openAppHome);
  const upsertApp = useOtherBenchStore((s) => s.upsertApp);
  const setApps = useOtherBenchStore((s) => s.setApps);
  const removeApp = useOtherBenchStore((s) => s.removeApp);
  // Likewise an app's heading in Code mode, among the shown apps beside it.
  const [draggingAppId, setDraggingAppId] = useState<string | null>(null);
  const [appDrop, setAppDrop] = useState<{ appId: string; position: DropPosition } | null>(null);
  const [appMenu, setAppMenu] = useState<{ appId: string; position: { x: number; y: number } } | null>(null);
  const [renamingAppId, setRenamingAppId] = useState<string | null>(null);
  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);
  const menuApp = appMenu ? (apps.find((a) => a.id === appMenu.appId) ?? null) : null;
  const deletingApp = deletingAppId ? (apps.find((a) => a.id === deletingAppId) ?? null) : null;

  function openAppMenu(appId: string, position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    if (source === 'button' && appMenu?.appId === appId) {
      setAppMenu(null);
      focusLater(headingSelector(appId), LIST_SELECTOR);
      return;
    }
    setAppMenu({ appId, position });
  }

  async function renameApp(appId: string, name: string): Promise<void> {
    setRenamingAppId(null);
    setError(null);
    try {
      upsertApp(await api.apps.patch(appId, { name }));
    } catch (err) {
      console.error(`[otherbench-web] failed to rename app ${appId}:`, err);
      setError(errorText(err, "Couldn't rename the app"));
    }
    focusLater(headingSelector(appId), LIST_SELECTOR);
  }

  /**
   * Rejects on failure, which keeps the confirmation dialog open with the message. Its chats go back to Chat mode
   * (spec 2026-10-20-code-tab-design, "Creating an app"): `removeApp` clears their `appId` here as the server does,
   * and the server's chat-updated events bring the rest.
   */
  async function deleteApp(appId: string): Promise<void> {
    const next = neighbourHeadingSelector(appId);
    try {
      await api.apps.delete(appId);
    } catch (err) {
      // Already gone (deleted in another tab): same end state the user asked for.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    removeApp(appId);
    setDeletingAppId(null);
    focusLater(next, LIST_SELECTOR);
  }

  /**
   * Closes an app (plan 2026-11-04-open-apps): it leaves the sidebar and nothing else changes, no chat archived and no
   * tab closed. The toast's Undo opens it again by sending `open: true` (`setAppOpen`), not by putting back the app as
   * it was, so a rename that synced in meanwhile stays.
   */
  async function closeApp(app: App): Promise<void> {
    const next = neighbourHeadingSelector(app.id);
    setError(null);
    try {
      await setAppOpen(app.id, false);
    } catch (err) {
      console.error(`[otherbench-web] failed to close app ${app.id}:`, err);
      setError(errorText(err, "Couldn't close the app"));
      focusLater(headingSelector(app.id), LIST_SELECTOR);
      return;
    }
    const name = useOtherBenchStore.getState().apps.find((a) => a.id === app.id)?.name ?? app.name;
    toast({ text: `Closed ${name}. It's still in All apps.`, tone: 'ok', action: { label: 'Undo', run: () => void reopenApp(app.id, name) } });
    // Still there when a live chat keeps it in the sidebar; else the next heading.
    focusLater(headingSelector(app.id), next);
  }

  /** Keep in sidebar, on a closed app the sidebar shows only for a live chat or a search: it opens the app again. */
  async function keepApp(app: App): Promise<void> {
    setError(null);
    try {
      await setAppOpen(app.id, true);
    } catch (err) {
      console.error(`[otherbench-web] failed to keep app ${app.id} in the sidebar:`, err);
      setError(errorText(err, "Couldn't keep the app in the sidebar"));
    }
    focusLater(headingSelector(app.id), LIST_SELECTOR);
  }

  /** Sends app order PATCHes one by one; on a failure says so and shows the server's apps, since part may have landed. */
  async function sendAppOrder(patches: { id: string; sortOrder: number }[], focusId: string): Promise<void> {
    setError(null);
    try {
      for (const { id, sortOrder } of patches) upsertApp(await api.apps.patch(id, { sortOrder }));
    } catch (err) {
      console.error('[otherbench-web] failed to reorder apps:', err);
      setError(errorText(err, "Couldn't reorder the apps"));
      try {
        setApps(await api.apps.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(headingSelector(focusId), LIST_SELECTOR);
  }

  /**
   * Puts an app just above or below shown app `targetId` of the same folder (a heading drop, or Move up / Move down).
   * Its closed siblings keep their order; filing into another folder stays on the All apps page.
   */
  async function placeApp(movingId: string, targetId: string, position: DropPosition): Promise<void> {
    const beforeId = sidebarAppBeforeId(apps, appFolders, movingId, targetId, position);
    if (beforeId === undefined) return;
    const patches = placeAppPatches(appSiblings(apps, movingId, appFolders), movingId, beforeId);
    if (patches.length > 0) await sendAppOrder(patches, movingId);
  }

  /** The app's place among the shown apps beside it, for the menu's Move up / Move down; null while searching. */
  function appPlace(appId: string): { index: number; count: number } | null {
    if (searching) return null;
    const shown = shownAppSiblings(apps, appId, appFolders, shownAppIds);
    const index = shown.findIndex((a) => a.id === appId);
    return index === -1 ? null : { index, count: shown.length };
  }

  /** Steps an app past the shown app above (-1) or below (+1) it. */
  async function moveApp(appId: string, dir: -1 | 1): Promise<void> {
    const shown = shownAppSiblings(apps, appId, appFolders, shownAppIds);
    const index = shown.findIndex((a) => a.id === appId);
    const neighbour = index === -1 ? undefined : shown[index + dir];
    if (neighbour) await placeApp(appId, neighbour.id, dir === -1 ? 'before' : 'after');
  }

  /** The close toast's Undo. Says so in a toast of its own if it fails: the sidebar's error line may be long gone. */
  async function reopenApp(appId: string, name: string): Promise<void> {
    try {
      await setAppOpen(appId, true);
      // Undo from the toast: focus goes to the app it put back.
      focusLater(headingSelector(appId), LIST_SELECTOR);
    } catch (err) {
      console.error(`[otherbench-web] failed to reopen app ${appId}:`, err);
      toast({ text: `Couldn't put ${name} back in the sidebar -- please try again.`, tone: 'error' });
    }
  }

  /**
   * The app-only props of a Code mode group heading. Its heading drags among the shown apps of its folder (or the top
   * level), as a project heading does among its siblings; filing into folders is on the All apps page. An open app's
   * heading has a × that closes it; a closed one (shown because a chat is live, or found by a search) has none.
   */
  function appGroupProps(app: App): Partial<ProjectGroupProps> {
    const target = draggingAppId !== null && draggingAppId !== app.id && shownAppSiblings(apps, app.id, appFolders, shownAppIds).some((a) => a.id === draggingAppId);
    return {
      reorder: {
        draggable: !searching,
        onDragStart: () => setDraggingAppId(app.id),
        onDragEnd: () => {
          setDraggingAppId(null);
          setAppDrop(null);
        },
        target,
        indicator: target && appDrop?.appId === app.id ? appDrop.position : null,
        onOver: (position) => setAppDrop({ appId: app.id, position }),
        onLeave: () => setAppDrop((current) => (current?.appId === app.id ? null : current)),
        onDrop: (position) => {
          const moving = draggingAppId;
          setDraggingAppId(null);
          setAppDrop(null);
          if (moving) void placeApp(moving, app.id, position);
        },
      },
      ...(app.open ? { onClose: () => void closeApp(app), closeLabel: `Close ${app.name}` } : {}),
      onOpen: () => openAppHome(app.id),
      openTitle: "Open the app's home",
      active: activeChatId === appTabId(app.id),
      menuOpen: appMenu?.appId === app.id,
      menuLabel: 'App actions',
      renaming: renamingAppId === app.id,
      renameLabel: 'App name',
      renameMaxLength: APP_NAME_MAX,
      onOpenMenu: (position, source) => openAppMenu(app.id, position, source),
      onRename: (name) => void renameApp(app.id, name),
      onRenameCancel: () => {
        setRenamingAppId(null);
        focusLater(headingSelector(app.id), LIST_SELECTOR);
      },
    };
  }

  return { appMenu, setAppMenu, menuApp, deletingApp, setRenamingAppId, setDeletingAppId, deleteApp, closeApp, keepApp, moveApp, appPlace, appGroupProps };
}

export type AppHeadings = ReturnType<typeof useAppHeadings>;
