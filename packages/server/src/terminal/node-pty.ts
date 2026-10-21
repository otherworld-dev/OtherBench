import { createRequire } from 'node:module';
import type { PtyProcess, PtySpawn } from './pty.js';

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): {
    readonly pid: number;
    onData(cb: (data: string) => void): unknown;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
}

/** node-pty 1.1.0's Windows internals that `releaseConpty` uses (pinned version; checked before use). */
interface WindowsInternals {
  _isReady?: boolean;
  _close?: () => void;
  _agent?: {
    _pty?: unknown;
    _ptyNative?: { kill(pty: unknown): void };
    _inSocket?: { readable: boolean };
    _outSocket?: { readable: boolean };
    _conoutSocketWorker?: { dispose(): void };
  };
}

/**
 * Closes a Windows ConPTY without node-pty's own `kill()`. That one forks a helper to list the console's processes
 * and kill them; once the shell has gone (our tree kill, or `exit`) the helper fails with "AttachConsole failed" on
 * stderr and node-pty waits 5 s. The processes are already ended by then, so this does only the rest: closes the
 * pseudoconsole (ending its conhost.exe) and the output worker. False when the internals aren't as expected.
 */
function releaseConpty(pty: unknown): boolean {
  const t = pty as WindowsInternals;
  const agent = t._agent;
  if (!t._isReady || typeof t._close !== 'function' || !agent || typeof agent._ptyNative?.kill !== 'function' || agent._pty === undefined) return false;
  t._close();
  if (agent._inSocket) agent._inSocket.readable = false;
  if (agent._outSocket) agent._outSocket.readable = false;
  try {
    agent._ptyNative.kill(agent._pty);
  } catch {
    // already closed
  }
  agent._conoutSocketWorker?.dispose();
  return true;
}

let warned = false;

/**
 * The PTY (`@lydell/node-pty`, node-pty with prebuilt binaries), loaded on
 * first use so a machine without a prebuild only loses terminals: null then,
 * and the Terminal tab says so (spec 2026-10-21-code-terminal-design, "PTY library").
 */
export async function loadNodePty(
  deps: { platform?: NodeJS.Platform; importPty?: () => Promise<unknown>; requireNative?: (id: string) => unknown } = {}
): Promise<PtySpawn | null> {
  const platform = deps.platform ?? process.platform;
  let mod: NodePtyModule;
  try {
    const imported = ((await (deps.importPty ?? (() => import('@lydell/node-pty')))()) ?? {}) as NodePtyModule & { default?: NodePtyModule };
    mod = typeof imported.spawn === 'function' ? imported : (imported.default as NodePtyModule);
    if (typeof mod?.spawn !== 'function') throw new Error('no spawn export');
    // On Windows the package imports without its binary, which it loads only on the first spawn: load it now, so a
    // missing per-platform package means no terminals rather than a Terminal tab whose shells fail to start.
    if (platform === 'win32') (deps.requireNative ?? createRequire(import.meta.url))(`@lydell/node-pty-${platform}-${process.arch}/conpty.node`);
  } catch (err) {
    if (!warned) console.warn('[otherbench-server] terminals are off: the PTY module did not load:', err instanceof Error ? err.message : err);
    warned = true;
    return null;
  }
  return (file, args, opts): PtyProcess => {
    const pty = mod.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
    let closed = false;
    return {
      pid: pty.pid,
      onData: (cb) => void pty.onData(cb),
      onExit: (cb) => void pty.onExit((e) => cb(e.exitCode)),
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      // Once only. The manager has already ended the process tree when it calls this, or the shell exited by itself.
      kill: () => {
        if (closed) return;
        closed = true;
        if (process.platform === 'win32' && releaseConpty(pty)) return;
        pty.kill();
      },
    };
  };
}
