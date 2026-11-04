import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';

/** What `killTree` reaches the machine through, so tests can describe one. */
export interface KillTreeDeps {
  platform: NodeJS.Platform;
  /** A system tool's absolute path (`ps`, `pgrep`), or null when it isn't there. */
  tool(name: string): string | null;
  /** A program's stdout; '' when it fails (pgrep with no match exits 1). */
  run(file: string, args: string[]): Promise<string>;
  /** As `process.kill`: throws when the process isn't there. */
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  /** This process, never signalled. */
  self: number;
}

/** How long a hung-up process gets to exit before SIGKILL. */
const HANGUP_GRACE_MS = 1000;
const HANGUP_POLL_MS = 50;

const realDeps: KillTreeDeps = {
  platform: process.platform,
  tool: (name) => ['/usr/bin', '/bin'].map((dir) => `${dir}/${name}`).find((p) => existsSync(p)) ?? null,
  run: (file, args) =>
    new Promise((resolve) => {
      execFile(file, args, { windowsHide: true, env: withoutServerSecrets(process.env) }, (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : ''));
    }),
  kill: (pid, signal) => void process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  self: process.pid,
};

/**
 * Ends a terminal's shell and everything it started, so a dev server doesn't
 * keep its port after its terminal closes (spec 2026-10-21-code-terminal-design,
 * "Killing"). Windows: `taskkill /T /F` from System32 (closing the ConPTY alone
 * leaves detached grandchildren). POSIX: see `hangUpSession`. Never rejects: a
 * process that's already gone is fine.
 */
export function killTree(pid: number, deps: Partial<KillTreeDeps> = {}): Promise<void> {
  const d: KillTreeDeps = { ...realDeps, ...deps };
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (d.platform === 'win32') {
    const taskkill = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'taskkill.exe');
    return d.run(taskkill, ['/PID', String(pid), '/T', '/F']).then(() => undefined);
  }
  return hangUpSession(pid, d).catch(() => undefined);
}

/**
 * POSIX: node-pty starts the shell as a session leader, so its session id is its pid, and everything it started is
 * in that session, background jobs too (bash and zsh give each job a process group of its own, which a group kill
 * misses). As a terminal hanging up does, every process in the session gets SIGHUP (and SIGCONT, so a stopped job
 * wakes to take it), then SIGKILL if it's still there a second later (nohup). Children that left the session with
 * setsid are followed through their parent links while those last. Something that daemonised away from both isn't
 * found: no terminal hangup reaches that either.
 */
async function hangUpSession(pid: number, d: KillTreeDeps): Promise<void> {
  const pgrep = d.tool('pgrep');
  const ps = d.tool('ps');
  const [session, table] = await Promise.all([pgrep ? d.run(pgrep, ['-s', String(pid)]) : '', ps ? d.run(ps, ['-A', '-o', 'pid=,ppid=']) : '']);
  const targets = new Set<number>([pid]);
  for (const line of session.split('\n')) targets.add(Number(line.trim()));
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined || !Number.isInteger(child) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const queue = [...targets];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of children.get(next) ?? []) {
      if (!targets.has(child)) {
        targets.add(child);
        queue.push(child);
      }
    }
  }
  const pids = [...targets].filter((p) => Number.isInteger(p) && p > 1 && p !== d.self);

  const send = (target: number, signal: NodeJS.Signals | 0): boolean => {
    try {
      d.kill(target, signal);
      return true;
    } catch {
      return false; // not there (any more)
    }
  };
  for (const p of pids) {
    send(p, 'SIGHUP');
    send(p, 'SIGCONT');
  }
  let left = pids.filter((p) => send(p, 0));
  for (let waited = 0; left.length > 0 && waited < HANGUP_GRACE_MS; waited += HANGUP_POLL_MS) {
    await d.sleep(HANGUP_POLL_MS);
    left = left.filter((p) => send(p, 0));
  }
  for (const p of left) send(p, 'SIGKILL');
  // The shell's own group too, in case neither pgrep nor ps could be run.
  if (left.length > 0 || (!pgrep && !ps)) send(-pid, 'SIGKILL');
}
