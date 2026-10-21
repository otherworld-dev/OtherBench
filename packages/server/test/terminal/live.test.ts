import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { killTree } from '../../src/terminal/kill-tree.js';
import { TerminalManager } from '../../src/terminal/manager.js';
import { loadNodePty } from '../../src/terminal/node-pty.js';
import { detectShells, realShellProbe } from '../../src/terminal/shells.js';

// A real PTY and the machine's default shell. Skipped where the PTY module doesn't load.
const spawn = await loadNodePty();
const dir = mkdtempSync(join(tmpdir(), 'ob-term-live-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(spawn === null)('a real terminal', () => {
  const manager = new TerminalManager({ loadSpawn: async () => spawn, shells: () => detectShells(realShellProbe()), emit: () => {}, killTree });
  afterAll(() => manager.closeAll());

  it('echoes through the default shell', async () => {
    const t = await manager.create('live', dir, { cols: 120, rows: 30 });
    let out = '';
    manager.attach('live', t.id, { onOutput: (d) => (out += d), onExit: () => {} });
    manager.input('live', t.id, 'echo ob-live-ok\r');
    await waitFor(() => /ob-live-ok[\s\S]*ob-live-ok/.test(out) || (out.match(/ob-live-ok/g) ?? []).length >= 2, 15_000);
    await manager.kill('live', t.id);
  }, 30_000);

  it("kills the shell's children", async () => {
    const t = await manager.create('live', dir, { cols: 200, rows: 30 });
    let out = '';
    manager.attach('live', t.id, { onOutput: (d) => (out += d), onExit: () => {} });
    manager.input('live', t.id, `node -e "console.log('PID='+process.pid+'=');setInterval(()=>{},1000)"\r`);
    await waitFor(() => /PID=(\d+)=/.test(out), 15_000);
    const pid = Number(/PID=(\d+)=/.exec(out)?.[1]);
    expect(alive(pid)).toBe(true);
    await manager.kill('live', t.id);
    await waitFor(() => !alive(pid), 5_000);
  }, 30_000);
});
