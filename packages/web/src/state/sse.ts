import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { HelloBuffer, StreamConnectionStatus } from './store.js';

/** Backoff schedule (ms) between reconnect attempts; the last value repeats once exhausted. */
const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 15000];

export interface SseClientOptions {
  url: string;
  onHello: (buffers: HelloBuffer[]) => void;
  onEvent: (event: TurnEvent) => void;
  onStatusChange?: (status: StreamConnectionStatus) => void;
  /** Injectable for tests; defaults to the global `EventSource`. */
  EventSourceImpl?: new (url: string) => EventSource;
  /** Injectable for tests; defaults to `[500, 1000, 2000, 5000, 10000, 15000]`. */
  backoffScheduleMs?: number[];
}

/**
 * Owns one chat's `GET /api/chats/:id/stream` connection. The browser's
 * native `EventSource` already auto-reconnects, but on its own fixed
 * ~3s cadence with no cap growth and no way to observe attempts -- this
 * wrapper takes manual control instead: on any error it closes the socket
 * itself and schedules a fresh `EventSource` after an exponentially growing
 * delay, so a server restart or a flaky network doesn't hammer the
 * endpoint. Every reconnect's `hello` event carries a fresh replay
 * snapshot, which `onHello` (wired to `useGruntStore.applyHello`) reconciles
 * without duplicating anything already applied live -- see reducer.ts.
 */
export class SseClient {
  private readonly opts: SseClientOptions;
  private es: EventSource | null = null;
  private attempt = 0;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SseClientOptions) {
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
    this.es?.close();
    this.es = null;
  }

  private open(): void {
    const Impl = this.opts.EventSourceImpl ?? EventSource;
    // Always 'connecting' here, whether this is the first attempt or a
    // retry -- 'reconnecting' (below, in scheduleReconnect) means "waiting
    // out the backoff delay", a distinct state a UI indicator cares about.
    this.opts.onStatusChange?.('connecting');

    const es = new Impl(this.opts.url);
    this.es = es;

    es.addEventListener('hello', (ev: Event) => {
      this.attempt = 0; // a successful connect resets the backoff schedule
      this.opts.onStatusChange?.('open');
      const data = this.parse<{ inFlight: HelloBuffer[] }>(ev);
      if (data) this.opts.onHello(data.inFlight);
    });

    // The registry's per-event sends (routes/turns.ts: `sink.send(null, event)`)
    // omit `event:`, which SSE treats as the default `message` type.
    es.onmessage = (ev: MessageEvent<string>) => {
      const event = this.parse<TurnEvent>(ev);
      if (event) this.opts.onEvent(event);
    };

    es.onerror = () => {
      if (this.closed) return;
      es.close();
      this.scheduleReconnect();
    };
  }

  private parse<T>(ev: Event): T | null {
    const data = (ev as MessageEvent<string>).data;
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      console.error('[grunt-web] failed to parse SSE payload:', err);
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
