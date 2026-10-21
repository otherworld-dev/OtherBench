import { describe, expect, it } from 'vitest';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { TerminalError, TerminalManager, terminalEnv, type TerminalManagerOptions } from '../../src/terminal/manager.js';
import type { PtyProcess, PtySpawn } from '../../src/terminal/pty.js';
import type { ShellOption } from '../../src/terminal/shells.js';

class FakePty implements PtyProcess {
  static nextPid = 1000;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  size: [number, number];
  killed = false;
  private dataCb: (d: string) => void = () => {};
  private exitCb: (c: number) => void = () => {};
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }
  ) {
    this.size = [opts.cols, opts.rows];
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (c: number) => void): void {
    this.exitCb = cb;
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.size = [cols, rows];
  }
  kill(): void {
    this.killed = true;
  }
  emit(d: string): void {
    this.dataCb(d);
  }
  exit(code: number): void {
    this.exitCb(code);
  }
}

const SHELLS: ShellOption[] = [
  { id: 'pwsh', label: 'PowerShell 7', default: true, file: 'C:\\pwsh.exe', args: [] },
  { id: 'git-bash', label: 'Git Bash', default: false, file: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
];

function setup(over: Partial<TerminalManagerOptions> = {}) {
  const ptys: FakePty[] = [];
  const events: AppEvent[] = [];
  const killed: number[] = [];
  const spawn: PtySpawn = (file, args, opts) => {
    const p = new FakePty(file, args, opts);
    ptys.push(p);
    return p;
  };
  const manager = new TerminalManager({
    loadSpawn: async () => spawn,
    shells: () => SHELLS,
    emit: (e) => events.push(e),
    killTree: async (pid) => {
      killed.push(pid);
    },
    env: { PATH: 'x', TERM: 'xterm-256color' },
    ...over,
  });
  return { manager, ptys, events, killed };
}

const SIZE = { cols: 80, rows: 24 };

describe('TerminalManager', () => {
  it('create spawns the default shell in the folder', async () => {
    const { manager, ptys, events } = setup();
    const info = await manager.create('a1', 'E:\\repo', SIZE);
    expect(ptys[0]).toMatchObject({ file: 'C:\\pwsh.exe', args: [], opts: { cwd: 'E:\\repo', cols: 80, rows: 24 } });
    expect(info).toMatchObject({ appId: 'a1', name: 'pwsh', shellId: 'pwsh', exitCode: null });
    expect(manager.list('a1')).toEqual([info]);
    expect(events).toEqual([{ type: 'terminals-changed', appId: 'a1' }]);
  });

  it('terminalEnv leaves out the server token and sets the terminal type', () => {
    const env = terminalEnv({ PATH: 'p', OTHERBENCH_TOKEN: 'secret', otherbench_token: 'secret2', TERM: 'dumb' });
    expect(env).toEqual({ PATH: 'p', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  });

  it('a chosen shell runs with its own arguments', async () => {
    const { manager, ptys } = setup();
    const info = await manager.create('a1', 'E:\\repo', { ...SIZE, shellId: 'git-bash' });
    expect(ptys[0]).toMatchObject({ file: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'] });
    expect(info.name).toBe('bash');
  });

  it('unknown shell id is refused', async () => {
    const { manager } = setup();
    await expect(manager.create('a1', 'E:\\repo', { ...SIZE, shellId: 'C:\\evil.exe' })).rejects.toMatchObject({ code: 'unknown-shell' });
  });

  it('limits: 10 per app and 30 in all', async () => {
    const { manager } = setup();
    for (let i = 0; i < 10; i++) await manager.create('a1', 'E:\\r', SIZE);
    await expect(manager.create('a1', 'E:\\r', SIZE)).rejects.toMatchObject({ code: 'terminal-limit' });
    for (let i = 0; i < 10; i++) await manager.create('a2', 'E:\\r', SIZE);
    for (let i = 0; i < 10; i++) await manager.create('a3', 'E:\\r', SIZE);
    await expect(manager.create('a4', 'E:\\r', SIZE)).rejects.toBeInstanceOf(TerminalError);
    await expect(manager.create('a4', 'E:\\r', SIZE)).rejects.toMatchObject({ code: 'terminal-limit' });
  });

  it("a shell that won't start is a shell-failed error, not a crash, and nothing is kept", async () => {
    const { manager, events } = setup({
      loadSpawn: async () => () => {
        throw new Error('File not found: C:\pwsh.exe');
      },
    });
    await expect(manager.create('a1', 'E:\r', SIZE)).rejects.toMatchObject({ code: 'shell-failed', message: expect.stringContaining('PowerShell 7') });
    expect(manager.list('a1')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('no PTY here', async () => {
    const { manager } = setup({ loadSpawn: async () => null });
    expect(await manager.available()).toBe(false);
    await expect(manager.create('a1', 'E:\\r', SIZE)).rejects.toMatchObject({ code: 'terminal-unavailable' });
  });

  it('names count up', async () => {
    const { manager } = setup();
    await manager.create('a1', 'E:\\r', SIZE);
    const second = await manager.create('a1', 'E:\\r', SIZE);
    const third = await manager.create('a1', 'E:\\r', SIZE);
    expect([second.name, third.name]).toEqual(['pwsh (2)', 'pwsh (3)']);
    // Another app's terminals don't count.
    expect((await manager.create('a2', 'E:\\r', SIZE)).name).toBe('pwsh');
  });

  it('rename keeps the new name', async () => {
    const { manager, events } = setup();
    const t = await manager.create('a1', 'E:\\r', SIZE);
    expect(manager.rename('a1', t.id, 'dev server').name).toBe('dev server');
    expect(manager.list('a1')[0]?.name).toBe('dev server');
    expect(events).toHaveLength(2);
  });

  it('input and resize reach the pty', async () => {
    const { manager, ptys } = setup();
    const t = await manager.create('a1', 'E:\\r', SIZE);
    manager.input('a1', t.id, 'ls\r');
    manager.resize('a1', t.id, 5000, 0);
    expect(ptys[0]?.written).toEqual(['ls\r']);
    expect(ptys[0]?.size).toEqual([1000, 1]);
  });

  it('attach returns the buffer and then only new output', async () => {
    const { manager, ptys } = setup();
    const t = await manager.create('a1', 'E:\\r', SIZE);
    ptys[0]!.emit('a');
    const got: string[] = [];
    const attached = manager.attach('a1', t.id, { onOutput: (d) => got.push(d), onExit: () => {} });
    expect(attached).toMatchObject({ buffer: 'a', exitCode: null });
    ptys[0]!.emit('b');
    expect(got).toEqual(['b']);
    attached.detach();
    ptys[0]!.emit('c');
    expect(got).toEqual(['b']);
    expect(manager.attach('a1', t.id, { onOutput: () => {}, onExit: () => {} }).buffer).toBe('abc');
  });

  it('trims the buffer without splitting a surrogate pair', async () => {
    const { manager, ptys } = setup({ bufferLimit: 5 });
    const t = await manager.create('a1', 'E:\\r', SIZE);
    // Trimmed once a quarter over the limit (7 here), back to the limit: the cut would land on the emoji's second half.
    ptys[0]!.emit('ab😀cd');
    ptys[0]!.emit('ef');
    const { buffer } = manager.attach('a1', t.id, { onOutput: () => {}, onExit: () => {} });
    expect(buffer.length).toBeLessThanOrEqual(5);
    const first = buffer.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(buffer).toBe('cdef');
  });

  it('exit keeps the terminal with its code', async () => {
    const { manager, ptys, events } = setup();
    const t = await manager.create('a1', 'E:\\r', SIZE);
    const exits: number[] = [];
    manager.attach('a1', t.id, { onOutput: () => {}, onExit: (c) => exits.push(c) });
    ptys[0]!.exit(3);
    expect(manager.list('a1')[0]?.exitCode).toBe(3);
    expect(exits).toEqual([3]);
    expect(events).toHaveLength(2);
    manager.input('a1', t.id, 'ignored');
    expect(ptys[0]?.written).toEqual([]);
    expect(manager.attach('a1', t.id, { onOutput: () => {}, onExit: () => {} }).exitCode).toBe(3);
  });

  it('restart replaces the process and clears the exit', async () => {
    const { manager, ptys } = setup();
    const t = await manager.create('a1', 'E:\\r', { ...SIZE, shellId: 'git-bash' });
    manager.rename('a1', t.id, 'mine');
    ptys[0]!.emit('old');
    ptys[0]!.exit(1);
    const again = await manager.restart('a1', t.id, 'E:\\r2');
    expect(ptys).toHaveLength(2);
    expect(ptys[1]).toMatchObject({ file: 'C:\\Git\\bin\\bash.exe', opts: { cwd: 'E:\\r2' } });
    expect(again).toMatchObject({ id: t.id, name: 'mine', exitCode: null });
    // The old process's late output and exit don't touch the new one.
    ptys[0]!.emit('late');
    ptys[0]!.exit(9);
    expect(manager.list('a1')[0]?.exitCode).toBeNull();
    expect(manager.attach('a1', t.id, { onOutput: () => {}, onExit: () => {} }).buffer).not.toContain('late');
  });

  it('kill kills the tree then the pty and forgets it', async () => {
    const order: string[] = [];
    const { manager, ptys, events } = setup({
      killTree: async (pid) => {
        order.push(`tree:${pid}`);
      },
    });
    const t = await manager.create('a1', 'E:\\r', SIZE);
    const pty = ptys[0]!;
    pty.kill = () => order.push('pty');
    await manager.kill('a1', t.id);
    expect(order).toEqual([`tree:${pty.pid}`, 'pty']);
    expect(manager.list('a1')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'terminals-changed', appId: 'a1' });
  });

  it('a shell that exits by itself has its PTY closed, so nothing of it is left running', async () => {
    const { manager, ptys } = setup();
    await manager.create('a1', 'E:\r', SIZE);
    ptys[0]!.exit(0);
    expect(ptys[0]?.killed).toBe(true);
  });

  it('killing an exited terminal skips the tree', async () => {
    const { manager, ptys, killed } = setup();
    const t = await manager.create('a1', 'E:\\r', SIZE);
    ptys[0]!.exit(0);
    await manager.kill('a1', t.id);
    expect(killed).toEqual([]);
    expect(manager.list('a1')).toEqual([]);
  });

  it('prune kills terminals of apps that are gone', async () => {
    const { manager, killed, ptys } = setup();
    await manager.create('a1', 'E:\\r', SIZE);
    await manager.create('gone', 'E:\\r', SIZE);
    await manager.prune((id) => id === 'a1');
    expect(killed).toEqual([ptys[1]!.pid]);
    expect(manager.list('gone')).toEqual([]);
    expect(manager.list('a1')).toHaveLength(1);
  });

  it('killApp kills only that app', async () => {
    const { manager } = setup();
    await manager.create('a1', 'E:\\r', SIZE);
    await manager.create('a2', 'E:\\r', SIZE);
    await manager.killApp('a1');
    expect(manager.list('a1')).toEqual([]);
    expect(manager.list('a2')).toHaveLength(1);
  });

  it('closeAll kills everything in parallel', async () => {
    const pending: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { manager } = setup({
      killTree: async (pid) => {
        pending.push(pid);
        await gate;
      },
    });
    await manager.create('a1', 'E:\\r', SIZE);
    await manager.create('a2', 'E:\\r', SIZE);
    const closing = manager.closeAll();
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    release();
    await closing;
    expect(manager.list('a1')).toEqual([]);
    expect(manager.list('a2')).toEqual([]);
    await expect(manager.create('a1', 'E:\\r', SIZE)).rejects.toMatchObject({ code: 'terminal-unavailable' });
  });

  it('wrong app id is no-terminal', async () => {
    const { manager } = setup();
    const t = await manager.create('a1', 'E:\\r', SIZE);
    expect(() => manager.input('a2', t.id, 'x')).toThrow(TerminalError);
    expect(() => manager.rename('a2', t.id, 'x')).toThrow(expect.objectContaining({ code: 'no-terminal' }));
    await expect(manager.kill('a2', t.id)).rejects.toMatchObject({ code: 'no-terminal' });
  });

  it('a restart that a close overtakes starts nothing', async () => {
    const releases: (() => void)[] = [];
    const { manager, ptys } = setup({ killTree: () => new Promise<void>((r) => releases.push(r)) });
    const t = await manager.create('a1', 'E:\r', SIZE);
    const restarting = manager.restart('a1', t.id, 'E:\r');
    const killing = manager.kill('a1', t.id);
    for (const r of releases) r();
    await expect(restarting).rejects.toMatchObject({ code: 'no-terminal' });
    await killing;
    expect(ptys).toHaveLength(1);
    expect(manager.list('a1')).toEqual([]);
  });

  it('typing or resizing in the moment after the shell has gone is ignored, not an error', async () => {
    const { manager, ptys } = setup();
    const t = await manager.create('a1', 'E:\r', SIZE);
    ptys[0]!.resize = () => {
      throw new Error('Cannot resize a pty that has already exited');
    };
    ptys[0]!.write = () => {
      throw new Error('write EPIPE');
    };
    expect(() => manager.resize('a1', t.id, 100, 30)).not.toThrow();
    expect(() => manager.input('a1', t.id, 'x')).not.toThrow();
  });

  it('trimming starts the replay at a line start, so it never opens mid escape sequence', async () => {
    const { manager, ptys } = setup({ bufferLimit: 20 });
    const t = await manager.create('a1', 'E:\r', SIZE);
    ptys[0]!.emit('\x1b[31mred line one\r\nline two\r\n');
    ptys[0]!.emit('line three\r\n');
    const { buffer } = manager.attach('a1', t.id, { onOutput: () => {}, onExit: () => {} });
    expect(buffer.length).toBeLessThanOrEqual(25);
    expect(buffer.startsWith('line')).toBe(true);
    expect(buffer.endsWith('line three\r\n')).toBe(true);
  });

  it('read gives the output after an offset, and the whole buffer when the offset is gone', async () => {
    const { manager, ptys } = setup({ bufferLimit: 8 });
    const t = await manager.create('a1', 'E:\r', SIZE);
    expect(manager.read('a1', t.id, 0)).toEqual({ data: '', next: 0, reset: false, exitCode: null });
    ptys[0]!.emit('abc');
    const first = manager.read('a1', t.id, 0);
    expect(first).toEqual({ data: 'abc', next: 3, reset: false, exitCode: null });
    ptys[0]!.emit('de');
    expect(manager.read('a1', t.id, first.next)).toEqual({ data: 'de', next: 5, reset: false, exitCode: null });
    ptys[0]!.emit('fghijklmn');
    const behind = manager.read('a1', t.id, 5);
    expect(behind.reset).toBe(true);
    expect(behind.next).toBe(14);
    expect('abcdefghijklmn'.endsWith(behind.data)).toBe(true);
    ptys[0]!.exit(1);
    expect(manager.read('a1', t.id, 14)).toMatchObject({ data: '', exitCode: 1 });
  });
});
