/**
 * A tiny, dependency-free SSE (Server-Sent Events) transport. Built on the
 * standard `ReadableStream`/`Response` rather than any Hono-specific
 * streaming helper, so it is trivially unit-testable (read the `Response`
 * body directly) and works unmodified whether the app is served over
 * `@hono/node-server` or exercised in-process via `app.request()`.
 */
export interface SseSink {
  /** Writes one SSE record. `event: <name>` is omitted for `event === null` (an unnamed/default event). */
  send(event: string | null, data: unknown): void;
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
      };
      cleanup = setup(sink);
    },
    cancel() {
      cleanup();
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
