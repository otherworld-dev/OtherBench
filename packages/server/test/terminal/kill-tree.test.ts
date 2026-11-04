import { describe, expect, it } from 'vitest';
import { killTree, type KillTreeDeps } from '../../src/terminal/kill-tree.js';

/**
 * A POSIX machine as `killTree` sees it: a process table, `pgrep -s` and `ps` answering from it, and signals that end
 * a process unless it ignores that one. Only the Windows path runs live on the dev machine, so this is all the cover
 * the POSIX path has.
 */
interface FakeProcess {
  pid: number;
  ppid: number;
  sid: number;
  /** Signals it survives (nohup ignores SIGHUP). SIGKILL always ends it. */
  ignores?: NodeJS.Signals[];
}

function posixMachine(processes: FakeProcess[], opts: { noPgrep?: boolean } = {}) {
  const table = new Map(processes.map((p) => [p.pid, p]));
  const sent: [number, NodeJS.Signals | 0][] = [];
  const deps: KillTreeDeps = {
    platform: 'linux',
    tool: (name) => (name === 'pgrep' && opts.noPgrep ? null : `/usr/bin/${name}`),
    run: async (file, args) => {
      if (file === '/usr/bin/pgrep') {
        expect(args[0]).toBe('-s');
        return [...table.values()].filter((p) => p.sid === Number(args[1])).map((p) => `${p.pid}\n`).join('');
      }
      if (file === '/usr/bin/ps') return [...table.values()].map((p) => `  ${p.pid}  ${p.ppid}\n`).join('');
      throw new Error(`unexpected ${file}`);
    },
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      // A negative pid is a process group; here only the leader is modelled in it.
      const targets = [table.get(Math.abs(pid))].filter((p) => p !== undefined);
      if (targets.length === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (sig === 0 || sig === 'SIGCONT') return;
      for (const p of targets) if (sig === 'SIGKILL' || !p.ignores?.includes(sig)) table.delete(p.pid);
    },
    sleep: async () => {},
    self: 1000,
  };
  return { deps, table, sent };
}

describe('killTree on Linux and macOS', () => {
  // The shell (500) leads its session (node-pty starts it with setsid). bash puts a background job in a process
  // group of its own, so the old group kill missed it; it's still in the session.
  it("hangs up the shell's whole session, background jobs included", async () => {
    const m = posixMachine([
      { pid: 500, ppid: 1000, sid: 500 },
      { pid: 510, ppid: 500, sid: 500 }, // a foreground program
      { pid: 520, ppid: 500, sid: 500 }, // `npm run dev &`, its own group
      { pid: 521, ppid: 520, sid: 500 }, // what that started
      { pid: 900, ppid: 1, sid: 900 }, // someone else's
    ]);
    await killTree(500, m.deps);
    expect([...m.table.keys()]).toEqual([900]);
    for (const pid of [500, 510, 520, 521]) expect(m.sent).toContainEqual([pid, 'SIGHUP']);
    expect(m.sent.some(([pid]) => pid === 900)).toBe(false);
  });

  it('kills what ignores the hangup', async () => {
    const m = posixMachine([
      { pid: 500, ppid: 1000, sid: 500 },
      { pid: 530, ppid: 500, sid: 500, ignores: ['SIGHUP'] }, // nohup
    ]);
    await killTree(500, m.deps);
    expect(m.table.size).toBe(0);
    expect(m.sent).toContainEqual([530, 'SIGKILL']);
  });

  it('wakes a stopped job so it takes the hangup', async () => {
    const m = posixMachine([
      { pid: 500, ppid: 1000, sid: 500 },
      { pid: 540, ppid: 500, sid: 500 },
    ]);
    await killTree(500, m.deps);
    expect(m.sent).toContainEqual([540, 'SIGCONT']);
  });

  it('follows children that left the session with setsid', async () => {
    const m = posixMachine([
      { pid: 500, ppid: 1000, sid: 500 },
      { pid: 550, ppid: 500, sid: 500 },
      { pid: 560, ppid: 550, sid: 560 }, // setsid'd worker whose parent is still there
      { pid: 561, ppid: 560, sid: 560 },
    ]);
    await killTree(500, m.deps);
    expect(m.table.size).toBe(0);
  });

  it('still ends the tree without pgrep', async () => {
    const m = posixMachine(
      [
        { pid: 500, ppid: 1000, sid: 500 },
        { pid: 510, ppid: 500, sid: 500 },
      ],
      { noPgrep: true }
    );
    await killTree(500, m.deps);
    expect(m.table.size).toBe(0);
  });

  it('never signals itself or init, and ignores a bad pid', async () => {
    const m = posixMachine([
      { pid: 500, ppid: 1000, sid: 500 },
      { pid: 1, ppid: 0, sid: 500 },
      { pid: 1000, ppid: 1, sid: 500 },
    ]);
    await killTree(500, m.deps);
    expect(m.sent.some(([pid]) => pid === 1 || pid === 1000)).toBe(false);
    await killTree(0, m.deps);
    await killTree(-5, m.deps);
    expect(m.sent.some(([pid]) => pid === 0 || pid === -5 || pid === 5)).toBe(false);
  });

  it("doesn't wait when everything went on the hangup", async () => {
    const m = posixMachine([{ pid: 500, ppid: 1000, sid: 500 }]);
    let slept = 0;
    await killTree(500, { ...m.deps, sleep: async () => void slept++ });
    expect(slept).toBe(0);
    expect(m.sent.some(([, sig]) => sig === 'SIGKILL')).toBe(false);
  });
});

describe('killTree on Windows', () => {
  it('runs taskkill /T /F from System32', async () => {
    const calls: [string, string[]][] = [];
    await killTree(4242, {
      platform: 'win32',
      run: async (file, args) => {
        calls.push([file, args]);
        return '';
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatch(/System32[\\/]taskkill\.exe$/i);
    expect(calls[0]![1]).toEqual(['/PID', '4242', '/T', '/F']);
  });
});
