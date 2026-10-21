import { api } from '../../state/api.js';
import { openStreamCount, SseClient } from '../../state/sse.js';

/**
 * The most streams a page holds before the terminal polls instead of adding one. A browser keeps about 6 HTTP/1.1
 * connections to one server for all of a page's requests, and each stream holds one: `/api/events`, one per chat
 * pane (up to 4), sometimes a browser live view. With 5 held, a terminal stream would take the last one, and every
 * other request (its own typing, git status, a message) would wait for ever.
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

type StreamEvent = { type: 'output'; data: string } | { type: 'exit'; exitCode: number };

/**
 * One terminal's output (spec 2026-10-21-code-terminal-design, "One terminal stream per page, at most"): a stream
 * while the page has a connection to spare, else short requests from where the last one left off, which share the
 * page's connections with everything else. Chosen when it opens.
 */
export function openTerminalFeed(
  appId: string,
  id: string,
  handlers: TerminalFeedHandlers,
  deps: { openStreams?: () => number } = {}
): { mode: 'stream' | 'poll'; close(): void } {
  if ((deps.openStreams ?? openStreamCount)() < STREAM_BUDGET) {
    const client = new SseClient<{ buffer: string; exitCode: number | null }, StreamEvent>({
      url: api.terminals.streamUrl(appId, id),
      readHello: (payload) => payload as { buffer: string; exitCode: number | null },
      onHello: (hello) => handlers.onReset(hello.buffer),
      onEvent: (event) => {
        if (event.type === 'output') handlers.onOutput(event.data);
      },
    });
    client.connect();
    return { mode: 'stream', close: () => client.close() };
  }

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
  return {
    mode: 'poll',
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}
