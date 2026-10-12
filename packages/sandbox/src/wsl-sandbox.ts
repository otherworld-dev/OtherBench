import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normaliseWindowsPath, SandboxPathError, toSandboxPath, type MountNeed } from '@grunt/core/domain/sandbox-paths.js';
import { SandboxError, type Sandbox, type SandboxRunRequest, type SandboxRunResult, type SandboxStatus, type StoredSandboxState } from '@grunt/core/ports/sandbox.js';
import type { ResolvedFolder } from '@grunt/core/types/workspace.js';
import { channelFromProcess } from './agent-channel.js';
import { AgentClient, type AgentOutcome } from './agent-client.js';
import { AgentPool, type AgentPoolOptions } from './agent-pool.js';
import { MountManager, wslMountRunner, type MountRunner } from './mounts.js';
import { runSelfTest, selfTestCases } from './selftest.js';
import { distroNames, INSTALL_DIR, installExtraPackages, runSetup, SETUP_STEPS, type SetupStep } from './setup.js';
import { DISTRO, type WslRunner } from './wsl.js';

export const AGENT_ARGV = [`${INSTALL_DIR}/node/bin/node`, `${INSTALL_DIR}/agent.mjs`];
export const SELF_TEST_CHAT = '__selftest__';
const MAX_LOG_LINES = 200;
/** The longest host name DNS allows: anything longer the sandbox refuses without asking. */
const MAX_HOST_CHARS = 253;
const NOT_STARTED = 'The turn was cancelled before this command started, so it was not run.';
const MIRRORED_WARNING =
  "WSL's mirrored networking is on (networkingMode=mirrored in your .wslconfig), so a command that broke out of the inner sandbox could reach services on this machine that only listen locally, Grunt's own API among them.";

/** Where the sandbox's state is kept: app_setting key `sandbox` (the server wires it). */
export interface StateStore {
  get(): StoredSandboxState | null;
  set(state: StoredSandboxState): void;
}

export interface WslSandboxOptions {
  runner: WslRunner;
  /** Grunt's sandbox resource folder (resources.ts). Called by setup, so a missing folder fails setup rather than Grunt's start. */
  resourcesDir: () => string;
  state: StateStore;
  machineName: () => string;
  /** The port Grunt serves on, for the self-test's "Grunt's own API is unreachable" check; null when not known. */
  gruntPort: () => number | null;
  /** A folder of Grunt's for the self-test's read-only and read-write folders. */
  selfTestDir: string;
  /** A folder's real path: its on-disk case, and a mapped drive as the UNC path it is. Defaults to realpathSync.native. */
  realpath?: (path: string) => string;
  /** The user's .wslconfig, or null. Defaults to reading %USERPROFILE%\.wslconfig. */
  readWslConfig?: () => Promise<string | null>;
  pool?: Pick<AgentPoolOptions, 'maxAgents' | 'idleMs' | 'busyWaitMs'>;
  /** Tests: start a chat's agent without wsl.exe. */
  startAgent?: (chatId: string) => AgentClient;
  /** Tests: mount without wsl.exe. */
  mountRunner?: MountRunner;
  /** Tests: the setup steps. Default SETUP_STEPS. */
  steps?: readonly SetupStep[];
}

/** A chat id as a folder name in the VM (as the Claude Code engine names a chat's scratch folder). */
export function chatDirName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function chatHome(chatId: string): string {
  return `/home/grunt/chats/${chatDirName(chatId)}`;
}

export function chatTmp(chatId: string): string {
  return `/tmp/grunt-chats/${chatDirName(chatId)}`;
}

export function mirroredNetworking(wslconfig: string | null): boolean {
  return wslconfig !== null && /^\s*networkingMode\s*=\s*mirrored\s*$/im.test(wslconfig);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Two sets of folders as one: each folder once (Windows compares paths without case), writable if either has it so. */
function unionOf(a: readonly MountNeed[], b: readonly MountNeed[]): MountNeed[] {
  const merged = new Map<string, MountNeed>();
  for (const need of [...a, ...b]) {
    const key = need.windowsPath.toLowerCase();
    const prior = merged.get(key);
    merged.set(key, { windowsPath: prior?.windowsPath ?? need.windowsPath, writable: (prior?.writable ?? false) || need.writable });
  }
  return [...merged.values()];
}

/** Resolves when `previous` has, or rejects as not started when the turn is stopped first. */
function untilTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new SandboxError('aborted', NOT_STARTED));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new SandboxError('aborted', NOT_STARTED));
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/** A chat's folders as the agent and the mounts need them. */
interface Places {
  cwd: string;
  needs: MountNeed[];
  read: string[];
  write: string[];
  denyWrite: string[];
}

