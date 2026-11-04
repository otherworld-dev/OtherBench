import type { AppEvent } from '@otherbench/core/types/events.js';

/**
 * Lets a hook listen to the one `GET /api/events` connection `useAppEvents`
 * holds, rather than opening a second. `useAppEvents` calls `emitAppEvent` for
 * every event it receives, and `emitAppEventsHello` for every hello (the
 * first connect and each reconnect, after which events may have been missed).
 */
type Listener = (event: AppEvent) => void;

const listeners = new Set<Listener>();

/** Calls `listener` for every app event until the returned function is called. */
export function onAppEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitAppEvent(event: AppEvent): void {
  for (const listener of [...listeners]) listener(event);
}

const helloListeners = new Set<() => void>();

/** Calls `listener` on every hello of the events stream (a connect or a reconnect) until the returned function is called. */
export function onAppEventsHello(listener: () => void): () => void {
  helloListeners.add(listener);
  return () => {
    helloListeners.delete(listener);
  };
}

export function emitAppEventsHello(): void {
  for (const listener of [...helloListeners]) listener();
}
