import { randomUUID } from 'node:crypto';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { TERMINALS_PER_APP, TERMINALS_TOTAL, type ShellInfo, type TerminalInfo } from '@otherbench/core/types/terminal.js';
import type { PtyProcess, PtySpawn } from './pty.js';
import type { ShellOption } from './shells.js';

/** About 1 MB of recent output per terminal, replayed when a page attaches. */
export const TERMINAL_BUFFER_LIMIT = 1_000_000;

export type TerminalErrorCode = 'terminal-limit' | 'unknown-shell' | 'no-terminal' | 'terminal-unavailable';

export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}

export interface TerminalListener {
  onOutput(data: string): void;
  onExit(exitCode: number): void;
}

export interface TerminalManagerOptions {
  /** The PTY, loaded once on first use; null when it can't load on this machine. */
  loadSpawn: () => Promise<PtySpawn | null>;
  shells: () => ShellOption[];
  emit: (e: AppEvent) => void;
  /** Ends a process and everything it started (kill-tree.ts). */
  killTree: (pid: number) => Promise<void>;
  /** Defaults to `terminalEnv(process.env)`. */
  env?: Record<string, string>;
  bufferLimit?: number;
  perApp?: number;
  total?: number;
  /** How long a kill waits for the shell to report its exit before closing the PTY itself (default 1500 ms). */
  exitWaitMs?: number;
}