/** A chat with an agent, or with a command on its way to one. */
interface ChatState {
  /**
   * Every folder its commands have had mounted since its agent started (writable if any had it so). Each
   * command mounts this plus its own, so a compare turn's read-only variant never narrows a folder its
   * writable one uses; the runtime's per-command allow and deny lists still keep each command to its own.
   */
  granted: MountNeed[];
  /** Settles when the chat's latest command has: its commands run one after another, folders and all. */
  tail: Promise<void>;
  /** Its commands between run() and their result. */
  active: number;
}

type RunInput = Pick<SandboxRunRequest, 'command' | 'timeoutMs' | 'allowedHosts' | 'signal' | 'askHost'>;

/**
 * The sandbox on Windows (spec 2026-10-12-sandbox-design §2): a Grunt-owned
 * WSL2 distro, one agent per active chat running each command under the
 * sandbox runtime, and only those chats' folders mounted. Setup, Repair and
 * a package install run as a background job whose progress status() reports.
 *
 * A chat's commands run one at a time (its agent runs them so anyway), and the
 * next one's folders are mounted only once the one before has finished: a
 * folder changing from read-only to read-write is unmounted first, which would
 * fail under a command running in it.
 */
export class WslSandbox implements Sandbox {
  private readonly mounts: MountManager;
  private readonly pool: AgentPool;
  private readonly realpath: (path: string) => string;
  private readonly chats = new Map<string, ChatState>();
  private job: Promise<void> | null = null;
  private jobLog: string[] = [];
  private removal: Promise<void> | null = null;
  /** Setup or Remove is closing every agent: the distro restarts or goes, so mounts are forgotten, not taken down one by one. */
  private resetting = false;

  constructor(private readonly opts: WslSandboxOptions) {
    this.realpath = opts.realpath ?? ((p) => realpathSync.native(p));
    this.mounts = new MountManager(opts.mountRunner ?? wslMountRunner(opts.runner));
    this.pool = new AgentPool({
      ...opts.pool,
      start:
        opts.startAgent ??
        ((chatId) => new AgentClient(channelFromProcess(opts.runner.spawn('grunt', AGENT_ARGV)), { home: chatHome(chatId), tmpRoot: chatTmp(chatId), allowedHosts: [] })),
      onClosed: (chatId) => this.agentGone(chatId),
      onDied: (chatId) => {
        // Whatever killed an agent (wsl --shutdown, sleep) may have dropped every mount.
        this.mounts.resync();
        this.agentGone(chatId);
      },
    });
  }

  async status(): Promise<SandboxStatus> {
    const stored = this.stored();
    const warnings = mirroredNetworking(await this.wslConfig()) ? { warnings: [MIRRORED_WARNING] } : {};
    const base = { packages: stored.packages, machine: this.opts.machineName(), ...warnings };
    if (this.job) return { state: 'setting_up', log: [...this.jobLog], ...base };
    if (stored.state === 'ready') {
      if (!(await this.distroExists())) {
        const detail = `The ${DISTRO} WSL distro is gone. Press Set up to make it again.`;
        this.opts.state.set({ state: 'failed', detail, packages: stored.packages });
        return { state: 'failed', detail, ...base };
      }
      return { state: 'ready', ...(stored.versions ? { versions: stored.versions } : {}), ...base };
    }
    if (stored.state === 'failed') {
      return { state: 'failed', ...(stored.detail ? { detail: stored.detail } : {}), ...(stored.log ? { log: stored.log } : {}), ...base };
    }
    return { state: 'not_set_up', ...base };
  }

  setup(): Promise<void> {
    if (this.job) return this.job;
    return this.startJob(async (log) => {
      await this.removal?.catch(() => undefined);
      await this.dropAgents();
      const packages = this.stored().packages;
      const outcome = await runSetup(
        { runner: this.opts.runner, resourcesDir: this.opts.resourcesDir(), packages, log, selfTest: () => this.selfTest(log) },
        this.opts.steps ?? SETUP_STEPS
      );
      if (!outcome.ok) return { state: 'failed', detail: `${outcome.step}: ${outcome.message}`, packages, log: [...this.jobLog] };
      return { state: 'ready', versions: outcome.versions, packages };
    });
  }

  remove(): Promise<void> {
    if (this.job) return Promise.reject(new SandboxError('busy', "The sandbox is being set up. Remove it when that's finished."));
    if (this.removal) return this.removal;
    const removal = (async () => {
      await this.dropAgents();
      const r = await this.opts.runner.wsl(['--unregister', DISTRO], { timeoutMs: 5 * 60_000 });
      if (r.code !== 0 && (await this.distroExists())) {
        throw new SandboxError('remove_failed', `Removing the ${DISTRO} distro failed: ${(r.stderr || r.stdout).trim()}`);
      }
      this.opts.state.set({ state: 'not_set_up', packages: this.stored().packages });
    })().finally(() => {
      this.removal = null;
    });
    this.removal = removal;
    return removal;
  }

