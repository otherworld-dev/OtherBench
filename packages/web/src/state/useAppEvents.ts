import { useEffect } from 'react';
import type { AppEvent, AppEventsHello } from '@grunt/core/types/events.js';
import { api } from './api.js';
import { SseClient } from './sse.js';
import { useGruntStore } from './store.js';

/**
 * Subscribes to `GET /api/events` (v2 plan, Task 34) for as long as the app
 * is mounted: chats created, changed or deleted anywhere (another window,
 * the tray, auto-title) show up here, and the pending-approval count stays
 * current. Reconnects like the chat stream; each `hello` resets the count.
 */
export function useAppEvents(): void {
  useEffect(() => {
    const { applyAppHello, applyAppEvent } = useGruntStore.getState();
    const client = new SseClient<AppEventsHello, AppEvent>({
      url: api.eventsUrl(),
      readHello: (payload) => payload as AppEventsHello,
      onHello: applyAppHello,
      onEvent: applyAppEvent,
    });
    client.connect();
    return () => client.close();
  }, []);
}
