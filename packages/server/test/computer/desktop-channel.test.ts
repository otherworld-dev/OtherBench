import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TOOL_IMAGE_BYTES } from '@grunt/core/domain/tool-images.js';
import {
  DesktopChannel,
  DesktopChannelError,
  LATE_GRACE_MS,
  MAX_EVENTS_PER_SECOND,
  MAX_LATE_NOTES,
  MAX_PENDING_CALLS,
  MAX_PRIORITY_CALLS,
  MAX_RPC_LINE_BYTES,
  RPC_PREFIX,
} from '../../src/computer/desktop-channel.js';
import { exitOnStdinClose } from '../../src/desktop.js';

/**
 * The channel against in-memory pipes only: `fromShell` stands in for this
 * server's stdin and `sent` collects what it would write to its stdout.
 * Nothing here starts a shell.
 */
function pipes() {
  const fromShell = new PassThrough();
  const sent: string[] = [];
  const toShell = { write: (s: string) => sent.push(s) };
  return { fromShell, sent, toShell };
}

const reply = (fromShell: PassThrough, body: unknown) => fromShell.write(`${RPC_PREFIX}${JSON.stringify(body)}\n`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The failure a call rejected with. */
async function failure(call: Promise<unknown>): Promise<DesktopChannelError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(DesktopChannelError);
  return err as DesktopChannelError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DesktopChannel', () => {
  it('sends each request as one prefixed line with its own id and resolves each with its own answer', async () => {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const target = channel.call('computer.target', { chatId: 'c', x: 1, y: 2 });
    const hello = channel.call('computer.hello', {});
    expect(sent).toEqual([
      'GRUNT-RPC {"id":1,"method":"computer.target","params":{"chatId":"c","x":1,"y":2}}\n',
      'GRUNT-RPC {"id":2,"method":"computer.hello","params":{}}\n',
    ]);
    reply(fromShell, { id: 2, result: { platform: 'win32' } });
    reply(fromShell, { id: 1, result: { refuse: 'Take a screenshot first.' } });
    expect(await hello).toEqual({ platform: 'win32' });
    expect(await target).toEqual({ refuse: 'Take a screenshot first.' });
    expect(channel.pendingCalls).toBe(0);
  });

  it("rejects with the shell's error message as one bounded clean line", async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const plain = channel.call('computer.act', {});
    reply(fromShell, { id: 1, error: { message: 'Computer use is off in this Grunt desktop app.' } });
    const first = await failure(plain);
    expect(first.kind).toBe('shell');
    expect(first.message).toBe('Computer use is off in this Grunt desktop app.');

    const long = channel.call('computer.act', {});
    reply(fromShell, { id: 2, error: { message: `line one\nline two\u202e ${'x'.repeat(5000)}` } });
    const second = await failure(long);
    expect(second.message.startsWith('line one line two x')).toBe(true);
    expect(second.message).not.toMatch(/[\n\u202e]/);
    expect(Array.from(second.message).length).toBeLessThanOrEqual(301);

    // An error with no readable message is still an error, in the channel's own words.
    for (const [id, error] of [
      [3, { message: 42 }],
      [4, {}],
      [5, { message: '' }],
    ] as const) {
      const call = channel.call('computer.act', {});
      reply(fromShell, { id, error });
      const err = await failure(call);
      expect(err.kind).toBe('shell');
      expect(err.message).toBe('The desktop app refused the request.');
      expect(err.code).toBeUndefined();
    }
    expect(channel.closed).toBe(false);
  });

  it("passes on the error's code when it is one plain word, and nothing else of it", async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    let id = 0;
    for (const [code, kept] of [
      ['no-session', 'no-session'],
      ['busy', 'busy'],
      ['No-Session', undefined],
      ['no session', undefined],
      ['x'.repeat(33), undefined],
      [7, undefined],
      ['', undefined],
    ] as const) {
      id += 1;
      const call = channel.call('computer.act', {});
      reply(fromShell, { id, error: { message: 'Not this session.', code } });
      const err = await failure(call);
      expect(err.message).toBe('Not this session.');
      expect(err.code).toBe(kept);
    }
  });

  it('delivers events to their listeners, and to nobody once they unsubscribe', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const heard = vi.fn();
    const off = channel.onEvent('computer.stopped', heard);
    reply(fromShell, { event: 'computer.stopped', params: { chatId: 'c', why: 'hotkey' } });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith({ chatId: 'c', why: 'hotkey' }));
    off();
    reply(fromShell, { event: 'computer.stopped', params: { chatId: 'd', why: 'idle' } });
    await tick();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('ignores an event nobody listens for, and a listener that throws stops neither the others nor the reader', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    channel.onEvent('computer.stopped', () => {
      throw new Error('listener bug');
    });
    channel.onEvent('computer.stopped', second);
    reply(fromShell, { event: 'computer.made-up', params: { chatId: 'c' } });
    reply(fromShell, { event: '__proto__', params: {} });
    reply(fromShell, { event: 'computer.stopped', params: { chatId: 'c' } });
    const call = channel.call('computer.hello', {});
    reply(fromShell, { id: 1, result: 'still reading' });
    expect(await call).toBe('still reading');
    expect(second).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toBe('[grunt-server] a desktop event listener for computer.stopped threw:');
  });

  it('ignores lines that are not GRUNT-RPC lines: without the prefix, or shorter than it', async () => {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const call = channel.call('computer.hello', {});
    fromShell.write('some library logged this\n');
    fromShell.write('{"id":1,"result":"no prefix"}\n');
    fromShell.write('grunt-rpc {"id":1,"result":"another case"}\n');
    fromShell.write(' GRUNT-RPC {"id":1,"result":"a space first"}\n');
    fromShell.write('GRUNT-RPC\n');
    fromShell.write('GRUNT-RPC\r\n');
    fromShell.write('\n');
    await tick();
    expect(channel.closed).toBe(false);
    expect(channel.pendingCalls).toBe(1);
    reply(fromShell, { id: 1, result: 'ok' });
    expect(await call).toBe('ok');
    expect(sent).toHaveLength(1);
  });

  /** A channel with one call waiting, fed one line from the shell: what came of it. */
  async function afterLine(line: string, setup?: (channel: DesktopChannel, fromShell: PassThrough) => Promise<void>) {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell, { nonce: 'abc123' });
    const closed = vi.fn();
    channel.onClose(closed);
    await setup?.(channel, fromShell);
    const waiting = channel.call('computer.act', {});
    waiting.catch(() => {});
    const before = sent.length;
    fromShell.write(line);
    await tick();
    return { channel, waiting, closed, written: sent.slice(before) };
  }

  it('closes on a GRUNT-RPC frame it cannot read: everything waiting is rejected, the shell is told, nothing more is sent', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const frames = [
      'GRUNT-RPC {not json\n',
      'GRUNT-RPC \n',
      'GRUNT-RPC null\n',
      'GRUNT-RPC 1\n',
      'GRUNT-RPC "id"\n',
      'GRUNT-RPC [{"id":1,"result":"in an array"}]\n',
      'GRUNT-RPC {}\n',
      'GRUNT-RPC {"result":"no id"}\n',
      'GRUNT-RPC {"id":1}\n',
      'GRUNT-RPC {"id":1,"result":"both","error":{"message":"no"}}\n',
      'GRUNT-RPC {"id":1,"error":"not an object"}\n',
      'GRUNT-RPC {"id":1,"error":null}\n',
      'GRUNT-RPC {"id":1,"error":["x"]}\n',
      ...[0, -1, 1.5, '"1"', 'null', 'true', '[1]', '{"id":1}', '1e400'].map((id) => `GRUNT-RPC {"id":${id},"result":"wrong"}\n`),
      'GRUNT-RPC {"event":7,"params":{}}\n',
      'GRUNT-RPC {"event":"","params":{}}\n',
      `GRUNT-RPC {"event":"${'e'.repeat(65)}","params":{}}\n`,
      'GRUNT-RPC {"event":"computer.stopped","id":1,"params":{}}\n',
    ];
    for (const line of frames) {
      const { channel, waiting, closed, written } = await afterLine(line);
      expect(channel.closed, line).toBe(true);
      expect((await failure(waiting)).kind, line).toBe('gone');
      expect(closed, line).toHaveBeenCalledTimes(1);
      // The last line to the shell: close, with this launch's word, and nothing after it.
      expect(written, line).toEqual(['GRUNT-RPC abc123 {"method":"computer.close","params":{}}\n']);
      expect((await failure(channel.call('computer.end', {}, { priority: true }))).kind).toBe('not-sent');
    }
    // One clean line in the log each time, in this file's words; nothing the shell sent.
    expect(logged).toHaveBeenCalledTimes(frames.length);
    for (const call of logged.mock.calls) expect(String(call[0])).toMatch(/^\[grunt-server\] closed the channel to the desktop app: [A-Za-z ]+\.$/);
  });

  it('closes on an answer to no request: never sent, already answered, or given up on so long ago it is forgotten', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Never sent.
    expect((await afterLine('GRUNT-RPC {"id":2,"result":"wrong"}\n')).channel.closed).toBe(true);
    expect((await afterLine('GRUNT-RPC {"id":99,"error":{"message":"wrong"}}\n')).channel.closed).toBe(true);
    // Answered already: a duplicate is the ends out of step.
    const twice = await afterLine('GRUNT-RPC {"id":1,"result":"second"}\n', async (channel, fromShell) => {
      const first = channel.call('computer.hello', {});
      reply(fromShell, { id: 1, result: 'first' });
      expect(await first).toBe('first');
    });
    // The call still waiting (id 2) is not given the duplicate: the channel closes under it.
    expect(twice.channel.closed).toBe(true);
    expect((await failure(twice.waiting)).kind).toBe('gone');
    // Given up on, and its note is gone.
    const forgotten = await afterLine('GRUNT-RPC {"id":1,"result":"very late"}\n', async (channel) => {
      await failure(channel.call('computer.hello', {}, { timeoutMs: 1, late: { forMs: 1, answer: () => {} } }));
      await vi.waitFor(() => expect(channel.lateNotes).toBe(0));
    });
    expect(forgotten.channel.closed).toBe(true);
  });

  it('times out a call nobody answers, frees its place, and ignores the answer when it comes late', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell, { timeoutMs: 20 });
    const err = await failure(channel.call('computer.hello', {}));
    expect(err.kind).toBe('timeout');
    expect(err.message).toBe("The desktop app didn't answer in time.");
    expect(channel.pendingCalls).toBe(0);
    // A note of it is kept for a while, so its answer is known for a late one, not taken for the ends out of step.
    expect(channel.lateNotes).toBe(1);
    reply(fromShell, { id: 1, result: 'late' });
    await tick();
    expect(channel.closed).toBe(false);
    expect(channel.lateNotes).toBe(0);
    expect(LATE_GRACE_MS).toBe(600_000);
    // A call's own limit wins over the channel's.
    const own = channel.call('computer.start', {}, 5000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(channel.pendingCalls).toBe(1);
    reply(fromShell, { id: 2, result: 'in time' });
    expect(await own).toBe('in time');
  });

  it("rejects every pending call, and any later one, when the shell's end closes", async () => {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const pending = channel.call('computer.start', {});
    const other = channel.call('computer.act', {});
    expect(channel.closed).toBe(false);
    fromShell.end();
    const first = await failure(pending);
    expect(first.kind).toBe('gone');
    expect(first.message).toBe('The desktop app went away.');
    expect((await failure(other)).kind).toBe('gone');
    expect(channel.closed).toBe(true);
    expect(channel.pendingCalls).toBe(0);
    const later = await failure(channel.call('computer.hello', {}));
    expect(later.kind).toBe('not-sent');
    expect(later.message).toBe('The desktop app went away.');
    // Nothing is written to a shell that is gone.
    expect(sent).toHaveLength(2);
  });

  it('counts a stream that errors or is destroyed as closed', async () => {
    for (const end of [(s: PassThrough) => s.destroy(), (s: PassThrough) => s.destroy(new Error('EPIPE'))]) {
      const { fromShell, toShell } = pipes();
      const channel = new DesktopChannel(fromShell, toShell);
      const pending = channel.call('computer.start', {});
      end(fromShell);
      expect((await failure(pending)).kind).toBe('gone');
      expect(channel.closed).toBe(true);
    }
  });

  it('holds at most a fixed number of calls waiting, and refuses the next without writing it', async () => {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell, { maxPending: 3 });
    const waiting = [channel.call('a', {}), channel.call('b', {}), channel.call('c', {})];
    const refused = await failure(channel.call('d', {}));
    expect(refused.kind).toBe('not-sent');
    expect(refused.message).toBe('The desktop app has too many requests waiting; nothing was sent.');
    expect(sent).toHaveLength(3);
    expect(channel.pendingCalls).toBe(3);
    // A place comes free when an answer arrives; ids are never reused.
    reply(fromShell, { id: 2, result: 'b' });
    expect(await waiting[1]).toBe('b');
    const next = channel.call('e', {});
    expect(sent[3]).toBe('GRUNT-RPC {"id":4,"method":"e","params":{}}\n');
    reply(fromShell, { id: 4, result: 'e' });
    expect(await next).toBe('e');
    expect(MAX_PENDING_CALLS).toBe(64);
    fromShell.end();
    await Promise.allSettled(waiting);
  });

  it('rejects cleanly when the write itself fails, and keeps nothing waiting for it', async () => {
    const { fromShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, {
      write: () => {
        throw new Error('EPIPE: broken pipe, write C:\\secret\\path');
      },
    });
    const err = await failure(channel.call('computer.hello', {}));
    expect(err.kind).toBe('not-sent');
    expect(err.message).toBe("The request couldn't be sent to the desktop app.");
    expect(channel.pendingCalls).toBe(0);
    // The cause goes to the server's own log, never to the caller.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toBe('[grunt-server] writing to the desktop app failed:');
  });

  it('refuses a request it cannot write as one line of JSON', async () => {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect((await failure(channel.call('computer.act', loop))).kind).toBe('not-sent');
    expect((await failure(channel.call('computer.act', { n: 1n }))).kind).toBe('not-sent');
    expect(sent).toEqual([]);
    expect(channel.pendingCalls).toBe(0);
  });

  it('reads a line that arrives in pieces, two lines in one piece, CRLF ends and split multi-byte characters', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const calls = [channel.call('a', {}), channel.call('b', {}), channel.call('c', {}), channel.call('d', {})];
    const first = `${RPC_PREFIX}${JSON.stringify({ id: 1, result: 'in pieces' })}\n`;
    fromShell.write(first.slice(0, 5));
    fromShell.write(first.slice(5, 17));
    await tick();
    fromShell.write(first.slice(17));
    fromShell.write(`${RPC_PREFIX}{"id":2,"result":"two"}\n${RPC_PREFIX}{"id":3,"result":"three"}\r\n`);
    const bytes = Buffer.from(`${RPC_PREFIX}${JSON.stringify({ id: 4, result: 'caf\u00e9 \u{1F5B1}' })}\n`, 'utf8');
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of the accented letter
    fromShell.write(bytes.subarray(0, cut));
    await tick();
    fromShell.write(bytes.subarray(cut, bytes.length - 6));
    fromShell.write(bytes.subarray(bytes.length - 6));
    expect(await Promise.all(calls)).toEqual(['in pieces', 'two', 'three', 'caf\u00e9 \u{1F5B1}']);
  });

  it('drops a line that was cut off when the stream ended', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const call = channel.call('computer.hello', {});
    fromShell.write(`${RPC_PREFIX}{"id":1,"result":"no line end"}`);
    fromShell.end();
    expect((await failure(call)).kind).toBe('gone');
  });

  it('never holds more of one line than its limit: a longer GRUNT-RPC line closes the channel as it arrives', async () => {
    const { fromShell, sent, toShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell, { maxLineBytes: 64, timeoutMs: 5000 });
    const call = channel.call('computer.screenshot', {});
    call.catch(() => {});
    let most = 0;
    fromShell.write(`${RPC_PREFIX}{"id":1,"result":"`);
    for (let i = 0; i < 200; i += 1) {
      fromShell.write('A'.repeat(50));
      await tick();
      most = Math.max(most, channel.bufferedBytes);
    }
    expect(most).toBeLessThanOrEqual(64);
    expect(channel.bufferedBytes).toBe(0);
    expect(channel.closed).toBe(true);
    expect((await failure(call)).kind).toBe('gone');
    // Nothing that comes after is read: not the end of the long line, not a whole answer.
    fromShell.write(`"}\n${RPC_PREFIX}{"id":1,"result":"smuggled"}\n`);
    await tick();
    expect(channel.bufferedBytes).toBe(0);
    expect(sent.at(-1)).toBe('GRUNT-RPC {"method":"computer.close","params":{}}\n');
    expect(logged.mock.calls).toEqual([['[grunt-server] closed the channel to the desktop app: a line from it was longer than 64 bytes.']]);
  });

  it('a line of exactly the limit is read, one byte more closes the channel', async () => {
    const { fromShell, toShell } = pipes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const line = `${RPC_PREFIX}${JSON.stringify({ id: 1, result: 'x'.repeat(40) })}`;
    const channel = new DesktopChannel(fromShell, toShell, { maxLineBytes: Buffer.byteLength(line) });
    const call = channel.call('a', {});
    const longer = channel.call('b', {});
    fromShell.write(`${line}\n`);
    expect(await call).toBe('x'.repeat(40));
    expect(channel.closed).toBe(false);
    fromShell.write(`${RPC_PREFIX}${JSON.stringify({ id: 2, result: 'x'.repeat(41) })}\n`);
    expect((await failure(longer)).kind).toBe('gone');
    expect(channel.closed).toBe(true);
  });

  it('by default lets through the largest screenshot the app keeps, as base64, and little more', () => {
    const largestPng = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4;
    expect(MAX_RPC_LINE_BYTES).toBe(largestPng + 65536);
    expect(MAX_RPC_LINE_BYTES).toBeLessThan(8 * 1024 * 1024);
  });

  it('knows a line that is not a GRUNT-RPC line by its first bytes and holds none of it, however long it is', async () => {
    const { fromShell, toShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell);
    const call = channel.call('computer.hello', {});
    let most = 0;
    for (const start of ['some library logged this, at length: ', 'GRUNT-RPX {"id":1,"result":"near miss"}', 'GRUNT-RP', '{"id":1,"result":"no prefix"}']) {
      fromShell.write(start);
      for (let i = 0; i < 50; i += 1) {
        fromShell.write('Z'.repeat(100_000));
        await tick();
        most = Math.max(most, channel.bufferedBytes);
      }
      fromShell.write(`${RPC_PREFIX}{"id":1,"result":"still part of that line"}\n`);
      await tick();
    }
    // Never more than the prefix's own length is held of such a line, and it is not taken for an RPC line that is too long.
    expect(most).toBeLessThanOrEqual(RPC_PREFIX.length);
    expect(channel.closed).toBe(false);
    expect(logged).not.toHaveBeenCalled();
    expect(channel.pendingCalls).toBe(1);
    reply(fromShell, { id: 1, result: 'the real answer' });
    expect(await call).toBe('the real answer');
  });

  it('lets an end of session through when every ordinary place is taken, up to a limit of its own', async () => {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell, { maxPending: 2, maxPriority: 2 });
    const waiting = [channel.call('computer.act', {}), channel.call('computer.act', {})];
    expect((await failure(channel.call('computer.act', {}))).kind).toBe('not-sent');
    const end = channel.call('computer.end', { chatId: 'c' }, { priority: true });
    expect(sent.at(-1)).toBe('GRUNT-RPC {"id":3,"method":"computer.end","params":{"chatId":"c"}}\n');
    reply(fromShell, { id: 3, result: { ok: true } });
    expect(await end).toEqual({ ok: true });
    // Ends do not use up the ordinary places, and the ordinary ones do not use up theirs.
    const ends = [channel.call('computer.end', {}, { priority: true }), channel.call('computer.end', {}, { priority: true })];
    const refused = await failure(channel.call('computer.end', {}, { priority: true }));
    expect(refused.kind).toBe('not-sent');
    expect(sent).toHaveLength(5);
    expect(channel.pendingCalls).toBe(4);
    expect(MAX_PRIORITY_CALLS).toBe(64);
    fromShell.end();
    await Promise.allSettled([...waiting, ...ends]);
  });

  it('a call that asked to be told of a late answer frees its place at its limit and is told once, within the time it gave', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const late = vi.fn();
    const call = channel.call('computer.start', {}, { timeoutMs: 20, late: { forMs: 5000, answer: late } });
    expect((await failure(call)).kind).toBe('timeout');
    // Its place among the waiting is free at once; only a note is kept.
    expect(channel.pendingCalls).toBe(0);
    expect(channel.lateNotes).toBe(1);
    reply(fromShell, { id: 1, result: { ok: true } });
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith({ ok: true }));
    expect(channel.lateNotes).toBe(0);
    expect(late).toHaveBeenCalledTimes(1);

    // A late error is the shell saying no: nobody needs telling. A note is gone after its time.
    const refusedLate = vi.fn();
    await failure(channel.call('computer.start', {}, { timeoutMs: 20, late: { forMs: 5000, answer: refusedLate } }));
    reply(fromShell, { id: 2, error: { message: 'cancelled' } });
    await tick();
    expect(refusedLate).not.toHaveBeenCalled();
    expect(channel.lateNotes).toBe(0);
    const expired = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await failure(channel.call('computer.start', {}, { timeoutMs: 20, late: { forMs: 30, answer: expired } }));
    await vi.waitFor(() => expect(channel.lateNotes).toBe(0));
    expect(channel.closed).toBe(false);
    // An answer after the note has gone is an answer to nothing the channel knows of: the ends are out of step.
    reply(fromShell, { id: 3, result: { ok: true } });
    await tick();
    expect(expired).not.toHaveBeenCalled();
    expect(channel.closed).toBe(true);
  });

  it('a second answer to a late call is a duplicate, and closes the channel', async () => {
    const { fromShell, toShell } = pipes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell);
    const late = vi.fn();
    await failure(channel.call('computer.start', {}, { timeoutMs: 1, late: { forMs: 5000, answer: late } }));
    reply(fromShell, { id: 1, result: { ok: true } });
    await vi.waitFor(() => expect(late).toHaveBeenCalledTimes(1));
    reply(fromShell, { id: 1, result: { ok: true } });
    await tick();
    expect(late).toHaveBeenCalledTimes(1);
    expect(channel.closed).toBe(true);
  });

  it('keeps a fixed number of such notes (the oldest goes), and none once the shell has gone', async () => {
    const { fromShell, toShell } = pipes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell);
    const heard: number[] = [];
    for (let i = 1; i <= MAX_LATE_NOTES + 2; i += 1) {
      await failure(channel.call('computer.start', {}, { timeoutMs: 1, late: { forMs: 5000, answer: () => heard.push(i) } }));
    }
    expect(channel.lateNotes).toBe(MAX_LATE_NOTES);
    expect(MAX_LATE_NOTES).toBe(64);
    reply(fromShell, { id: 3, result: {} });
    await vi.waitFor(() => expect(heard).toEqual([3]));
    expect(channel.closed).toBe(false);
    // The oldest was forgotten: its answer now is one to nothing.
    reply(fromShell, { id: 1, result: {} });
    await vi.waitFor(() => expect(channel.closed).toBe(true));
    expect(heard).toEqual([3]);
    expect(channel.lateNotes).toBe(0);
  });

  it('closes on a flood of events: more than its limit in one second', async () => {
    const { fromShell, sent, toShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell, { maxEventsPerSecond: 5 });
    const heard = vi.fn();
    channel.onEvent('computer.shortcuts', heard);
    const waiting = channel.call('computer.act', {});
    waiting.catch(() => {});
    // Events of any name count, the ones nobody listens for too.
    fromShell.write(Array.from({ length: 5 }, (_, i) => `${RPC_PREFIX}{"event":"${i % 2 ? 'computer.shortcuts' : 'computer.unknown'}","params":{}}\n`).join(''));
    await tick();
    expect(channel.closed).toBe(false);
    reply(fromShell, { event: 'computer.shortcuts', params: {} });
    await tick();
    expect(channel.closed).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
    expect((await failure(waiting)).kind).toBe('gone');
    expect(sent.at(-1)).toBe('GRUNT-RPC {"method":"computer.close","params":{}}\n');
    expect(logged.mock.calls).toEqual([['[grunt-server] closed the channel to the desktop app: it sent more than 5 events in a second.']]);
    expect(MAX_EVENTS_PER_SECOND).toBe(100);
  });

  it('takes the limit per second: the same number again a second later is fine', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { fromShell, toShell } = pipes();
      const channel = new DesktopChannel(fromShell, toShell, { maxEventsPerSecond: 3 });
      for (let second = 0; second < 4; second += 1) {
        for (let i = 0; i < 3; i += 1) reply(fromShell, { event: 'computer.shortcuts', params: {} });
        await tick();
        vi.setSystemTime(Date.now() + 1000);
      }
      expect(channel.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells its close listeners once, whatever closed it, and a listener added after it closed at once', async () => {
    const { fromShell, toShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell);
    const first = vi.fn();
    const off = vi.fn();
    channel.onClose(() => {
      throw new Error('listener bug');
    });
    channel.onClose(first);
    channel.onClose(off)();
    fromShell.end();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    fromShell.destroy();
    await tick();
    expect(first).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
    expect(logged.mock.calls[0]![0]).toBe('[grunt-server] a desktop channel close listener threw:');
    const later = vi.fn();
    channel.onClose(later);
    await tick();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('a listener for a late answer that throws does not stop the reader', async () => {
    const { fromShell, toShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell);
    await failure(
      channel.call('computer.start', {}, {
        timeoutMs: 10,
        late: {
          forMs: 5000,
          answer: () => {
            throw new Error('listener bug');
          },
        },
      })
    );
    reply(fromShell, { id: 1, result: {} });
    const next = channel.call('computer.hello', {});
    reply(fromShell, { id: 2, result: 'still reading' });
    expect(await next).toBe('still reading');
    expect(logged.mock.calls[0]![0]).toBe('[grunt-server] handling a late answer from the desktop app failed:');
  });

  it("writes this launch's word after the prefix of every request when it has one", async () => {
    const { fromShell, sent, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell, { nonce: '0123456789abcdef0123456789abcdef' });
    const call = channel.call('computer.hello', {});
    expect(sent).toEqual(['GRUNT-RPC 0123456789abcdef0123456789abcdef {"id":1,"method":"computer.hello","params":{}}\n']);
    // The shell's own lines carry no such word: only the shell writes to this end.
    reply(fromShell, { id: 1, result: 'ok' });
    expect(await call).toBe('ok');
    expect(() => new DesktopChannel(fromShell, toShell, { nonce: 'has a space' })).toThrow('nonce');
    expect(() => new DesktopChannel(fromShell, toShell, { nonce: '' })).toThrow('nonce');
  });

  it('closes when the stream it writes to reports an error, instead of leaving it unhandled', async () => {
    const { fromShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = new PassThrough();
    const channel = new DesktopChannel(fromShell, out);
    const pending = channel.call('computer.act', {});
    // An EPIPE that comes later, as an event: with no listener this would take the process down.
    out.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect((await failure(pending)).kind).toBe('gone');
    expect(channel.closed).toBe(true);
    expect((await failure(channel.call('computer.end', {}, { priority: true }))).kind).toBe('not-sent');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toBe('[grunt-server] the pipe to the desktop app failed:');
  });

  it('leaves exitOnStdinClose working on the same stream', async () => {
    const { fromShell, toShell } = pipes();
    const onClose = vi.fn();
    exitOnStdinClose(fromShell, onClose);
    const channel = new DesktopChannel(fromShell, toShell);
    fromShell.end();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(channel.closed).toBe(true);
  });
});
