import { useRef, useState } from 'react';
import { compareAppFolders } from '@otherbench/core/domain/apps.js';
import type { App } from '@otherbench/core/ports/store.js';
import type { DropPosition, MenuSource } from '../panes/sidebar/ChatRow.js';
import { appSiblings, fileAppPatches, folderKey, moveAppPatches, moveFolderPatches, placeAppPatches, placeFolderPatches } from '../panes/sidebar/model.js';
import { ApiError, api } from '../state/api.js';
import { setGroupCollapsed } from '../state/sidebarGroups.js';
import { useOtherBenchStore } from '../state/store.js';
import { setAppOpen } from './appOpen.js';

/** The page's error line: the server's own message when there is one. */
function errorText(err: unknown, action: string): string {
  return err instanceof ApiError ? `${action}: ${err.message}` : `${action} -- please try again.`;
}

/**
 * Focuses `selector` once React has committed (a filed card re-mounts under its new section), unless focus has
 * meanwhile gone into a menu, a dialog or a text field -- another action took it on purpose.
 */
export function focusLater(selector: string, fallback?: string): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="menu"], [role="alertdialog"], input, select, textarea')) return;
    const target = document.querySelector<HTMLElement>(selector) ?? (fallback ? document.querySelector<HTMLElement>(fallback) : null);
    target?.focus();
  }, 0);
}

/** An app's card on the page: what focus goes back to after acting on the app. */
export const cardSelector = (appId: string): string => `[data-testid="all-apps-card-${appId}"]`;

/** A section's fold button: what focus goes back to after acting on the folder. */
export const headingSelector = (key: string): string => `[data-testid="all-apps-heading-${key}"] [data-heading-main]`;

/** The page's search box: where focus falls back to when what it wanted is gone. */
const SEARCH_SELECTOR = '[data-testid="all-apps-page"] input[type="search"]';

