import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { LivePool, LiveProcess, PromptQueue } from '../src/live.js';

/** A fake Claude Code output the test pushes messages into. */
function output() {
  const queued: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queued.length > 0) yield queued.shift()!;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
    interrupt: async () => undefined,
    stopTask: async () => undefined,
  };
  return {
    stream,
    emit: (m: object) => {
      queued.push(m as SDKMessage);
      wake?.();
    },
    end: () => {
      done = true;
      wake?.();
    },
  };
}

const text = (t: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const result = (uuids?: string[]) => ({ type: 'result', subtype: 'success', is_error: false, usage: {}, ...(uuids ? { user_message_uuids: uuids } : {}) });
const tick = () => new Promise((r) => setTimeout(r, 0));

function process(out = output()) {
  const live = new LiveProcess('key', new PromptQueue(), new AbortController(), out.stream);
  const idle: SDKMessage[] = [];
  live.onIdle = (m) => idle.push(m);
  return { live, out, idle };
}

async function take(feed: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const got: SDKMessage[] = [];
  for await (const m of feed) got.push(m);
  return got;
}

describe('LiveProcess', () => {
  it("hands the attached reply its turn up to its own result, and what comes after to idle handling", async () => {
    const { live, out, idle } = process();
    const feed = live.attach('u1');
    out.emit(text('one'));
    out.emit(result(['u1']));
    out.emit(text('stray'));
    const got = await take(feed);
    await tick();
    expect(got.map((m) => (m as { type: string }).type)).toEqual(['stream_event', 'result']);
    expect(idle).toEqual([text('stray')]);
  });

  it("doesn't end the reply on a result for another message", async () => {
    const { live, out, idle } = process();
    const feed = live.attach('u1');
    out.emit(result(['someone-else']));
    out.emit(text('mine'));
    out.emit(result(['u1']));
    const got = await take(feed);
    expect(got).toEqual([text('mine'), result(['u1'])]);
    expect(idle).toEqual([result(['someone-else'])]);
  });

  it('ends a reply on a result that names no message (an older Claude Code)', async () => {
    const { live, out } = process();
    const feed = live.attach('u1');
    out.emit(result());
    expect(await take(feed)).toEqual([result()]);
  });

  it('is free once the attached reply has its result', async () => {
    const { live, out } = process();
    void take(live.attach('u1'));
    let free = false;
    void live.whenFree().then(() => (free = true));
    await tick();
    expect(free).toBe(false);
    out.emit(result(['u1']));
    await tick();
    expect(free).toBe(true);
  });

  it('ends the attached feed when the output ends', async () => {
    const { live, out } = process();
    const feed = live.attach('u1');
    out.emit(text('half'));
    out.end();
    expect(await take(feed)).toEqual([text('half')]);
  });

  it("doesn't end a user's reply on the result of a turn Claude Code ran by itself", async () => {
    const { live, out, idle } = process();
    const feed = live.attach('u1');
    const selfResult = { type: 'result', subtype: 'success', is_error: false, usage: {}, user_message_uuids: [], origin: { kind: 'task-notification' } };
    out.emit(selfResult);
    out.emit(text('mine'));
    out.emit(result(['u1']));
    expect(await take(feed)).toEqual([text('mine'), result(['u1'])]);
    expect(idle).toEqual([selfResult]);
  });

  it('ends a self-started turn on its own result', async () => {
    const { live, out } = process();
    const feed = live.attach('self-1');
    const selfResult = { type: 'result', subtype: 'success', is_error: false, usage: {}, user_message_uuids: [], origin: { kind: 'task-notification' } };
    out.emit(text('carried on'));
    out.emit(selfResult);
    expect(await take(feed)).toEqual([text('carried on'), selfResult]);
  });
});

describe('LivePool.takeWhenFree', () => {
  it("waits for a process that's busy with a turn before handing it out", async () => {
    const pool = new LivePool(60_000, 3);
    const { live, out } = process();
    live.sessionId = 's1';
    pool.release(live);
    void take(live.attach('self-started'));
    let taken: LiveProcess | null | undefined;
    void pool.takeWhenFree('s1', 'key').then((p) => (taken = p));
    await tick();
    expect(taken).toBeUndefined();
    out.emit(result(['self-started']));
    await tick();
    await tick();
    expect(taken).toBe(live);
  });
});

describe('LivePool.makeRoom', () => {
  it('never closes a process that is running a turn, even the longest idle one', async () => {
    const pool = new LivePool(60_000, 1);
    const busy = process();
    busy.live.sessionId = 's1';
    busy.live.lastUsed = 0;
    pool.release(busy.live);
    void take(busy.live.attach('self-started'));
    const other = process();
    other.live.sessionId = 's2';
    pool.release(other.live);
    expect(busy.live.isClosed).toBe(false);
  });
});
