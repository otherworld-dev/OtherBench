/**
 * A tiny, dependency-free SSE (Server-Sent Events) transport. Built on the
 * standard `ReadableStream`/`Response` rather than any Hono-specific
 * streaming helper, so it is trivially unit-testable (read the `Response`
 * body directly) and works unmodified whether the app is served over
 * `@hono/node-server` or exercised in-process via `app.request()`.
 */
/** How often an otherwise quiet stream sends a keepalive comment, so the other end can tell it's alive. */
export const STREAM_KEEPALIVE_MS = 25_000;
/**
 * How long a paired machine's stream may go without a byte (keepalives
 * included) before it's taken as lost: a connection that died without
 * closing (a laptop asleep, a network gone) may never be reported by TCP.
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Stream timings, shortened by tests. */
export interface StreamTimings {
  keepaliveMs: number;
  idleTimeoutMs: number;
}

export interface SseSink {
  /** Writes one SSE record. `event: <name>` is omitted for `event === null` (an unnamed/default event). */
  send(event: string | null, data: unknown): void;
  /** Writes an SSE comment line (`: text`), which clients ignore: a keepalive. */
  comment(text: string): void;
  /** Ends the stream from this side (the cleanup still runs, once). */
  close(): void;
}

/**
 * Builds a `text/event-stream` `Response`. `setup(sink)` runs synchronously
 * as soon as the stream starts (so anything it sends via `sink.send` before
 * returning is flushed immediately -- this is how a route composes an
 * initial `hello` reply-then-live sequence with no gap), and must return a
 * cleanup function that is called exactly once, when the stream is
 * cancelled (the client disconnected, or the consumer stopped reading) --
 * this is where a caller unsubscribes from whatever it subscribed to in
 * `setup`.
 */
export function sseStream(setup: (sink: SseSink) => () => void): Response {
  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};
  let cleaned = false;
  const runCleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink: SseSink = {
        send(event, data) {
          const lines: string[] = [];
          if (event !== null) lines.push(`event: ${event}`);
          // A multi-line JSON payload would break the SSE record format if
          // written as one `data:` line -- JSON.stringify never emits raw
          // newlines by default, but splitting defensively costs nothing
          // and keeps this correct if that ever changes.
          for (const line of JSON.stringify(data).split('\n')) {
            lines.push(`data: ${line}`);
          }
          lines.push('', '');
          controller.enqueue(encoder.encode(lines.join('\n')));
        },
        comment(text) {
          controller.enqueue(encoder.encode(`: ${text.replace(/\n/g, ' ')}\n\n`));
        },
        close() {
          runCleanup();
          try {
            controller.close();
          } catch {
            // already closed, or cancelled by the client
          }
        },
      };
      cleanup = setup(sink);
    },
    cancel() {
      runCleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering on nginx-fronted deployments so events
      // reach the client as they're written, not batched.
      'X-Accel-Buffering': 'no',
    },
  });
}