  async setPackages(packages: string[]): Promise<void> {
    if (this.job) throw new SandboxError('busy', "The sandbox is being set up. Change its packages when that's finished.");
    if (this.removal) throw new SandboxError('busy', "The sandbox is being removed. Change its packages when that's finished.");
    const stored = this.stored();
    this.opts.state.set({ ...stored, packages: [...packages] });
    if (stored.state !== 'ready' || packages.length === 0) return;
    void this.startJob(async (log) => {
      await installExtraPackages(this.opts.runner, packages, log);
      return { ...this.stored(), state: 'ready' };
    });
  }

  /** Resolves when no setup or install is running (tests; the routes poll status instead). */
  idle(): Promise<void> {
    return this.job ?? Promise.resolve();
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const machine = this.opts.machineName();
    if (this.job) throw new SandboxError('not_set_up', `The sandbox on ${machine} is being set up. Try again when it's ready.`);
    if (this.removal) throw new SandboxError('not_set_up', `The sandbox on ${machine} is being removed.`);
    if (this.stored().state !== 'ready') throw new SandboxError('not_set_up', `The sandbox isn't set up on ${machine}. Set it up in Settings > Sandbox.`);
    if (req.signal.aborted) throw new SandboxError('aborted', NOT_STARTED);
    return this.runIn(req.chatId, this.places(req.workspaceRoot, req.folders, req.writable), req);
  }

  async release(chatId: string): Promise<void> {
    await this.dropChat(chatId);
    if (this.job || this.removal || this.stored().state !== 'ready') return;
    await this.removeChatFolders(chatId);
  }

  async close(): Promise<void> {
    await this.pool.closeAll();
    this.chats.clear();
    await this.mounts.clear().catch(() => undefined);
  }

  private stored(): StoredSandboxState {
    return this.opts.state.get() ?? { state: 'not_set_up', packages: [] };
  }

  private startJob(fn: (log: (line: string) => void) => Promise<StoredSandboxState>): Promise<void> {
    this.jobLog = [];
    const log = (line: string): void => {
      this.jobLog.push(line);
      if (this.jobLog.length > MAX_LOG_LINES) this.jobLog.shift();
    };
    const job = (async () => {
      await Promise.resolve(); // so `this.job` is set before anything below can finish
      try {
        this.opts.state.set(await fn(log));
      } catch (err) {
        log(`✖ ${messageOf(err)}`);
        this.opts.state.set({ ...this.stored(), state: 'failed', detail: messageOf(err), log: [...this.jobLog] });
      } finally {
        this.job = null;
      }
    })();
    this.job = job;
    return job;
  }

  /** Before setup or Remove: every agent closed, and every mount forgotten (the distro is about to restart or go). */
  private async dropAgents(): Promise<void> {
    this.resetting = true;
    try {
      await this.pool.closeAgents();
    } finally {
      this.resetting = false;
    }
    this.chats.clear();
    this.mounts.forget();
  }

  /** A chat's agent closed or died. */
  private agentGone(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (chat && chat.active > 0) {
      // A command of this chat is on its way to a new agent: its folders stay for it, and the next command starts afresh.
      chat.granted = [];
      return;
    }
    this.chatGone(chatId);
  }

  /** Nothing of this chat's is running or about to: its folders can go. */
  private chatGone(chatId: string): void {
    this.chats.delete(chatId);
    if (this.resetting) return;
    void this.mounts.remove(chatId).catch(() => undefined);
  }

  /** Closes the chat's agent and takes its folders down. */
  private async dropChat(chatId: string): Promise<void> {
    await this.pool.release(chatId);
    this.chats.delete(chatId);
    await this.mounts.remove(chatId);
  }

