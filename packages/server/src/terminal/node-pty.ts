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

let warned = false;

/**
 * The PTY (`@lydell/node-pty`, node-pty with prebuilt binaries), loaded on
 * first use so a machine without a prebuild only loses terminals: null then,
 * and the Terminal tab says so (spec 2026-10-21-code-terminal-design, "PTY library").
 */
export async function loadNodePty(): Promise<PtySpawn | null> {
  let mod: NodePtyModule;
  try {
    const imported = (await import('@lydell/node-pty')) as unknown as NodePtyModule & { default?: NodePtyModule };
    mod = typeof imported.spawn === 'function' ? imported : (imported.default as NodePtyModule);
    if (typeof mod?.spawn !== 'function') throw new Error('no spawn export');
  } catch (err) {
    if (!warned) console.warn('[otherbench-server] terminals are off: the PTY module did not load:', err instanceof Error ? err.message : err);
    warned = true;
    return null;
  }
  return (file, args, opts): PtyProcess => {
    const pty = mod.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
    return {
      pid: pty.pid,
      onData: (cb) => void pty.onData(cb),
      onExit: (cb) => void pty.onExit((e) => cb(e.exitCode)),
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      kill: () => pty.kill(),
    };
  };
}