/** The selector of the next element matching `prefix` after `testId`'s, else the one before; for focus after a delete. */
function neighbourOf(prefix: string, testId: string, toSelector: (rest: string) => string): string {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`));
  const i = all.findIndex((el) => el.getAttribute('data-testid') === testId);
  const neighbour = i === -1 ? undefined : (all[i + 1] ?? all[i - 1]);
  const rest = neighbour?.getAttribute('data-testid')?.slice(prefix.length);
  return rest ? toSelector(rest) : SEARCH_SELECTOR;
}

/** What is being dragged on the page: a card (an app) or a section heading (a folder). Both carry `PROJECT_DRAG_MIME`. */
export interface Dragging {
  kind: 'app' | 'folder';
  id: string;
}

/** Where a drag would land: a line before or after a card or a heading, or a whole section lit up (filing, no line). */
export interface DropAt {
  kind: 'card' | 'heading' | 'section';
  /** The app id for a card; the section key for a heading or section. */
  id: string;
  position: DropPosition | null;
}

/**
 * The All apps page's filing and ordering (plan 2026-11-04-open-apps Task 6), ported from the Code sidebar's folder
 * code (plan 2026-10-25-app-folders): folders made, renamed, ordered and deleted; apps renamed, ordered, filed,
 * closed and deleted. Every action names an app or folder by id and does nothing when it has gone meanwhile (deleted
 * in another window or on a paired machine): the patch helpers return no patches for an unknown id.
 *
 * `clearSearch` empties the page's search, so a new folder (and its name field) shows.
 */
export function useAppOrganiser(clearSearch: () => void) {
  const apps = useOtherBenchStore((s) => s.apps);
  const appFolders = useOtherBenchStore((s) => s.appFolders);
  const upsertApp = useOtherBenchStore((s) => s.upsertApp);
  const setApps = useOtherBenchStore((s) => s.setApps);
  const removeApp = useOtherBenchStore((s) => s.removeApp);
  const upsertAppFolder = useOtherBenchStore((s) => s.upsertAppFolder);
  const setAppFolders = useOtherBenchStore((s) => s.setAppFolders);
  const removeAppFolder = useOtherBenchStore((s) => s.removeAppFolder);

  const [error, setError] = useState<string | null>(null);
  const [renamingAppId, setRenamingAppId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [appMenu, setAppMenu] = useState<{ appId: string; position: { x: number; y: number } } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; position: { x: number; y: number } } | null>(null);
  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const creatingFolder = useRef(false);

  const sortedFolders = [...appFolders].sort(compareAppFolders);

  /** The app's folder when that folder is loaded, else null: Unfiled, where the page shows it. */
  function loadedFolderOf(app: App): string | null {
    return app.folderId !== null && appFolders.some((f) => f.id === app.folderId) ? app.folderId : null;
  }

  /** The app's place among the apps of its section, and how many there are: for Move up / Move down. */
  function appPlace(appId: string): { index: number; count: number } {
    const siblings = appSiblings(apps, appId, appFolders);
    return { index: siblings.findIndex((a) => a.id === appId), count: siblings.length };
  }

  /**
   * Sends app order PATCHes one by one (a patch with `folderId` also files that app); on a failure says so and shows
   * the server's apps, since part may have landed.
   */
  async function sendAppOrder(patches: { id: string; folderId?: string | null; sortOrder: number }[], focusId: string, action = "Couldn't reorder the apps"): Promise<void> {
    setError(null);
    try {
      for (const { id, folderId, sortOrder } of patches) upsertApp(await api.apps.patch(id, folderId === undefined ? { sortOrder } : { folderId, sortOrder }));
    } catch (err) {
      console.error('[otherbench-web] failed to reorder apps:', err);
      setError(errorText(err, action));
      try {
        setApps(await api.apps.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(cardSelector(focusId), SEARCH_SELECTOR);
  }

  /**
   * Files an app in a folder (null = Unfiled) just above `beforeId` (null = last), renumbering only that section.
   * Filing into a folded folder opens it, so the app stays in view.
   */
  async function fileApp(appId: string, folderId: string | null, beforeId: string | null): Promise<void> {
    const patches = fileAppPatches(apps, appFolders, appId, folderId, beforeId);
    if (patches.length === 0) return;
    if (folderId !== null) setGroupCollapsed(folderKey(folderId), false);
    await sendAppOrder(patches, appId, "Couldn't move the app");
  }

  /**
   * Puts a dragged app before or after app `targetId` (a drop on its card). An app from another section is filed
   * into the target's section at that place.
   */
  async function placeApp(movingId: string, targetId: string, position: DropPosition): Promise<void> {
    const group = appSiblings(apps, targetId, appFolders);
    if (movingId === targetId || group.length === 0) return;
    const rest = group.filter((a) => a.id !== movingId);
    const beforeId = position === 'before' ? targetId : (rest[rest.findIndex((a) => a.id === targetId) + 1]?.id ?? null);
    if (!group.some((a) => a.id === movingId)) {
      await fileApp(movingId, loadedFolderOf(group[0]!), beforeId);
      return;
    }
    const patches = placeAppPatches(group, movingId, beforeId);
    if (patches.length > 0) await sendAppOrder(patches, movingId);
  }

  /** "Move to folder…": last in that folder, or (null) Unfiled; nothing when it's there already. */
  async function moveAppToFolder(appId: string, folderId: string | null): Promise<void> {
    const app = apps.find((a) => a.id === appId);
    if (!app) return;
    if (loadedFolderOf(app) !== folderId) await fileApp(appId, folderId, null);
    else focusLater(cardSelector(appId), SEARCH_SELECTOR);
  }

  async function moveApp(appId: string, dir: -1 | 1): Promise<void> {
    await sendAppOrder(moveAppPatches(appSiblings(apps, appId, appFolders), appId, dir), appId);
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
    focusLater(cardSelector(appId), SEARCH_SELECTOR);
  }

  /** Close app from the card menu: the card stays, without its In sidebar mark. */
  async function closeApp(appId: string): Promise<void> {
    setError(null);
    try {
      await setAppOpen(appId, false);
    } catch (err) {
      console.error(`[otherbench-web] failed to close app ${appId}:`, err);
      setError(errorText(err, "Couldn't close the app"));
    }
    focusLater(cardSelector(appId), SEARCH_SELECTOR);
  }

  /**
   * Rejects on failure, which keeps the confirmation dialog open with the message. Its chats go back to Chat mode
   * (spec 2026-10-20-code-tab-design, "Creating an app"): `removeApp` clears their `appId` here as the server does.
   */
  async function deleteApp(appId: string): Promise<void> {
    const next = neighbourOf('all-apps-card-', `all-apps-card-${appId}`, cardSelector);
    try {
      await api.apps.delete(appId);
    } catch (err) {
      // Already gone (deleted in another tab): same end state the user asked for.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    removeApp(appId);
    setDeletingAppId(null);
    focusLater(next, SEARCH_SELECTOR);
  }

  /** "+ New folder": the server names it "New folder", and its name opens for editing. A double-click makes one. */
  async function createFolder(): Promise<void> {
    if (creatingFolder.current) return;
    creatingFolder.current = true;
    setError(null);
    // A search would hide the new folder (and its rename) unless its name happened to match.
    clearSearch();
    try {
      const folder = await api.appFolders.create({});
      upsertAppFolder(folder);
      setRenamingFolderId(folder.id);
    } catch (err) {
      console.error('[otherbench-web] failed to create a folder:', err);
      setError(errorText(err, "Couldn't create the folder"));
    } finally {
      creatingFolder.current = false;
    }
  }

  async function renameFolder(folderId: string, name: string): Promise<void> {
    setRenamingFolderId(null);
    setError(null);
    try {
      upsertAppFolder(await api.appFolders.patch(folderId, { name }));
    } catch (err) {
      console.error(`[otherbench-web] failed to rename folder ${folderId}:`, err);
      setError(errorText(err, "Couldn't rename the folder"));
    }
    focusLater(headingSelector(folderKey(folderId)), SEARCH_SELECTOR);
  }

  /** As `sendAppOrder`, for folders. */
  async function sendFolderOrder(patches: { id: string; sortOrder: number }[], focusId: string): Promise<void> {
    setError(null);
    try {
      for (const { id, sortOrder } of patches) upsertAppFolder(await api.appFolders.patch(id, { sortOrder }));
    } catch (err) {
      console.error('[otherbench-web] failed to reorder folders:', err);
      setError(errorText(err, "Couldn't reorder the folders"));
      try {
        setAppFolders(await api.appFolders.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(headingSelector(folderKey(focusId)), SEARCH_SELECTOR);
  }

  /** Puts a dragged folder above or below folder `targetId` (a drop on its heading). */
  async function placeFolder(movingId: string, targetId: string, position: DropPosition): Promise<void> {
    if (movingId === targetId) return;
    const rest = sortedFolders.filter((f) => f.id !== movingId);
    const beforeId = position === 'before' ? targetId : (rest[rest.findIndex((f) => f.id === targetId) + 1]?.id ?? null);
    const patches = placeFolderPatches(appFolders, movingId, beforeId);
    if (patches.length > 0) await sendFolderOrder(patches, movingId);
  }

  async function moveFolder(folderId: string, dir: -1 | 1): Promise<void> {
    await sendFolderOrder(moveFolderPatches(appFolders, folderId, dir), folderId);
  }

  /**
   * Rejects on failure, which keeps the confirmation dialog open with the message. Its apps move to Unfiled
   * (`removeAppFolder` clears their `folderId` here as the server does); nothing else changes, an open home included.
   */
  async function deleteFolder(folderId: string): Promise<void> {
    const key = folderKey(folderId);
    const next = neighbourOf('all-apps-heading-', `all-apps-heading-${key}`, headingSelector);
    try {
      await api.appFolders.delete(folderId);
    } catch (err) {
      // Already gone (deleted in another tab): same end state the user asked for.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    removeAppFolder(folderId);
    setDeletingFolderId(null);
    focusLater(next, SEARCH_SELECTOR);
  }

  /** The ⋯ button toggles its menu; a right-click or Shift+F10 opens it where asked. One menu at a time. */
  function openAppMenu(appId: string, position: { x: number; y: number }, source: MenuSource): void {
    setFolderMenu(null);
    if (source === 'button' && appMenu?.appId === appId) {
      setAppMenu(null);
      focusLater(cardSelector(appId));
      return;
    }
    setAppMenu({ appId, position });
  }

  function openFolderMenu(folderId: string, position: { x: number; y: number }, source: MenuSource): void {
    setAppMenu(null);
    if (source === 'button' && folderMenu?.folderId === folderId) {
      setFolderMenu(null);
      focusLater(headingSelector(folderKey(folderId)));
      return;
    }
    setFolderMenu({ folderId, position });
  }

  function endDrag(): void {
    setDragging(null);
    setDropAt(null);
  }

  /** A drop: ends the drag and hands over what was being dragged, if it was of `kind`. */
  function takeDragged(kind: Dragging['kind']): string | null {
    const moving = dragging?.kind === kind ? dragging.id : null;
    endDrag();
    return moving;
  }

  return {
    apps,
    sortedFolders,
    error,
    renamingAppId,
    setRenamingAppId,
    renamingFolderId,
    setRenamingFolderId,
    appMenu,
    setAppMenu,
    folderMenu,
    setFolderMenu,
    deletingAppId,
    setDeletingAppId,
    deletingFolderId,
    setDeletingFolderId,
    dragging,
    setDragging,
    dropAt,
    setDropAt,
    endDrag,
    takeDragged,
    loadedFolderOf,
    appPlace,
    fileApp,
    placeApp,
    moveAppToFolder,
    moveApp,
    renameApp,
    closeApp,
    deleteApp,
    createFolder,
    renameFolder,
    placeFolder,
    moveFolder,
    deleteFolder,
    openAppMenu,
    openFolderMenu,
  };
}

export type AppOrganiser = ReturnType<typeof useAppOrganiser>;
