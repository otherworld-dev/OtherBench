import { describe, expect, it, vi } from 'vitest';
import type { MountNeed, PlannedMount } from '@grunt/core/domain/sandbox-paths.js';
import { MOUNT_SCRIPT, MountManager, wslMountRunner, type MountRunner } from '../src/mounts.js';
import { FakeWsl } from './helpers.js';

function recordingRunner(fail: { mount?: (m: PlannedMount) => boolean; unmount?: (m: PlannedMount) => boolean } = {}): MountRunner & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    mount: async (m) => {
      if (fail.mount?.(m)) throw new Error(`mount of ${m.linuxPath} failed`);
      log.push(`mount ${m.mode} ${m.linuxPath}`);
    },
    unmount: async (m) => {
      if (fail.unmount?.(m)) throw new Error('target is busy');
      log.push(`unmount ${m.linuxPath}`);
    },
  };
}
const ro = (windowsPath: string): MountNeed => ({ windowsPath, writable: false });
const rw = (windowsPath: string): MountNeed => ({ windowsPath, writable: true });

describe('MountManager', () => {
  it("mounts a chat's folders, parents first", async () => {
    const r = recordingRunner();
    await new MountManager(r, () => {}).set('chat-1', [rw('E:\\Git\\Grunt'), ro('E:\\Git'), ro('D:\\Refs')]);
    expect(r.log).toEqual(['mount ro /mnt/d/Refs', 'mount ro /mnt/e/Git', 'mount rw /mnt/e/Git/Grunt']);
  });

  it('shares a folder between chats, remounting it read-write while one needs that, and back', async () => {
    const r = recordingRunner();
    const m = new MountManager(r, () => {});
    await m.set('chat-1', [ro('E:\\Git\\Grunt')]);
    await m.set('chat-2', [rw('E:\\Git\\Grunt')]);
    await m.remove('chat-2');
    await m.remove('chat-1');
    expect(r.log).toEqual([
      'mount ro /mnt/e/Git/Grunt',
      'unmount /mnt/e/Git/Grunt',
      'mount rw /mnt/e/Git/Grunt',
      'unmount /mnt/e/Git/Grunt',
      'mount ro /mnt/e/Git/Grunt',
      'unmount /mnt/e/Git/Grunt',
    ]);
    expect(m.mounted).toEqual([]);
  });

  it('unmounts deepest first and leaves what another chat still needs', async () => {
    const r = recordingRunner();
    const m = new MountManager(r, () => {});
    await m.set('chat-1', [ro('E:\\Git'), rw('E:\\Git\\Grunt'), ro('D:\\Refs')]);
    await m.set('chat-2', [ro('D:\\Refs')]);
    r.log.length = 0;
    await m.remove('chat-1');
    expect(r.log).toEqual(['unmount /mnt/e/Git/Grunt', 'unmount /mnt/e/Git']);
    expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/d/Refs']);
  });

  it('keeps a mount it could not remove on the way out, says so, and retries on the next change', async () => {
    let busy = true;
    const warn = vi.fn();
    const r = recordingRunner({ unmount: () => busy });
    const m = new MountManager(r, warn);
    await m.set('chat-1', [ro('D:\\Refs')]);
    await m.remove('chat-1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/mnt/d/Refs'));
    expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/d/Refs']);
    busy = false;
    await m.set('chat-2', [ro('E:\\Git')]);
    expect(r.log).toContain('unmount /mnt/d/Refs');
    expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/e/Git']);
  });

  it("refuses a chat's run with mount_failed when one of its folders won't mount", async () => {
    const m = new MountManager(recordingRunner({ mount: (x) => x.linuxPath === '/mnt/d/Refs' }), () => {});
    await expect(m.set('chat-1', [ro('D:\\Refs')])).rejects.toMatchObject({ name: 'SandboxError', code: 'mount_failed', message: expect.stringContaining('D:\\Refs') });
  });

  it("refuses when a folder can't be remounted read-write because the read-only mount is busy", async () => {
    const r = recordingRunner({ unmount: () => true });
    const m = new MountManager(r, () => {});
    await m.set('chat-1', [ro('E:\\Git')]);
    await expect(m.set('chat-2', [rw('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed' });
  });

  it('applies one change at a time', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner: MountRunner = {
      mount: async (x) => {
        order.push(`start ${x.linuxPath}`);
        if (x.linuxPath === '/mnt/d/A') await gate;
        order.push(`end ${x.linuxPath}`);
      },
      unmount: async () => {},
    };
    const m = new MountManager(runner, () => {});
    const first = m.set('chat-1', [ro('D:\\A')]);
    const second = m.set('chat-2', [ro('D:\\B')]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start /mnt/d/A', 'end /mnt/d/A', 'start /mnt/d/B', 'end /mnt/d/B']);
  });

  it('resync() forgets what is mounted but keeps the needs, so the next change mounts everything again', async () => {
    const r = recordingRunner();
    const m = new MountManager(r, () => {});
    await m.set('chat-1', [ro('D:\\Refs')]);
    m.resync();
    expect(m.mounted).toEqual([]);
    await m.set('chat-2', [ro('E:\\Git')]);
    expect(r.log).toEqual(['mount ro /mnt/d/Refs', 'mount ro /mnt/d/Refs', 'mount ro /mnt/e/Git']);
  });

  it('forget() drops needs and mounts without touching the VM', async () => {
    const r = recordingRunner();
    const m = new MountManager(r, () => {});
    await m.set('chat-1', [ro('D:\\Refs')]);
    m.forget();
    await m.clear();
    expect(r.log).toEqual(['mount ro /mnt/d/Refs']);
    expect(m.mounted).toEqual([]);
  });

  describe('a parent folder mounted after a folder inside it', () => {
    it('takes the inner mount off, mounts the parent, then mounts the inner one again', async () => {
      const r = recordingRunner();
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [rw('E:\\Git\\Grunt')]);
      r.log.length = 0;
      await m.set('chat-2', [ro('E:\\Git')]);
      expect(r.log).toEqual(['unmount /mnt/e/Git/Grunt', 'mount ro /mnt/e/Git', 'mount rw /mnt/e/Git/Grunt']);
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['ro /mnt/e/Git', 'rw /mnt/e/Git/Grunt']);
    });

    it('moves every inner mount, and leaves mounts elsewhere alone', async () => {
      const r = recordingRunner();
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [rw('E:\\Git\\Grunt'), rw('E:\\Git\\Other'), ro('E:\\Gitter'), ro('D:\\Refs')]);
      r.log.length = 0;
      await m.set('chat-2', [ro('E:\\Git')]);
      expect(r.log).toEqual(['unmount /mnt/e/Git/Grunt', 'unmount /mnt/e/Git/Other', 'mount ro /mnt/e/Git', 'mount rw /mnt/e/Git/Grunt', 'mount rw /mnt/e/Git/Other']);
    });

    it("doesn't mount the inner folder again once nothing needs it", async () => {
      const r = recordingRunner();
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [rw('E:\\Git\\Grunt')]);
      r.log.length = 0;
      // chat-1 is gone from the plan by the time the parent goes on (its set() replaced its needs).
      await m.set('chat-1', [ro('E:\\Git')]);
      expect(r.log).toEqual(['unmount /mnt/e/Git/Grunt', 'mount ro /mnt/e/Git']);
      expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/e/Git']);
    });

    it("refuses with mount_failed, mounting nothing, when the inner mount is busy", async () => {
      const r = recordingRunner({ unmount: (x) => x.linuxPath === '/mnt/e/Git/Grunt' });
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [rw('E:\\Git\\Grunt')]);
      r.log.length = 0;
      await expect(m.set('chat-2', [ro('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed', message: expect.stringContaining('E:\\Git') });
      expect(r.log).toEqual([]);
      expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/e/Git/Grunt']);
    });

    it('puts the inner mount back, then refuses, when the parent will not mount', async () => {
      const r = recordingRunner({ mount: (x) => x.linuxPath === '/mnt/e/Git' });
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [rw('E:\\Git\\Grunt')]);
      r.log.length = 0;
      await expect(m.set('chat-2', [ro('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed' });
      expect(r.log).toEqual(['unmount /mnt/e/Git/Grunt', 'mount rw /mnt/e/Git/Grunt']);
      expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/e/Git/Grunt']);
    });

    it("refuses when the inner mount can't be put back", async () => {
      let broken = false;
      const r = recordingRunner({ mount: (x) => broken && x.linuxPath === '/mnt/e/Git/Grunt' });
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [rw('E:\\Git\\Grunt')]);
      broken = true;
      await expect(m.set('chat-2', [ro('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed', message: expect.stringContaining('E:\\Git\\Grunt') });
      // chat-2's request is dropped again, and the inner folder (chat-1's) is not mounted: what is mounted says so.
      expect(m.mounted.map((x) => x.linuxPath)).toEqual([]);
      broken = false;
      // The next change mounts the inner folder again, since it is still wanted.
      await m.set('chat-3', [ro('D:\\Refs')]);
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`).sort()).toEqual(['ro /mnt/d/Refs', 'rw /mnt/e/Git/Grunt']);
    });
  });

  describe('a stale parent with a wanted folder inside it', () => {
    /** A runner like a real VM: a folder with another mounted inside it can't be unmounted. */
    function treeRunner(): MountRunner & { log: string[]; mounts: Set<string> } {
      const mounts = new Set<string>();
      const log: string[] = [];
      return {
        mounts,
        log,
        mount: async (m) => {
          mounts.add(m.linuxPath);
          log.push(`mount ${m.mode} ${m.linuxPath}`);
        },
        unmount: async (m) => {
          if ([...mounts].some((p) => p.startsWith(`${m.linuxPath}/`))) throw new Error('target is busy');
          mounts.delete(m.linuxPath);
          log.push(`unmount ${m.linuxPath}`);
        },
      };
    }

    it('lifts the inner mount, unmounts the parent, and mounts the inner one again', async () => {
      const r = treeRunner();
      const warn = vi.fn();
      const m = new MountManager(r, warn);
      await m.set('chat-1', [ro('E:\\Git'), rw('E:\\Git\\Grunt')]);
      await m.set('chat-2', [rw('E:\\Git\\Grunt')]);
      r.log.length = 0;
      await m.remove('chat-1');
      expect(r.log).toEqual(['unmount /mnt/e/Git/Grunt', 'unmount /mnt/e/Git', 'mount rw /mnt/e/Git/Grunt']);
      expect([...r.mounts]).toEqual(['/mnt/e/Git/Grunt']);
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['rw /mnt/e/Git/Grunt']);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('failing closed', () => {
    it("doesn't keep a refused chat's folders for the sake of later changes", async () => {
      const r = recordingRunner({ mount: (x) => x.linuxPath === '/mnt/e/Git' });
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [ro('D:\\Refs')]);
      await expect(m.set('chat-2', [rw('D:\\Work'), rw('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed' });
      // Nothing of chat-2 stays mounted, and another chat's change doesn't bring it back.
      expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/d/Refs']);
      await m.remove('chat-1');
      await m.set('chat-3', [ro('D:\\Other')]);
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['ro /mnt/d/Other']);
      expect(r.log.filter((l) => l.includes('/mnt/d/Work')).sort()).toEqual(['mount rw /mnt/d/Work', 'unmount /mnt/d/Work']);
    });

    it("keeps a chat's earlier folders when a new request for it is refused", async () => {
      let failNext = false;
      const r = recordingRunner({ mount: (x) => failNext && x.linuxPath === '/mnt/e/Git' });
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [ro('D:\\Refs')]);
      failNext = true;
      await expect(m.set('chat-1', [ro('D:\\Refs'), ro('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed' });
      expect(m.mounted.map((x) => x.linuxPath)).toEqual(['/mnt/d/Refs']);
    });

    it('does not put a read-write mount back when read-only was asked and could not be mounted', async () => {
      let failRo = false;
      const r = recordingRunner({ mount: (x) => failRo && x.mode === 'ro' });
      const m = new MountManager(r, () => {});
      await m.set('chat-1', [rw('D:\\Refs')]);
      failRo = true;
      await expect(m.set('chat-1', [ro('D:\\Refs')])).rejects.toMatchObject({ code: 'mount_failed' });
      // Not mounted at all, rather than read-write behind the back of a chat that asked for read-only.
      expect(m.mounted).toEqual([]);
      expect(r.log).toEqual(['mount rw /mnt/d/Refs', 'unmount /mnt/d/Refs']);
    });

    it("leaves another chat's read-write folder alone when a chat's request is a bad path", async () => {
      const r = recordingRunner();
      const m = new MountManager(r, () => {});
      await m.set('chat-a', [rw('D:\\Work')]);
      r.log.length = 0;
      await expect(m.set('chat-b', [ro('\\\\nas\\share\\x')])).rejects.toMatchObject({ name: 'SandboxPathError' });
      // The plan couldn't be made, so nothing was touched and nothing needs putting back.
      expect(r.log).toEqual([]);
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['rw /mnt/d/Work']);
    });

    it("keeps another chat's read-write folder read-write when a parent mount for a chat fails", async () => {
      const r = recordingRunner({ mount: (x) => x.linuxPath === '/mnt/e/Git' });
      const m = new MountManager(r, () => {});
      await m.set('chat-a', [rw('E:\\Git\\Grunt')]);
      r.log.length = 0;
      // chat-b's rw E:\Git covers E:\Git\Grunt, so the attempt takes chat-a's mount off; it comes back as it was.
      await expect(m.set('chat-b', [rw('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed' });
      expect(r.log).toEqual(['unmount /mnt/e/Git/Grunt', 'mount rw /mnt/e/Git/Grunt']);
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['rw /mnt/e/Git/Grunt']);
    });

    it('refuses a chat when a read-write mount over its folders will not come off', async () => {
      const r = recordingRunner({ unmount: (x) => x.linuxPath === '/mnt/e/Git' });
      const warn = vi.fn();
      const m = new MountManager(r, warn);
      await m.set('chat-1', [rw('E:\\Git')]);
      await m.remove('chat-1');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('/mnt/e/Git'));
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['rw /mnt/e/Git']);
      await expect(m.set('chat-2', [ro('E:\\Git\\Grunt')])).rejects.toMatchObject({ code: 'mount_failed', message: expect.stringContaining('E:\\Git') });
      await expect(m.set('chat-2', [ro('E:\\Git')])).rejects.toMatchObject({ code: 'mount_failed' });
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['rw /mnt/e/Git']);
    });

    it('only warns about a stale mount that is not in the way of the chat', async () => {
      const r = recordingRunner({ unmount: (x) => x.linuxPath === '/mnt/e/Git' });
      const warn = vi.fn();
      const m = new MountManager(r, warn);
      await m.set('chat-1', [rw('E:\\Git')]);
      await m.remove('chat-1');
      warn.mockClear();
      await m.set('chat-2', [ro('D:\\Refs')]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('/mnt/e/Git'));
      expect(m.mounted.map((x) => `${x.mode} ${x.linuxPath}`)).toEqual(['rw /mnt/e/Git', 'ro /mnt/d/Refs']);
    });
  });
});

describe('wslMountRunner', () => {
  it('calls mount.sh as root with the Windows path, the Linux path and the mode', async () => {
    const wsl = new FakeWsl();
    const runner = wslMountRunner(wsl);
    await runner.mount({ windowsPath: 'E:\\Git', linuxPath: '/mnt/e/Git', mode: 'ro' });
    await runner.unmount({ windowsPath: 'E:\\Git', linuxPath: '/mnt/e/Git', mode: 'ro' });
    expect(wsl.calls).toEqual([
      { kind: 'exec', user: 'root', argv: [MOUNT_SCRIPT, 'mount', 'E:\\Git', '/mnt/e/Git', 'ro'] },
      { kind: 'exec', user: 'root', argv: [MOUNT_SCRIPT, 'unmount', 'E:\\Git', '/mnt/e/Git'] },
    ]);
  });

  it("turns a failure into an error carrying mount.sh's message", async () => {
    const runner = wslMountRunner(new FakeWsl(() => ({ code: 2, stderr: "mount.sh: target /etc doesn't match E:\\Git\n" })));
    await expect(runner.mount({ windowsPath: 'E:\\Git', linuxPath: '/mnt/e/Git', mode: 'ro' })).rejects.toThrow(/doesn't match/);
  });
});
