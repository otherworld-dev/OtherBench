import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../state/api.js';
import { createFetchSseConnect, openStreamCount } from '../../state/sse.js';
import { openTerminalFeed, STREAM_BUDGET } from './feed.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openTerminalFeed', () => {
  it(`streams while the page holds fewer than ${STREAM_BUDGET} streams`, () => {
    const output = vi.spyOn(api.terminals, 'output');
    const feed = openTerminalFeed('a1', 't1', { onReset: () => {}, onOutput: () => {} }, { openStreams: () => STREAM_BUDGET - 1 });
    expect(feed.mode).toBe('stream');
    expect(output).not.toHaveBeenCalled();
    feed.close();
  });

  it('polls when the page has no connection to spare, from where it left off', async () => {
    const answers = [
      { data: 'PS> ', next: 4, reset: false, exitCode: null },
      { data: 'hi', next: 6, reset: false, exitCode: null },
      { data: '', next: 6, reset: false, exitCode: null },
      { data: 'all again', next: 99, reset: true, exitCode: null },
    ];
    const output = vi.spyOn(api.terminals, 'output').mockImplementation(async () => answers.shift() ?? { data: '', next: 99, reset: false, exitCode: null });
    const resets: string[] = [];
    const outputs: string[] = [];
    const feed = openTerminalFeed('a1', 't1', { onReset: (d) => resets.push(d), onOutput: (d) => outputs.push(d) }, { openStreams: () => STREAM_BUDGET });
    expect(feed.mode).toBe('poll');
    await vi.advanceTimersByTimeAsync(2000);
    expect(output.mock.calls.slice(0, 4).map((c) => c[2])).toEqual([0, 4, 6, 6]);
    // The first answer starts the screen; a reset starts it again.
    expect(resets).toEqual(['PS> ', 'all again']);
    expect(outputs).toEqual(['hi']);
    const calls = output.mock.calls.length;
    feed.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(output.mock.calls.length).toBe(calls);
  });

  it('streams in the desktop app however many streams are open: each has a host of its own there', () => {
    const output = vi.spyOn(api.terminals, 'output');
    const feed = openTerminalFeed('a1', 't1', { onReset: () => {}, onOutput: () => {} }, { openStreams: () => 20, sharedHost: () => false });
    expect(feed.mode).toBe('stream');
    expect(output).not.toHaveBeenCalled();
    feed.close();
  });

  it('counts the streams of other tabs too', () => {
    // Another tab holds events and 3 panes; this one holds its events stream.
    const feed = openTerminalFeed('a1', 't1', { onReset: () => {}, onOutput: () => {} }, { openStreams: () => 4 + 1, onStreamsChange: () => () => {} });
    expect(feed.mode).toBe('poll');
    feed.close();
  });

  // The page holds /api/events when the terminal opens, so it streams; then four chat panes open, one stream each.
  it('drops to polling when four chat panes open after it', async () => {
    vi.spyOn(api.terminals, 'output').mockResolvedValue({ data: 'PS> ', next: 4, reset: false, exitCode: null });
    const connect = createFetchSseConnect(() => new Promise<Response>(() => {}));
    const events = connect('/api/events', { onEvent: () => {}, onError: () => {} });
    expect(openStreamCount()).toBe(1);
    const resets: string[] = [];
    const feed = openTerminalFeed('a1', 't1', { onReset: (d) => resets.push(d), onOutput: () => {} });
    expect(feed.mode).toBe('stream');
    expect(openStreamCount()).toBe(2);
    const panes = [1, 2, 3].map((n) => connect(`/api/chats/c${n}/stream`, { onEvent: () => {}, onError: () => {} }));
    expect(feed.mode).toBe('stream'); // 5 held: one connection still free
    panes.push(connect('/api/chats/c4/stream', { onEvent: () => {}, onError: () => {} }));
    expect(feed.mode).toBe('poll');
    // Its own stream went back, so one connection is free for requests again.
    expect(openStreamCount()).toBe(STREAM_BUDGET);
    await vi.advanceTimersByTimeAsync(0);
    expect(resets).toEqual(['PS> ']);
    feed.close();
    for (const s of [events, ...panes]) s.close();
    expect(openStreamCount()).toBe(0);
  });
});
