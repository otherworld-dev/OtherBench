import { api } from '../../state/api.js';
import { browserStreamCount, onStreamCountChange, SseClient } from '../../state/sse.js';
import { streamsShareHost } from '../../state/transport.js';

/**
 * The most streams the browser holds to the server before the terminal polls instead of adding one. A browser keeps
 * about 6 HTTP/1.1 connections to one server for all its requests, in every tab, and each stream holds one:
 * `/api/events`, one per chat pane (up to 4), sometimes a browser live view, and the same again in another tab. With 5
 * held, a terminal stream would take the last one, and every other request (its own typing, git status, a message)
 * would wait for ever.
 */
export const STREAM_BUDGET = 5;

/** How long a poll waits after an answer with nothing new, and after one with output. */
const POLL_IDLE_MS = 200;
const POLL_BUSY_MS = 30;
const POLL_RETRY_MS = 1000;

export interface TerminalFeedHandlers {
  /** Start the screen again from this (the first answer, a reconnect, or output that was missed). */
  onReset(buffer: string): void;
  onOutput(data: string): void;
}

export interface TerminalFeedDeps {
  /** Streams the browser holds to this server, in every tab, this terminal's own included. */
  openStreams?: () => number;
  /** Told when that may have changed; returns the unsubscribe. */
  onStreamsChange?: (cb: () => void) => () => void;
  /** False in the desktop app, where each stream has a host name (and so connections) of its own. */
  sharedHost?: () => boolean;
}

type StreamEvent = { type: 'output'; data: string } | { type: 'exit'; exitCode: number };

/**
 * One terminal's output (spec 2026-10-21-code-terminal-design, "One terminal stream per page, at most"): a stream
 * while the browser has a connection to spare, else short requests from where the last one left off, which share the
 * connections with everything else. In the desktop app it always streams: each stream has its own host name there. In
 * a browser it's chosen when the terminal opens, and a streaming terminal drops to polling when other streams (chat
 * panes opened after it, another tab) take the connections it was leaving free. It doesn't go back to streaming.
 */
export function openTerminalFeed(appId: string, id: string, handlers: TerminalFeedHandlers, deps: TerminalFeedDeps = {}): { readonly mode: 'stream' | 'poll'; close(): void } {
  const openStreams = deps.openStreams ?? browserStreamCount;
  const shared = (deps.sharedHost ?? streamsShareHost)();
  let stop: () => void;
  let mode: 'stream' | 'poll';
  let unsubscribe = (): void => {};

  const startPolling = (): void => {
    mode = 'poll';
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let from = 0;
    let first = true;
    const poll = async (): Promise<void> => {
      let wait = POLL_IDLE_MS;
      try {
        const answer = await api.terminals.output(appId, id, from);
        if (closed) return;
        if (first || answer.reset) handlers.onReset(answer.data);
        else if (answer.data !== '') handlers.onOutput(answer.data);
        first = false;
        from = answer.next;
        if (answer.data !== '') wait = POLL_BUSY_MS;
      } catch {
        wait = POLL_RETRY_MS;
      }
      if (!closed) timer = setTimeout(() => void poll(), wait);
    };
    void poll();
    stop = () => {
      closed = true;
      clearTimeout(timer);
    };
  };

  if (!shared || openStreams() < STREAM_BUDGET) {
    mode = 'stream';
    const client = new SseClient<{ buffer: string; exitCode: number | null }, StreamEvent>({
      url: api.terminals.streamUrl(appId, id),
      readHello: (payload) => payload as { buffer: string; exitCode: number | null },
      onHello: (hello) => handlers.onReset(hello.buffer),
      onEvent: (event) => {
        if (event.type === 'output') handlers.onOutput(event.data);
      },
    });
    client.connect();
    stop = () => client.close();
    if (shared) {
      // Its own stream is counted: past the budget, the connection it was leaving free has gone, so it gives its own
      // back. The first poll starts the screen again from the buffer.
      unsubscribe = (deps.onStreamsChange ?? onStreamCountChange)(() => {
        if (mode !== 'stream' || openStreams() <= STREAM_BUDGET) return;
        unsubscribe();
        client.close();
        startPolling();
      });
    }
  } else {
    startPolling();
  }

  return {
    get mode() {
      return mode;
    },
    close: () => {
      unsubscribe();
      stop();
    },
  };
}
