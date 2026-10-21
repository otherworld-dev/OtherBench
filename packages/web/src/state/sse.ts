import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { HelloBuffer, StreamConnectionStatus } from './store.js';
import { authHeaders, reportUnauthorized } from './transport.js';

/** Backoff schedule (ms) between reconnect attempts; the last value repeats once exhausted. */
const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 15000];

/** What a stream connection reports: each complete SSE event, and its own end or failure. */
export interface SseHandlers {
  onEvent: (type: string, data: string) => void;
  /** Called at most once per connection: failed to open, non-2xx, network error, or the server ended the stream. */
  onError: () => void;
}

export interface SseConnection {
  close(): void;
}

export type SseConnect = (url: string, handlers: SseHandlers) => SseConnection;

/**
 * Incremental parser for the subset of `text/event-stream` this server
 * emits (`event:`, `data:`, `:` comments), per the WHATWG dispatch rules:
 * fields accumulate until a blank line, `data` lines join with `\n`, one
 * leading space after the colon is dropped, and an event with no data is
 * not dispatched. `id:` and `retry:` are accepted and ignored -- reconnect
 * timing is `SseClient`'s own backoff, not the server's.
 */
export class SseParser {
  private buffer = '';
  private eventType = '';
  private dataLines: string[] = [];

  push(chunk: string): Array<{ event: string; data: string }> {
    this.buffer += chunk;
    const out: Array<{ event: string; data: string }> = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      if (line === '') {
        if (this.dataLines.length > 0) out.push({ event: this.eventType || 'message', data: this.dataLines.join('\n') });
        this.eventType = '';
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.eventType = value;
      else if (field === 'data') this.dataLines.push(value);
    }
    return out;
  }
}

/**
 * Opens an SSE stream with `fetch` rather than `EventSource`, because
 * `EventSource` can't send an `Authorization` header and the desktop
 * shell's server requires one. Reconnection is deliberately not handled
 * here -- `SseClient` owns that.
 */
let openStreams = 0;

/**
 * How many streams this page holds open right now. A browser keeps about 6 HTTP/1.1 connections to one server for
 * all its requests, and each stream holds one for as long as it's open, so the terminal checks this before it adds
 * one (code/terminal/feed.ts).
 */
export function openStreamCount(): number {
  return openStreams;
}

export function createFetchSseConnect(fetchImpl: typeof fetch = (...args) => fetch(...args)): SseConnect {
  return (url, handlers) => {
    const controller = new AbortController();
    let done = false;
    let counted = true;
    openStreams++;
    const release = (): void => {
      if (!counted) return;
      counted = false;
      openStreams--;
    };
    const fail = () => {
      release();
      if (done || controller.signal.aborted) return;
      done = true;
      handlers.onError();
    };

    void (async () => {
      try {
        const res = await fetchImpl(url, {
          headers: { Accept: 'text/event-stream', ...authHeaders() },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 401) reportUnauthorized();
          fail();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { value, done: ended } = await reader.read();
          if (ended) break;
          for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
            if (controller.signal.aborted) return;
            handlers.onEvent(ev.event, ev.data);
          }
        }
        fail(); // the server closed the stream
      } catch {
        fail();
      }
    })();

    return {
      close() {
        done = true;
        release();
        controller.abort();
      },
    };
  };
}

/**
 * `H` is what the stream's `hello` carries and `E` each event. The defaults
 * are one chat's turn stream; `GET /api/events` uses the same client with
 * its own types (useAppEvents.ts).
 */
export interface SseClientOptions<H = HelloBuffer[], E = TurnEvent> {
  url: string;
  onHello: (hello: H) => void;
  onEvent: (event: E) => void;
  /** Picks `H` out of the parsed `hello` payload. Defaults to the chat stream's `inFlight` array. */
  readHello?: (payload: unknown) => H;
  onStatusChange?: (status: StreamConnectionStatus) => void;
  /** Injectable for tests; defaults to a `fetch`-based stream carrying the transport's auth header. */
  connect?: SseConnect;
  /** Injectable for tests; defaults to `[500, 1000, 2000, 5000, 10000, 15000]`. */
  backoffScheduleMs?: number[];
}

/**
 * Owns one chat's `GET /api/chats/:id/stream` connection. On any error it
 * drops the connection and schedules a fresh one after an exponentially
 * growing delay, so a server restart or a flaky network doesn't hammer the
 * endpoint. Every reconnect's `hello` event carries a fresh replay
 * snapshot, which `onHello` (wired to `useOtherBenchStore.applyHello`) reconciles
 * without duplicating anything already applied live -- see reducer.ts.
 */
export class SseClient<H = HelloBuffer[], E = TurnEvent> {
  private readonly opts: SseClientOptions<H, E>;
  private conn: SseConnection | null = null;
  private attempt = 0;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SseClientOptions<H, E>) {
    this.opts = opts;
  }

  connect(): void {
    this.closed = false;
    this.attempt = 0;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.conn?.close();
    this.conn = null;
  }

  private open(): void {
    const connect = this.opts.connect ?? createFetchSseConnect();
    // Always 'connecting' here, whether this is the first attempt or a
    // retry -- 'reconnecting' (below, in scheduleReconnect) means "waiting
    // out the backoff delay", a distinct state a UI indicator cares about.
    this.opts.onStatusChange?.('connecting');

    const conn = connect(this.opts.url, {
      onEvent: (type, data) => {
        if (type === 'hello') {
          this.attempt = 0; // a successful connect resets the backoff schedule
          this.opts.onStatusChange?.('open');
          const parsed = this.parse<unknown>(data);
          if (parsed) {
            const read = this.opts.readHello ?? ((payload: unknown) => (payload as { inFlight: HelloBuffer[] }).inFlight as H);
            this.opts.onHello(read(parsed));
          }
        } else if (type === 'message') {
          // The registry's per-event sends (routes/turns.ts: `sink.send(null, event)`)
          // omit `event:`, which SSE treats as the default `message` type.
          const event = this.parse<E>(data);
          if (event) this.opts.onEvent(event);
        }
      },
      onError: () => {
        if (this.closed) return;
        conn.close();
        this.scheduleReconnect();
      },
    });
    this.conn = conn;
  }

  private parse<T>(data: string): T | null {
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      console.error('[otherbench-web] failed to parse SSE payload:', err);
      return null;
    }
  }

  private scheduleReconnect(): void {
    const schedule = this.opts.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
    const delay = schedule[Math.min(this.attempt, schedule.length - 1)] ?? schedule.at(-1) ?? 15000;
    this.attempt += 1;
    this.opts.onStatusChange?.('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.open();
    }, delay);
  }
}
