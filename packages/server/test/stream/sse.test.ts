import { describe, it, expect, vi } from 'vitest';
import { sseStream } from '../../src/stream/sse.js';

/**
 * Reads every chunk already enqueued on the stream, decoded to text. Each
 * `sink.send()` call is its own `controller.enqueue()`, i.e. its own chunk
 * -- one `reader.read()` only dequeues one, so this loops until no further
 * chunk arrives within a short window (the stream never closes on its own,
 * so `done` alone can't signal "no more for now").
 */
async function readAvailable(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const outcome = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    if (outcome === 'timeout') break;
    const { value, done } = outcome;
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();
  return text;
}

describe('sseStream', () => {
  it('sets the standard SSE response headers', () => {
    const response = sseStream(() => () => {});

    expect(response.headers.get('Content-Type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('Cache-Control')).toMatch(/no-cache/);
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });

  it('formats an unnamed event as a plain data: line', async () => {
    const response = sseStream((sink) => {
      sink.send(null, { type: 'text-delta', text: 'hi' });
      return () => {};
    });

    const text = await readAvailable(response);
    expect(text).toBe('data: {"type":"text-delta","text":"hi"}\n\n');
  });

  it('formats a named event with an event: line before data:', async () => {
    const response = sseStream((sink) => {
      sink.send('hello', { inFlight: [] });
      return () => {};
    });

    const text = await readAvailable(response);
    expect(text).toBe('event: hello\ndata: {"inFlight":[]}\n\n');
  });

  it('writes multiple sends as separate SSE records in order', async () => {
    const response = sseStream((sink) => {
      sink.send(null, { n: 1 });
      sink.send(null, { n: 2 });
      return () => {};
    });

    const text = await readAvailable(response);
    expect(text).toBe('data: {"n":1}\n\ndata: {"n":2}\n\n');
  });

  it('runs the cleanup function returned by setup() when the stream is cancelled', async () => {
    const cleanup = vi.fn();
    const response = sseStream((sink) => {
      sink.send(null, { ok: true });
      return cleanup;
    });

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