  /** Removes the chat's home and temp folders in the VM, as grunt (whose they are), never crossing into a mount. */
  private async removeChatFolders(chatId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(chatDirName(chatId))) return;
    await this.opts.runner.exec('grunt', ['/bin/rm', '-rf', '--one-file-system', chatHome(chatId), chatTmp(chatId)], { timeoutMs: 60_000 });
  }

  /**
   * The workspace first (the command's cwd), then each extra folder, as canonical Windows paths (real path,
   * then tidied) and their Linux paths. A folder that can't be mounted refuses this command before anything
   * is mounted. A read-only folder inside a writable one stays read-only (denyWrite; the self-test checks
   * it), but a writable folder inside a read-only one ends up read-only: the runtime binds the read-only
   * parent over the writable child.
   */
  private places(workspaceRoot: string, folders: readonly ResolvedFolder[], writable: boolean): Places {
    const entries = [{ root: workspaceRoot, writable }, ...folders.map((f) => ({ root: f.root, writable: writable && f.access === 'readwrite' }))];
    const places: Places = { cwd: '', needs: [], read: [], write: [], denyWrite: [] };
    entries.forEach((entry, i) => {
      let windowsPath: string;
      let linux: string;
      try {
        windowsPath = normaliseWindowsPath(this.realpath(entry.root));
        linux = toSandboxPath(windowsPath);
      } catch (err) {
        throw new SandboxError('bad_folder', `${entry.root} can't be used in the sandbox: ${err instanceof SandboxPathError ? err.reason : messageOf(err)}`);
      }
      if (i === 0) places.cwd = linux;
      places.needs.push({ windowsPath, writable: entry.writable });
      places.read.push(linux);
      (entry.writable ? places.write : places.denyWrite).push(linux);
    });
    return places;
  }

  private async runIn(chatId: string, places: Places, input: RunInput): Promise<SandboxRunResult> {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { granted: [], tail: Promise.resolve(), active: 0 };
      this.chats.set(chatId, chat);
    }
    const mine = chat;
    mine.active += 1;
    const previous = mine.tail;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    mine.tail = previous.then(() => done);
    let outcome: AgentOutcome;
    try {
      await untilTurn(previous, input.signal);
      const needs = unionOf(mine.granted, places.needs);
      await this.mounts.set(chatId, needs);
      mine.granted = needs;
      outcome = await this.pool.run(chatId, {
        command: input.command,
        cwd: places.cwd,
        timeoutMs: input.timeoutMs,
        readPaths: places.read,
        writePaths: places.write,
        denyWritePaths: places.denyWrite,
        allowedHosts: input.allowedHosts,
        signal: input.signal,
        askHost: (host, port, askSignal) => (host.length > MAX_HOST_CHARS ? Promise.resolve(false) : input.askHost(host, port, askSignal)),
      });
    } finally {
      finished();
      mine.active -= 1;
      // No agent for this chat (it didn't start, or it went) means nothing would ever take its folders down.
      // A chat released meanwhile has no entry: its folders go too. One that started afresh has a new entry, which keeps them.
      if (mine.active === 0 && !this.pool.has(chatId) && (this.chats.get(chatId) ?? mine) === mine) this.chatGone(chatId);
    }
    return { command: input.command, ...outcome, timeoutMsUsed: input.timeoutMs, sandbox: true, cwd: places.cwd };
  }

  /** The self-test (spec §4) through the real agent and mounts, as a chat of its own. */
  private async selfTest(log: (line: string) => void): Promise<void> {
    const dir = this.opts.selfTestDir;
    const ro = join(dir, 'ro');
    const rw = join(dir, 'rw');
    const locked = join(rw, 'locked');
    await mkdir(ro, { recursive: true });
    await mkdir(locked, { recursive: true });
    await writeFile(join(ro, 'hello.txt'), 'hello from Grunt\n');
    const route = await this.opts.runner.exec('root', ['/usr/sbin/ip', 'route', 'show', 'default'], { timeoutMs: 30_000 });
    const gateway = /default via (\S+)/.exec(route.stdout)?.[1] ?? null;
    const gruntPort = this.opts.gruntPort();
    if (gateway === null || gruntPort === null) {
      log(`(skipping the check on Grunt's own port: ${gateway === null ? 'the distro has no default route' : "Grunt's port isn't known"})`);
    }
    const places = this.places(rw, [{ root: ro, access: 'read' }, { root: locked, access: 'read' }], true);
    const [rwLinux, roLinux, lockedLinux] = places.read as [string, string, string];
    const cases = selfTestCases({ rwLinux, roLinux, lockedLinux, gateway, gruntPort });
    try {
      await runSelfTest(
        cases,
        (c) =>
          this.runIn(SELF_TEST_CHAT, places, {
            command: c.command,
            timeoutMs: 60_000,
            allowedHosts: c.allowedHosts,
            signal: new AbortController().signal,
            askHost: async (host) => {
              log(`(the sandbox asked about ${host}: refused)`);
              return false;
            },
          }),
        log
      );
    } finally {
      await this.dropChat(SELF_TEST_CHAT).catch(() => undefined);
      await this.removeChatFolders(SELF_TEST_CHAT);
    }
  }

  private async wslConfig(): Promise<string | null> {
    if (this.opts.readWslConfig) return this.opts.readWslConfig();
    return readFile(join(homedir(), '.wslconfig'), 'utf8').catch(() => null);
  }

  private async distroExists(): Promise<boolean> {
    const list = await this.opts.runner.wsl(['--list', '--quiet'], { timeoutMs: 30_000 });
    return distroNames(list.stdout).some((n) => n.toLowerCase() === DISTRO);
  }
}
