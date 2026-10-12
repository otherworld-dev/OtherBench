import { planMounts, toSandboxPath, type MountNeed, type PlannedMount } from '@grunt/core/domain/sandbox-paths.js';
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

/** Same folder, or one inside the other (the VM's paths are matched without case, like Windows'). */
function overlaps(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** A plan with every read-write mount the `ceiling` plan doesn't also have read-write made read-only. */
function narrowed(plan: PlannedMount[], ceiling: PlannedMount[]): PlannedMount[] {
  return plan.map((m): PlannedMount => (m.mode === 'rw' && !ceiling.some((c) => c.linuxPath === m.linuxPath && c.mode === 'rw') ? { ...m, mode: 'ro' } : m));
}

interface ApplyOptions {
  /** The VM paths of the chat being set up (strict only): a stale read-write mount overlapping them that won't unmount refuses the chat. */
  mine?: string[];
  /** After a refused set(): never mount read-write anything this plan doesn't have read-write. */
  ceiling?: PlannedMount[];
}

/**
 * Keeps the VM's mounts in step with the folders of the chats that have a
 * running agent (spec 2026-10-12-sandbox-design, "Folders in the VM"): only
 * those folders are mounted, read-write only while some chat needs one
 * writable. Changes are applied one at a time.
 *
 * It fails closed. A chat being set up must get exactly its mounts: `set`
 * throws `mount_failed` otherwise, forgets that chat's new request (its
 * earlier needs stay, and are put back on a best-effort basis, never wider
 * than what was just asked), and a stale read-write mount that overlaps the
 * chat's folders and won't unmount refuses it too. A stale mount elsewhere only
 * warns: the sandbox runtime's per-command allow/deny lists stay the second
 * wall. A chat going away only tries (`remove` keeps a mount it couldn't
 * remove and retries on the next change).
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
    return this.serial(async () => {
      const previous = this.needs.get(chatId);
      this.needs.set(chatId, needs);
      try {
        await this.apply(true, { mine: needs.map((n) => toSandboxPath(n.windowsPath)) });
      } catch (err) {
        // This chat gets no run, so its new folders must not be mounted for the sake of other changes.
        const attempted = this.plan();
        if (previous) this.needs.set(chatId, previous);
        else this.needs.delete(chatId);
        try {
          await this.apply(false, { ceiling: attempted });
        } catch (again) {
          this.warn(`couldn't restore the mounts after a refused change: ${messageOf(again)}`);
        }
        throw err;
      }
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

  /** The plan for every chat's needs, or nothing at all if it can't be made. */
  private plan(): PlannedMount[] {
    try {
      return planMounts([...this.needs.values()]);
    } catch {
      return [];
    }
  }

  private async apply(strict: boolean, opts: ApplyOptions = {}): Promise<void> {
    const planned = planMounts([...this.needs.values()]);
    const target = opts.ceiling ? narrowed(planned, opts.ceiling) : planned;

    // Take off what is mounted but no longer (or differently) wanted, deepest first.
    const stale = this.current.filter((m) => !target.some((t) => same(t, m))).sort((a, b) => depth(b) - depth(a));
    for (const m of stale) {
      // A mount can't come off while another is mounted inside it: lift the wanted ones, they go back below.
      const inside = this.current.filter((c) => isBelow(c, m)).sort((a, b) => depth(b) - depth(a));
      const failure = (await this.unmountAll(inside)) ?? (await this.unmountOne(m));
      if (!failure) continue;
      // A mode change needs the old mount gone before the new one goes on, and a wider mount than planned
      // must not sit under this chat's folders.
      const remount = target.some((t) => t.linuxPath === m.linuxPath);
      const widerThanPlanned = m.mode === 'rw' && (opts.mine ?? []).some((p) => overlaps(p, m.linuxPath));
      if (strict && (remount || widerThanPlanned)) {
        throw new SandboxError('mount_failed', `Couldn't ${remount ? 'remount' : 'take off'} ${m.windowsPath} in the sandbox: ${failure}`);
      }
      this.warn(`couldn't unmount ${m.linuxPath}, kept for now: ${failure}`);
    }

    // Put on what is wanted and missing, parents first (the ones lifted above come back here).
    const skipped = new Set<string>();
    for (;;) {
      const m = target
        .filter((t) => !this.current.some((c) => same(c, t)) && !skipped.has(t.linuxPath))
        .sort((a, b) => depth(a) - depth(b))[0];
      if (!m) break;
      skipped.add(m.linuxPath);
      // Its old mode couldn't be unmounted (only when not strict): keep that one.
      if (this.current.some((c) => c.linuxPath === m.linuxPath)) continue;
      // A mount over a folder hides what is mounted inside it: lift those, they come back in a later turn of this loop.
      const hidden = this.current.filter((c) => isBelow(c, m)).sort((a, b) => depth(b) - depth(a));
      const failure = (await this.unmountAll(hidden)) ?? (await this.mountOne(m));
      if (!failure) {
        // Mounted: anything lifted for it is wanted again, and may be tried.
        for (const h of hidden) skipped.delete(h.linuxPath);
        continue;
      }
      if (strict) throw new SandboxError('mount_failed', `Couldn't mount ${m.windowsPath} in the sandbox: ${failure}`);
      this.warn(`couldn't mount ${m.linuxPath}: ${failure}`);
    }
  }

  /** Mounts one folder and records it. The failure message, or undefined. */
  private async mountOne(m: PlannedMount): Promise<string | undefined> {
    try {
      await this.runner.mount(m);
      this.current = [...this.current, m];
      return undefined;
    } catch (err) {
      return messageOf(err);
    }
  }

  /** Unmounts one folder and forgets it. The failure message, or undefined. */
  private async unmountOne(m: PlannedMount): Promise<string | undefined> {
    try {
      await this.runner.unmount(m);
      this.current = this.current.filter((c) => c !== m);
      return undefined;
    } catch (err) {
      return messageOf(err);
    }
  }

  /** Unmounts these in order (deepest first); stops at the first that won't go and says why. */
  private async unmountAll(mounts: PlannedMount[]): Promise<string | undefined> {
    for (const m of mounts) {
      const failure = await this.unmountOne(m);
      if (failure) return `${m.linuxPath} is in the way: ${failure}`;
    }
    return undefined;
  }
}
