import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureTransport } from './transport.js';
import { createFetchSseConnect, SseClient, SseParser, type SseConnect, type SseHandlers } from './sse.js';

/** A minimal, fully hand-controlled stream double: no real network. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static connect: SseConnect = (url, handlers) => new FakeEventSource(url, handlers);
  readonly url: string;
  private readonly handlers: SseHandlers;
  closed = false;

  constructor(url: string, handlers: SseHandlers) {
    this.url = url;
    this.handlers = handlers;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emitHello(payload: unknown): void {
    this.handlers.onEvent('hello', JSON.stringify(payload));
  }

  emitMessage(payload: unknown): void {
    this.handlers.onEvent('message', JSON.stringify(payload));
  }

  emitError(): void {
    this.handlers.onError();
  }
}

describe('SseParser', () => {
  it('dispatches a default-type event on the blank line that ends it', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'message', data: '{"a":1}' }]);
  });

  it('honours event:, joins multi-line data with newlines, and handles CRLF', () => {
    const p = new SseParser();
    expect(p.push('event: hello\r\ndata: line1\r\ndata: line2\r\n\r\n')).toEqual([{ event: 'hello', data: 'line1\nline2' }]);
  });

  it('copes with a chunk boundary in the middle of a line', () => {
    const p = new SseParser();
    expect(p.push('data: {"te')).toEqual([]);
    expect(p.push('xt":"hi"}\n\n')).toEqual([{ event: 'message', data: '{"text":"hi"}' }]);
  });

  it('ignores comments (keepalives), id and retry fields, and empty events', () => {
    const p = new SseParser();
    expect(p.push(': keepalive\n\nid: 7\nretry: 100\n\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('strips exactly one space after the colon', () => {
    const p = new SseParser();
    expect(p.push('data:  two\ndata:none\n\n')).toEqual([{ event: 'message', data: ' two\nnone' }]);
  });

  it('resets the event type after each dispatch', () => {
    const p = new SseParser();
    expect(p.push('event: hello\ndata: a\n\ndata: b\n\n')).toEqual([
      { event: 'hello', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });
});

describe('createFetchSseConnect', () => {
  afterEach(() => configureTransport({ baseUrl: '', token: null }));

  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  async function flush() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it('sends the bearer token, parses events across chunks, then reports the end of the stream as an error', async () => {
    configureTransport({ baseUrl: 'http://127.0.0.1:5000', token: 'tok' });
    const fetchImpl = vi.fn(async () => new Response(streamOf(['event: hello\ndata: {"inFlight":[]}\n', '\ndata: {"x":1}\n\n'])));
    const events: Array<[string, string]> = [];
    const onError = vi.fn();

    createFetchSseConnect(fetchImpl)('http://127.0.0.1:5000/api/chats/c1/stream', {
      onEvent: (type, data) => events.push([type, data]),
      onError,
    });
    await flush();

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(events).toEqual([
      ['hello', '{"inFlight":[]}'],
      ['message', '{"x":1}'],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a non-2xx response as an error without dispatching anything', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const onEvent = vi.fn();
    const onError = vi.fn();

    createFetchSseConnect(fetchImpl)('/api/chats/c1/stream', { onEvent, onError });
    await flush();

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a network failure as an error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const onError = vi.fn();

    createFetchSseConnect(fetchImpl)('/api/chats/c1/stream', { onEvent: vi.fn(), onError });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('close() aborts the request and never reports an error afterwards', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const onError = vi.fn();

    const conn = createFetchSseConnect(fetchImpl as never)('/api/chats/c1/stream', { onEvent: vi.fn(), onError });
    conn.close();
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});

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
      connect: FakeEventSource.connect,
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
      connect: FakeEventSource.connect,
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
      connect: FakeEventSource.connect,
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
      connect: FakeEventSource.connect,
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
      connect: FakeEventSource.connect,
      backoffScheduleMs: [100],
    });
    client.connect();
    FakeEventSource.instances[0]!.emitError();

    client.close();
    vi.advanceTimersByTime(10_000);

    expect(FakeEventSource.instances).toHaveLength(1); // never reconnected after close()
  });
});
