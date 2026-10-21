import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../state/api.js';
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
});
