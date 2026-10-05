import { useEffect } from 'react';
import type { AppEvent, AppEventsHello } from '@grunt/core/types/events.js';
import { isDesktop, isMainWindowFocused, onDesktopEvent, showNotification } from '../desktop/bridge.js';
import { loadNotifyPrefs, Notifier } from '../desktop/notify.js';
import { api } from './api.js';
import { refreshMachines } from './machines.js';
import { SseClient } from './sse.js';
import { useGruntStore } from './store.js';

/**
 * Subscribes to `GET /api/events` (v2 plan, Task 34) for as long as the app
 * is mounted: chats created, changed or deleted anywhere (another window,
 * the tray, auto-title) show up here, and the pending-approval count stays
 * current. Reconnects like the chat stream; each `hello` resets the count.
 * In the desktop app it also raises notifications (desktop/notify.ts), and
 * opening Grunt from the tray goes to the chat last notified about.
 */
/** Another machine's changes were applied: chats, projects, profiles and connections may all have changed. */
function refreshAfterSync(): void {
  const { setChats, setProjects, setProfiles, setConnections } = useGruntStore.getState();
  Promise.all([api.chats.list(), api.projects.list(), api.profiles.list(), api.connections.list()])
    .then(([chats, projects, profiles, connections]) => {
      setChats(chats);
      setProjects(projects);
      setProfiles(profiles);
      setConnections(connections);
    })
    .catch((err: unknown) => console.error('[grunt-web] failed to reload after a sync:', err));
}

export function useAppEvents(): void {
  useEffect(() => {
    const { applyAppHello, applyAppEvent } = useGruntStore.getState();
    const notifier = isDesktop()
      ? new Notifier({
          isFocused: isMainWindowFocused,
          show: showNotification,
          chatTitle: (chatId) => useGruntStore.getState().chats.find((c) => c.id === chatId)?.title ?? null,
          prefs: loadNotifyPrefs,
        })
      : null;
    const client = new SseClient<AppEventsHello, AppEvent>({
      url: api.eventsUrl(),
      readHello: (payload) => payload as AppEventsHello,
      onHello: applyAppHello,
      onEvent: (event) => {
        applyAppEvent(event);
        if (event.type === 'sync-applied') refreshAfterSync();
        if (event.type === 'peers-changed' || event.type === 'peer-status') refreshMachines();
        notifier?.handle(event).catch((err: unknown) => console.error('[grunt-web] failed to show a notification:', err));
      },
    });
    client.connect();
    refreshMachines();

    let offTray: (() => void) | null = null;
    let disposed = false;
    if (notifier) {
      void onDesktopEvent('tray-open', () => {
        const chatId = notifier.takeLastChat();
        if (chatId && useGruntStore.getState().chats.some((c) => c.id === chatId)) useGruntStore.getState().setActiveChatId(chatId);
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
