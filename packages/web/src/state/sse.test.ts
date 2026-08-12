import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SseClient } from './sse.js';

type Listener = (ev: Event) => void;

/** A minimal, fully hand-controlled EventSource double: no real network, no jsdom EventSource dependency. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emitHello(payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as MessageEvent<string>;
    for (const cb of this.listeners.get('hello') ?? []) cb(event);
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  emitError(): void {
    this.onerror?.();
  }
}

describe('SseClient', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches a parsed hello payload to onHello and reports status open', () => {
    const onHello = vi.fn();
    const statuses: string[] = [];
    const client = new SseClient({
      url: '/api/chats/c1/stream',
      onHello,
      onEvent: vi.fn(),
      onStatusChange: (s) => statuses.push(s),
      EventSourceImpl: FakeEventSource as unknown as new (url: string) => EventSource,
    });

    client.connect();
    expect(statuses).toEqual(['connecting']);

    const es = FakeEventSource.instances[0]!;
    es.emitHello({ inFlight: [{ messageId: 'm1', status: 'streaming', events: [] }] });

    expect(onHello).toHaveBeenCalledWith([{ messageId: 'm1', status: 'streaming', events: [] }]);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('dispatches a parsed default-event TurnEvent to onEvent', () => {
    const onEvent = vi.fn();
    const client = new SseClient({
      url: '/api/chats/c1/stream',
      onHello: vi.fn(),
      onEvent,
      EventSourceImpl: FakeEventSource as unknown as new (url: string) => EventSource,
    });
    client.connect();

    const es = FakeEventSource.instances[0]!;
    es.emitMessage({ messageId: 'm1', type: 'text-delta', text: 'hi' });

    expect(onEvent).toHaveBeenCalledWith({ messageId: 'm1', type: 'text-delta', text: 'hi' });
  });

  it('reconnects after an error using the injected backoff schedule, growing each attempt', () => {
    const statuses: string[] = [];
    const client = new SseClient({
      url: '/api/chats/c1/stream',
      onHello: vi.fn(),
      onEvent: vi.fn(),
      onStatusChange: (s) => statuses.push(s),
      EventSourceImpl: FakeEventSource as unknown as new (url: string) => EventSource,
      backoffScheduleMs: [100, 300],
    });
    client.connect();
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0]!.emitError();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1); // not reconnected yet -- waiting out the backoff

    vi.advanceTimersByTime(99);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2); // first retry after 100ms

    FakeEventSource.instances[1]!.emitError();
    vi.advanceTimersByTime(300);
    expect(FakeEventSource.instances).toHaveLength(3); // second retry after the next schedule entry (300ms)

    // One 'reconnecting' (waiting out the backoff) per error, distinct from
    // 'connecting' (actively attempting), which fires once per open().
    expect(statuses.filter((s) => s === 'reconnecting')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'connecting')).toHaveLength(3);
  });

  it('resets the backoff attempt counter after a successful hello', () => {
    const client = new SseClient({
      url: '/api/chats/c1/stream',
      onHello: vi.fn(),
      onEvent: vi.fn(),
      EventSourceImpl: FakeEventSource as unknown as new (url: string) => EventSource,
      backoffScheduleMs: [100, 9999],
    });
    client.connect();
    FakeEventSource.instances[0]!.emitError();
    vi.advanceTimersByTime(100);
    expect(FakeEventSource.instances).toHaveLength(2);

    // A successful hello on the second connection resets attempt to 0, so
    // the NEXT error waits out schedule[0] (100ms) again, not schedule[1].
    FakeEventSource.instances[1]!.emitHello({ inFlight: [] });
    FakeEventSource.instances[1]!.emitError();
    vi.advanceTimersByTime(100);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('close() cancels a pending reconnect and stops further attempts', () => {
    const client = new SseClient({
      url: '/api/chats/c1/stream',
      onHello: vi.fn(),
      onEvent: vi.fn(),
      EventSourceImpl: FakeEventSource as unknown as new (url: string) => EventSource,
      backoffScheduleMs: [100],
    });
    client.connect();
    FakeEventSource.instances[0]!.emitError();

    client.close();
    vi.advanceTimersByTime(10_000);

    expect(FakeEventSource.instances).toHaveLength(1); // never reconnected after close()
  });
});
