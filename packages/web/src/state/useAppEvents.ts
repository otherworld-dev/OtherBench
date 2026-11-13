import { useEffect } from 'react';
import type { AppEvent, AppEventsHello } from '@otherbench/core/types/events.js';
import { focusedWindow, isDesktop, onDesktopEvent, showNotification } from '../desktop/bridge.js';
import { windowForMode } from '../desktop/windows.js';
import { loadNotifyPrefs, Notifier } from '../desktop/notify.js';
import { showBrowserScheduledNotification } from '../lib/browserNotify.js';
import { api } from './api.js';
import { emitAppEvent, emitAppEventsHello } from './appEventListeners.js';
import { refreshFeatures } from './features.js';
import { refreshMachines } from './machines.js';
import { SseClient } from './sse.js';
import { modeOfChat } from './mode.js';
import { useOtherBenchStore, WINDOW_ROLE } from './store.js';

/**
 * Subscribes to `GET /api/events` (v2 plan, Task 34) for as long as the app
 * is mounted: chats created, changed or deleted anywhere (another window,
 * the tray, auto-title) show up here, and the pending-approval count stays
 * current. Reconnects like the chat stream; each `hello` resets the count.
 * In the desktop app it also raises notifications (desktop/notify.ts), and
 * opening OtherBench from the tray goes to the chat last notified about; only
 * the main window does, so an undocked one never raises them twice.
 */
/**
 * Another machine's changes were applied: chats, projects, profiles,
 * connections, apps and app folders may all have changed. Apps sync like the rest (spec
 * 2026-10-20-code-tab-design, "Apps sync like projects"), so an app made,
 * renamed or deleted on the other machine shows in the Code sidebar without a
 * reload.
 */
export function refreshAfterSync(): void {
  const { setChats, setProjects, setProfiles, setConnections, setApps, setAppFolders } = useOtherBenchStore.getState();
  Promise.all([api.chats.list(), api.projects.list(), api.profiles.list(), api.connections.list(), api.apps.list(), api.appFolders.list()])
    .then(([chats, projects, profiles, connections, apps, appFolders]) => {
      setChats(chats);
      setProjects(projects);
      setProfiles(profiles);
      setConnections(connections);
      setApps(apps);
      setAppFolders(appFolders);
    })
    .catch((err: unknown) => console.error('[otherbench-web] failed to reload after a sync:', err));
}

/** The chats with sends still out (spec 2026-11-06-chat-to-chat-design), for their status word. */
function refreshWaitingOnChats(): void {
  api.chatSends
    .waiting()
    .then(({ chatIds, heldChatIds }) => {
      useOtherBenchStore.getState().setWaitingOnChats(chatIds);
      useOtherBenchStore.getState().setHeldChats(heldChatIds ?? []);
    })
    .catch((err: unknown) => console.error('[otherbench-web] failed to read the chats waiting on others:', err));
}

let readingApps = false;
let readAppsAgain = false;

/**
 * An app or app folder changed on this machine, maybe in another window. Each window holds its own lists, and Move to
 * app… reads them. A burst (a drag writes one row at a time) gets one more read after the one out, which has the last
 * of it, so an older answer can't be the one that stays.
 */
function refreshApps(): void {
  if (readingApps) {
    readAppsAgain = true;
    return;
  }
  readingApps = true;
  Promise.all([api.apps.list(), api.appFolders.list()])
    .then(([apps, appFolders]) => {
      const { setApps, setAppFolders } = useOtherBenchStore.getState();
      setApps(apps);
      setAppFolders(appFolders);
    })
    .catch((err: unknown) => console.error('[otherbench-web] failed to reload the apps:', err))
    .finally(() => {
      readingApps = false;
      if (!readAppsAgain) return;
      readAppsAgain = false;
      refreshApps();
    });
}

/** The window holding `chatId` (desktop/windows.ts), which a notification about it opens and whose focus hides it. */
function windowOfChat(chatId: string | null): 'main' | 'code' {
  const { chats, undocked } = useOtherBenchStore.getState();
  const chat = chatId === null ? undefined : chats.find((c) => c.id === chatId);
  return chat ? windowForMode(modeOfChat(chat), undocked, 'main') : 'main';
}

/** A clicked notification's chat, if it is still here. */
function openNotifiedChat(chatId: string): void {
  if (useOtherBenchStore.getState().chats.some((c) => c.id === chatId)) useOtherBenchStore.getState().setActiveChatId(chatId);
}

export function useAppEvents(): void {
  useEffect(() => {
    const { applyAppHello, applyAppEvent } = useOtherBenchStore.getState();
    const notifier = isDesktop() && WINDOW_ROLE === 'main'
      ? new Notifier({
          isFocused: async (chatId) => (await focusedWindow()) === windowOfChat(chatId),
          isBusy: (chatId) => {
            const { appRunningTurns, appBackgroundChats } = useOtherBenchStore.getState();
            return chatId in appBackgroundChats || Object.values(appRunningTurns).includes(chatId);
          },
          show: (title, body, chatId) => showNotification(title, body, chatId, null, windowOfChat(chatId)),
          chatTitle: (chatId) => useOtherBenchStore.getState().chats.find((c) => c.id === chatId)?.title ?? null,
          prefs: loadNotifyPrefs,
        })
      : null;
    // In a plain browser, scheduled runs can raise browser notifications instead (lib/browserNotify.ts, opt-in).
    const browser = !isDesktop();
    const client = new SseClient<AppEventsHello, AppEvent>({
      url: api.eventsUrl(),
      readHello: (payload) => payload as AppEventsHello,
      // A hello comes on every connect, so after a reconnect too: events may have been missed meanwhile.
      onHello: (hello) => {
        applyAppHello(hello);
        emitAppEvent({ type: 'overview-changed' });
        // The Inspector's MCP, grants and audit sections re-read everything (useLiveData).
        emitAppEventsHello();
        // Missed a switch while disconnected, or this is start-up.
        refreshFeatures();
        // And what paired machines said meanwhile (replies running, cards waiting, a session controlling one): the
        // `peer-activity` events that would have re-read it may have been missed too.
        refreshMachines();
        refreshWaitingOnChats();
      },
      onEvent: (event) => {
        applyAppEvent(event);
        emitAppEvent(event);
        if (event.type === 'sync-applied') refreshAfterSync();
        if (event.type === 'apps-changed') refreshApps();
        if (event.type === 'chat-sends-changed') refreshWaitingOnChats();
        if (event.type === 'settings-changed') refreshFeatures();
        if (event.type === 'peers-changed' || event.type === 'peer-status' || event.type === 'peer-activity') refreshMachines();
        notifier?.handle(event).catch((err: unknown) => console.error('[otherbench-web] failed to show a notification:', err));
        if (browser) {
          try {
            showBrowserScheduledNotification(event, openNotifiedChat);
          } catch (err) {
            // Some browsers (Chrome on Android) only notify through a service worker, which this page doesn't have.
            console.error('[otherbench-web] failed to show a browser notification:', err);
          }
        }
      },
    });
    client.connect();
    refreshMachines();

    let offTray: (() => void) | null = null;
    let disposed = false;
    if (notifier) {
      void onDesktopEvent('tray-open', () => {
        const chatId = notifier.takeLastChat();
        if (chatId) openNotifiedChat(chatId);
      }).then((off) => {
        if (disposed) off();
        else offTray = off;
      });
    }
    return () => {
      disposed = true;
      offTray?.();
      client.close();
    };
  }, []);
}
