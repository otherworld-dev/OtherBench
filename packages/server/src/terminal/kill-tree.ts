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
/** More than this from one terminal means the listing is wrong, and nothing but the shell is signalled. */
const MAX_TARGETS = 500;

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
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === d.self) return Promise.resolve();
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
  const parentOf = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [child, parent] = [Number(m[1]), Number(m[2])];
    parentOf.set(child, parent);
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  // This server and everything above it are never a target, nor is anything that isn't a real process id (pgrep's
  // trailing newline once made a 0 here, and walking from 0 reaches init and so every process on the machine).
  const protectedPids = new Set<number>([d.self]);
  for (let p = parentOf.get(d.self); p !== undefined && !protectedPids.has(p); p = parentOf.get(p)) protectedPids.add(p);
  const eligible = (p: number): boolean => Number.isSafeInteger(p) && p > 1 && !protectedPids.has(p);
  const send = (target: number, signal: NodeJS.Signals | 0): boolean => {
    try {
      d.kill(target, signal);
      return true;
    } catch {
      return false; // not there (any more)
    }
  };
  if (!eligible(pid)) return;

  const targets = new Set<number>([pid]);
  for (const line of session.split('\n')) {
    const text = line.trim();
    if (/^\d+$/.test(text) && eligible(Number(text))) targets.add(Number(text));
  }
  // Children that left the session, through their parent links; only ever walked from a target.
  const queue = [...targets];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of children.get(next) ?? []) {
      if (eligible(child) && !targets.has(child)) {
        targets.add(child);
        queue.push(child);
      }
    }
  }
  const pids = [...targets];
  if (pids.length > MAX_TARGETS) {
    // One terminal doesn't run this many: the listing is wrong somehow, so only the shell and its own group go.
    console.warn(`[otherbench-server] closing a terminal found ${pids.length} processes to end; ending only its shell (${pid})`);
    send(-pid, 'SIGKILL');
    send(pid, 'SIGKILL');
    return;
  }

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
