import { planMounts, type MountNeed, type PlannedMount } from '@grunt/core/domain/sandbox-paths.js';
import { SandboxError } from '@grunt/core/ports/sandbox.js';
import type { WslRunner } from './wsl.js';

/** Root-owned in the distro; checks its own arguments (resources/mount.sh). */
export const MOUNT_SCRIPT = '/opt/grunt-sandbox/mount.sh';

/** Mounts and unmounts one folder in the VM; both throw on failure. */
export interface MountRunner {
  mount(m: PlannedMount): Promise<void>;
  unmount(m: PlannedMount): Promise<void>;
}

/** mount.sh, run as root through wsl.exe --exec. */
export function wslMountRunner(runner: WslRunner): MountRunner {
  const call = async (args: string[]): Promise<void> => {
    const r = await runner.exec('root', [MOUNT_SCRIPT, ...args], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `mount.sh exited with ${String(r.code)}`);
  };
  return {
    mount: (m) => call(['mount', m.windowsPath, m.linuxPath, m.mode]),
    unmount: (m) => call(['unmount', m.windowsPath, m.linuxPath]),
  };
}

const same = (a: PlannedMount, b: PlannedMount): boolean => a.linuxPath === b.linuxPath && a.mode === b.mode;
const depth = (m: PlannedMount): number => m.linuxPath.split('/').length;
/** Whether `child` lies inside `parent` in the VM's tree (a mount on `parent` would hide it). */
const isBelow = (child: PlannedMount, parent: PlannedMount): boolean => child.linuxPath.startsWith(`${parent.linuxPath}/`);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Keeps the VM's mounts in step with the folders of the chats that have a
 * running agent (spec 2026-10-12-sandbox-design, "Folders in the VM"): only
 * those folders are mounted, read-write only while some chat needs one
 * writable. Changes are applied one at a time. A chat being set up must get
 * its mounts (`set` throws `mount_failed`); a chat going away only tries
 * (`remove` keeps a mount it couldn't remove and retries on the next change).
 */
export class MountManager {
  private readonly needs = new Map<string, MountNeed[]>();
  private current: PlannedMount[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly runner: MountRunner,
    private readonly warn: (message: string) => void = (m) => console.warn(`[sandbox] ${m}`)
  ) {}

  /** What this manager believes is mounted, parents first. */
  get mounted(): readonly PlannedMount[] {
    return this.current;
  }

  set(chatId: string, needs: MountNeed[]): Promise<void> {
    return this.serial(() => {
      this.needs.set(chatId, needs);
      return this.apply(true);
    });
  }

  remove(chatId: string): Promise<void> {
    return this.serial(() => {
      this.needs.delete(chatId);
      return this.apply(false);
    });
  }

  clear(): Promise<void> {
    return this.serial(() => {
      this.needs.clear();
      return this.apply(false);
    });
  }

  /** The distro restarted or was replaced: nothing is mounted and no chat needs anything. Touches nothing. */
  forget(): void {
    this.needs.clear();
    this.current = [];
  }

  /** Something may have dropped every mount (an agent died: `wsl --shutdown`, say): mount everything again on the next change. */
  resync(): void {
    this.current = [];
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async apply(strict: boolean): Promise<void> {
    const target = planMounts([...this.needs.values()]);
    const stale = this.current.filter((m) => !target.some((t) => same(t, m))).sort((a, b) => depth(b) - depth(a));
    for (const m of stale) {
      try {
        await this.runner.unmount(m);
        this.current = this.current.filter((c) => c !== m);
      } catch (err) {
        // A mode change needs the old mount gone before the new one goes on.
        if (strict && target.some((t) => t.linuxPath === m.linuxPath)) {
          throw new SandboxError('mount_failed', `Couldn't remount ${m.windowsPath} in the sandbox: ${messageOf(err)}`);
        }
        this.warn(`couldn't unmount ${m.linuxPath}, kept for now: ${messageOf(err)}`);
      }
    }
    const fresh = target.filter((t) => !this.current.some((c) => same(c, t))).sort((a, b) => depth(a) - depth(b));
    for (const m of fresh) {
      // Its old mode couldn't be unmounted (only when not strict): keep that one.
      if (this.current.some((c) => c.linuxPath === m.linuxPath)) continue;
      // A mount over a folder hides what is mounted inside it: take those off first, put them back after.
      const hidden = this.current.filter((c) => isBelow(c, m)).sort((a, b) => depth(b) - depth(a));
      const again = hidden.filter((h) => target.some((t) => same(t, h))).sort((a, b) => depth(a) - depth(b));
      const failure = (await this.unmountAll(hidden)) ?? (await this.mountOne(m));
      if (failure) {
        // Don't leave other chats without the folders that were taken off for it.
        await this.mountAgain(again, false);
        if (strict) throw new SandboxError('mount_failed', `Couldn't mount ${m.windowsPath} in the sandbox: ${failure}`);
        this.warn(`couldn't mount ${m.linuxPath}: ${failure}`);
        continue;
      }
      await this.mountAgain(again, strict);
    }
  }

  /** Mounts one folder and records it; the failure message, or undefined. */
  private async mountOne(m: PlannedMount): Promise<string | undefined> {
    try {
      await this.runner.mount(m);
      this.current = [...this.current, m];
      return undefined;
    } catch (err) {
      return messageOf(err);
    }
  }

  /** Unmounts these (deepest first) so a parent can go on top; stops at the first that won't go and says why. */
  private async unmountAll(hidden: PlannedMount[]): Promise<string | undefined> {
    for (const h of hidden) {
      try {
        await this.runner.unmount(h);
        this.current = this.current.filter((c) => c !== h);
      } catch (err) {
        return `${h.linuxPath} is in the way: ${messageOf(err)}`;
      }
    }
    return undefined;
  }

  /** Puts back (parents first) the mounts a parent went over, skipping any that never came off. */
  private async mountAgain(mounts: PlannedMount[], strict: boolean): Promise<void> {
    for (const m of mounts) {
      if (this.current.some((c) => same(c, m))) continue;
      const failure = await this.mountOne(m);
      if (!failure) continue;
      if (strict) throw new SandboxError('mount_failed', `Couldn't mount ${m.windowsPath} in the sandbox again: ${failure}`);
      this.warn(`couldn't mount ${m.linuxPath} again: ${failure}`);
    }
  }
}
