import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TOOL_IMAGE_BYTES } from '@grunt/core/domain/tool-images.js';
import { DesktopChannel, DesktopChannelError, MAX_PENDING_CALLS, MAX_RPC_LINE_BYTES, RPC_PREFIX } from '../../src/computer/desktop-channel.js';
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
      [4, 'nope'],
      [5, {}],
      [6, { message: '' }],
    ] as const) {
      const call = channel.call('computer.act', {});
      reply(fromShell, { id, error });
      const err = await failure(call);
      expect(err.kind).toBe('shell');
      expect(err.message).toBe('The desktop app refused the request.');
    }
    // An error beside a result is an error.
    const both = channel.call('computer.act', {});
    reply(fromShell, { id: 7, result: { ok: true }, error: { message: 'no' } });
    expect((await failure(both)).message).toBe('no');
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

  it('ignores lines without the prefix, lines that are not JSON, and JSON that is not a message', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const call = channel.call('computer.hello', {});
    fromShell.write('some library logged this\n');
    fromShell.write('{"id":1,"result":"no prefix"}\n');
    fromShell.write('GRUNT-RPC {not json\n');
    fromShell.write('GRUNT-RPC null\n');
    fromShell.write('GRUNT-RPC 1\n');
    fromShell.write('GRUNT-RPC "id"\n');
    fromShell.write('GRUNT-RPC [{"id":1,"result":"in an array"}]\n');
    fromShell.write('GRUNT-RPC\n');
    fromShell.write('\n');
    await tick();
    expect(channel.pendingCalls).toBe(1);
    reply(fromShell, { id: 1, result: 'ok' });
    expect(await call).toBe('ok');
  });

  it('ignores an answer whose id is unknown, is not a whole number, or was already settled', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell);
    const call = channel.call('computer.hello', {});
    for (const id of [2, 0, -1, 1.5, '1', null, true, [1], { id: 1 }, 1e400]) reply(fromShell, { id, result: 'wrong' });
    fromShell.write('GRUNT-RPC {"result":"no id"}\n');
    await tick();
    expect(channel.pendingCalls).toBe(1);
    reply(fromShell, { id: 1, result: 'first' });
    // A second answer to the same id, and an error for it, change nothing.
    reply(fromShell, { id: 1, result: 'second' });
    reply(fromShell, { id: 1, error: { message: 'late' } });
    expect(await call).toBe('first');
    const next = channel.call('computer.hello', {});
    reply(fromShell, { id: 2, result: 'next' });
    expect(await next).toBe('next');
  });

  it('times out a call nobody answers, frees its place, and ignores the answer when it comes late', async () => {
    const { fromShell, toShell } = pipes();
    const channel = new DesktopChannel(fromShell, toShell, { timeoutMs: 20 });
    const err = await failure(channel.call('computer.hello', {}));
    expect(err.kind).toBe('timeout');
    expect(err.message).toBe("The desktop app didn't answer in time.");
    expect(channel.pendingCalls).toBe(0);
    reply(fromShell, { id: 1, result: 'late' });
    await tick();
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

  it('never holds more of one line than its limit: a longer line is dropped as it arrives and the next line is read', async () => {
    const { fromShell, toShell } = pipes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell, { maxLineBytes: 64, timeoutMs: 5000 });
    const call = channel.call('computer.screenshot', {});
    let most = 0;
    fromShell.write(`${RPC_PREFIX}{"id":1,"result":"`);
    for (let i = 0; i < 200; i += 1) {
      fromShell.write('A'.repeat(50));
      await tick();
      most = Math.max(most, channel.bufferedBytes);
    }
    expect(most).toBeLessThanOrEqual(64);
    expect(channel.bufferedBytes).toBe(0);
    // The end of the long line is not read as a message of its own.
    fromShell.write(`"}\n`);
    await tick();
    expect(channel.pendingCalls).toBe(1);
    expect(channel.droppedLines).toBe(1);
    reply(fromShell, { id: 1, result: 'short' });
    expect(await call).toBe('short');
    // One line in the log for the first one dropped, and it holds nothing the shell sent.
    fromShell.write(`${'B'.repeat(500)}\n`);
    await tick();
    expect(channel.droppedLines).toBe(2);
    expect(logged.mock.calls).toEqual([['[grunt-server] dropped a line from the desktop app that was longer than 64 bytes.']]);
  });

  it('reads nothing out of a line it has dropped, even when its end looks like a message', async () => {
    const { fromShell, toShell } = pipes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new DesktopChannel(fromShell, toShell, { maxLineBytes: 64, timeoutMs: 5000 });
    const call = channel.call('computer.act', {});
    // One long line whose last piece, arriving on its own, is a whole answer to the call that is waiting.
    fromShell.write('A'.repeat(64));
    fromShell.write('B');
    await tick();
    fromShell.write(`${RPC_PREFIX}{"id":1,"result":"smuggled"}\n`);
    await tick();
    expect(channel.pendingCalls).toBe(1);
    expect(channel.droppedLines).toBe(1);
    expect(channel.bufferedBytes).toBe(0);
    reply(fromShell, { id: 1, result: 'the real answer' });
    expect(await call).toBe('the real answer');
  });

  it('a line of exactly the limit is read, one byte more is not', async () => {
    const { fromShell, toShell } = pipes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const line = `${RPC_PREFIX}${JSON.stringify({ id: 1, result: 'x'.repeat(40) })}`;
    const channel = new DesktopChannel(fromShell, toShell, { maxLineBytes: Buffer.byteLength(line) });
    const call = channel.call('a', {});
    const longer = channel.call('b', {}, 30);
    fromShell.write(`${RPC_PREFIX}${JSON.stringify({ id: 2, result: 'x'.repeat(41) })}\n${line}\n`);
    expect(await call).toBe('x'.repeat(40));
    expect((await failure(longer)).kind).toBe('timeout');
    expect(channel.droppedLines).toBe(1);
  });

  it('by default lets through the largest screenshot the app keeps, as base64, and little more', () => {
    const largestPng = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4;
    expect(MAX_RPC_LINE_BYTES).toBe(largestPng + 65536);
    expect(MAX_RPC_LINE_BYTES).toBeLessThan(8 * 1024 * 1024);
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