/** The server's environment without its secrets, as a terminal that draws in colour. */
export function terminalEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return { ...withoutServerSecrets(env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

interface Terminal {
  info: TerminalInfo;
  shell: ShellOption;
  pty: PtyProcess;
  buffer: string;
  listeners: Set<TerminalListener>;
  size: [number, number];
  /** Settles when the current process has exited. */
  exited: Promise<void>;
}

/** The short name a new terminal gets from its shell. */
function shortName(shell: ShellOption): string {
  if (shell.id === 'pwsh') return 'pwsh';
  if (shell.id === 'git-bash') return 'bash';
  if (shell.id === 'powershell' || shell.id === 'cmd' || shell.id === 'wsl') return shell.id;
  return shell.label;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

/**
 * The Code tab's terminals (spec 2026-10-21-code-terminal-design): shells this
 * server runs for an app, each with the last ~1 MB of its output so a page
 * that attaches (a reload, another window) sees what it missed. Knows nothing
 * of HTTP, so the routes are a thin layer over it and a paired machine's
 * forwarding can call the same methods later. Everything is in memory: the
 * terminals end with the server.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  private spawn: Promise<PtySpawn | null> | null = null;
  private closed = false;
  private readonly env: Record<string, string>;
  private readonly bufferLimit: number;
  private readonly perApp: number;
  private readonly total: number;

  constructor(private readonly opts: TerminalManagerOptions) {
    this.env = opts.env ?? terminalEnv(process.env);
    this.bufferLimit = opts.bufferLimit ?? TERMINAL_BUFFER_LIMIT;
    this.perApp = opts.perApp ?? TERMINALS_PER_APP;
    this.total = opts.total ?? TERMINALS_TOTAL;
  }

  private loadSpawn(): Promise<PtySpawn | null> {
    this.spawn ??= this.opts.loadSpawn().catch(() => null);
    return this.spawn;
  }

  /** Whether a terminal can start here: the PTY loaded. */
  async available(): Promise<boolean> {
    return (await this.loadSpawn()) !== null;
  }

  shellInfos(): ShellInfo[] {
    return this.opts.shells().map(({ id, label, default: isDefault }) => ({ id, label, default: isDefault }));
  }

  list(appId: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => t.info.appId === appId).map((t) => ({ ...t.info }));
  }

  private get(appId: string, id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t || t.info.appId !== appId) throw new TerminalError('no-terminal', 'That terminal has closed.');
    return t;
  }

  private changed(appId: string): void {
    this.opts.emit({ type: 'terminals-changed', appId });
  }

  private nameFor(appId: string, base: string): string {
    const taken = new Set(this.list(appId).map((t) => t.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
  }

  /** Starts `t.shell` in `cwd` as `t`'s process; output and exit of an earlier process are ignored from then on. */
  private start(t: Terminal, spawn: PtySpawn, cwd: string): void {
    const pty = spawn(t.shell.file, t.shell.args, { cwd, env: this.env, cols: t.size[0], rows: t.size[1] });
    t.pty = pty;
    t.info.exitCode = null;
    let markExited: () => void = () => {};
    t.exited = new Promise((resolve) => {
      markExited = resolve;
    });
    pty.onData((data) => {
      if (t.pty !== pty) return;
      this.append(t, data);
      for (const l of t.listeners) l.onOutput(data);
    });
    pty.onExit((code) => {
      markExited();
      if (t.pty !== pty || !this.terminals.has(t.info.id)) return;
      t.info.exitCode = code;
      for (const l of t.listeners) l.onExit(code);
      this.changed(t.info.appId);
    });
  }

  private append(t: Terminal, data: string): void {
    let buffer = t.buffer + data;
    if (buffer.length > this.bufferLimit) {
      let from = buffer.length - this.bufferLimit;
      const unit = buffer.charCodeAt(from);
      if (unit >= 0xdc00 && unit <= 0xdfff) from++; // never start on the second half of a surrogate pair
      buffer = buffer.slice(from);
    }
    t.buffer = buffer;
  }

  async create(appId: string, cwd: string, opts: { shellId?: string; cols: number; rows: number }): Promise<TerminalInfo> {
    const spawn = this.closed ? null : await this.loadSpawn();
    if (!spawn || this.closed) throw new TerminalError('terminal-unavailable', "Terminals can't run on this machine.");
    const shells = this.opts.shells();
    const shell = opts.shellId === undefined ? (shells.find((s) => s.default) ?? shells[0]) : shells.find((s) => s.id === opts.shellId);
    if (!shell) throw new TerminalError('unknown-shell', opts.shellId === undefined ? 'No shell was found on this machine.' : `There's no shell "${opts.shellId}" on this machine.`);
    if (this.list(appId).length >= this.perApp) throw new TerminalError('terminal-limit', `An app can have at most ${this.perApp} terminals. Close one first.`);
    if (this.terminals.size >= this.total) throw new TerminalError('terminal-limit', `At most ${this.total} terminals can be open. Close one first.`);
    const info: TerminalInfo = { id: randomUUID(), appId, name: this.nameFor(appId, shortName(shell)), shellId: shell.id, exitCode: null, createdAt: Date.now() };
    const t: Terminal = { info, shell, pty: null as unknown as PtyProcess, buffer: '', listeners: new Set(), exited: Promise.resolve(), size: [clamp(opts.cols, 2, 1000), clamp(opts.rows, 1, 500)] };
    this.start(t, spawn, cwd);
    this.terminals.set(info.id, t);
    this.changed(appId);
    return { ...info };
  }

  rename(appId: string, id: string, name: string): TerminalInfo {
    const t = this.get(appId, id);
    t.info.name = name;
    this.changed(appId);
    return { ...t.info };
  }

  input(appId: string, id: string, data: string): void {
    const t = this.get(appId, id);
    if (t.info.exitCode === null) t.pty.write(data);
  }

  resize(appId: string, id: string, cols: number, rows: number): void {
    const t = this.get(appId, id);
    t.size = [clamp(cols, 2, 1000), clamp(rows, 1, 500)];
    if (t.info.exitCode === null) t.pty.resize(t.size[0], t.size[1]);
  }

  attach(appId: string, id: string, listener: TerminalListener): { buffer: string; exitCode: number | null; detach(): void } {
    const t = this.get(appId, id);
    t.listeners.add(listener);
    return { buffer: t.buffer, exitCode: t.info.exitCode, detach: () => t.listeners.delete(listener) };
  }

  async restart(appId: string, id: string, cwd: string): Promise<TerminalInfo> {
    const t = this.get(appId, id);
    const spawn = this.closed ? null : await this.loadSpawn();
    if (!spawn || this.closed) throw new TerminalError('terminal-unavailable', "Terminals can't run on this machine.");
    if (t.info.exitCode === null) await this.stop(t);
    t.buffer = '';
    this.start(t, spawn, cwd);
    this.changed(appId);
    return { ...t.info };
  }

  /**
   * Ends a running process and everything it started, then closes the PTY. The PTY is closed only if the shell hasn't
   * reported its exit after the tree kill: on Windows, closing a ConPTY whose shell is already gone makes node-pty's
   * console agent print "AttachConsole failed".
   */
  private async stop(t: Terminal): Promise<void> {
    if (t.info.exitCode !== null) return;
    const pty = t.pty;
    let exited = false;
    const exit = t.exited.then(() => {
      exited = true;
    });
    await this.opts.killTree(pty.pid).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>((r) => (timer = setTimeout(r, this.opts.exitWaitMs ?? 1500)))]);
    clearTimeout(timer);
    if (exited) return;
    try {
      pty.kill();
    } catch {
      // already gone
    }
  }

  async kill(appId: string, id: string): Promise<void> {
    const t = this.get(appId, id);
    this.terminals.delete(id);
    await this.stop(t);
    this.changed(appId);
  }

  async killApp(appId: string): Promise<void> {
    const ids = [...this.terminals.values()].filter((t) => t.info.appId === appId).map((t) => t.info.id);
    await Promise.all(ids.map((id) => this.kill(appId, id)));
  }

  /** Kills the terminals of every app that no longer exists (deleted here or by a sync). */
  async prune(appExists: (appId: string) => boolean): Promise<void> {
    const gone = new Set([...this.terminals.values()].map((t) => t.info.appId).filter((id) => !appExists(id)));
    await Promise.all([...gone].map((id) => this.killApp(id)));
  }

  /** Server shutdown: every terminal's tree at once, and no new ones after. */
  async closeAll(): Promise<void> {
    this.closed = true;
    const all = [...this.terminals.values()];
    this.terminals.clear();
    await Promise.all(all.map((t) => this.stop(t)));
  }
}
