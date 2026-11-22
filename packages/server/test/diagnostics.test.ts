import { Console } from 'node:console';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { consoleToStderr, installFatalHandlers, timestampConsole } from '../src/cli.js';

/** A console writing to two in-memory streams, as the server's writes to stdout and stderr. */
function fakeConsole(): { target: Console; out: string[]; err: string[] } {
  const sink = (lines: string[]): Writable =>
    new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
  const out: string[] = [];
  const err: string[] = [];
  return { target: new Console({ stdout: sink(out), stderr: sink(err) }), out, err };
}

const AT = new Date('2026-11-22T10:20:30.456Z');

describe('timestampConsole', () => {
  it('begins every log line with the time, whatever the method', () => {
    const { target, out, err } = fakeConsole();
    timestampConsole(target, () => AT);
    target.log('listening');
    target.info('[otherbench-server] started');
    target.warn('[otherbench-server] careful');
    target.error('[otherbench-server] failed:', new Error('boom'));
    expect(out).toEqual(['2026-11-22T10:20:30.456Z listening\n', '2026-11-22T10:20:30.456Z [otherbench-server] started\n']);
    expect(err[0]).toBe('2026-11-22T10:20:30.456Z [otherbench-server] careful\n');
    expect(err[1]).toMatch(/^2026-11-22T10:20:30\.456Z \[otherbench-server\] failed: Error: boom\n {4}at /);
  });

  it('keeps a format string a format string, and stamps a line that starts with something else', () => {
    const { target, err } = fakeConsole();
    timestampConsole(target, () => AT);
    target.error('%s of %d', 'one', 2);
    target.error(new Error('bare'));
    expect(err[0]).toBe('2026-11-22T10:20:30.456Z one of 2\n');
    expect(err[1]).toMatch(/^2026-11-22T10:20:30\.456Z Error: bare\n/);
  });

  it('stamps once however often it is asked', () => {
    const { target, err } = fakeConsole();
    timestampConsole(target, () => AT);
    timestampConsole(target, () => AT);
    target.error('once');
    expect(err).toEqual(['2026-11-22T10:20:30.456Z once\n']);
  });

  it('still stamps what consoleToStderr moves off stdout (the desktop channel has stdout to itself)', () => {
    const { target, out, err } = fakeConsole();
    const stderr: string[] = [];
    timestampConsole(target, () => AT);
    consoleToStderr(target, new Writable({ write: (chunk: Buffer, _enc, done) => (stderr.push(chunk.toString()), done()) }));
    target.log('moved');
    target.error('stays');
    expect(out).toEqual([]);
    expect(stderr).toEqual(['2026-11-22T10:20:30.456Z moved\n']);
    expect(err).toEqual(['2026-11-22T10:20:30.456Z stays\n']);
  });
});

describe('installFatalHandlers', () => {
  it('logs an uncaught exception with its stack and leaves the exit to Node', () => {
    const proc = new EventEmitter();
    const log = vi.fn();
    installFatalHandlers(proc, log);
    const err = new Error('boom');
    proc.emit('uncaughtExceptionMonitor', err, 'uncaughtException');
    expect(log).toHaveBeenCalledWith('[otherbench-server] fatal: uncaught exception, the server is exiting:', err);
    // No handler of its own for the exception itself: Node's default (print it, exit with a failure code) stands.
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });

  it('logs a rejection nobody handled and keeps the server running', () => {
    const proc = new EventEmitter();
    const log = vi.fn();
    installFatalHandlers(proc, log);
    const err = new Error('nobody waited');
    proc.emit('unhandledRejection', err, Promise.resolve());
    expect(log).toHaveBeenCalledWith('[otherbench-server] unhandled promise rejection (the server carries on):', err);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
  });
});
