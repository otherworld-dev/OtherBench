import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sandboxHostProblem } from '@grunt/core/domain/network-hosts.js';
import { normaliseWindowsPath, SandboxPathError, toSandboxPath, type MountNeed } from '@grunt/core/domain/sandbox-paths.js';
import { SandboxError, type Sandbox, type SandboxRunRequest, type SandboxRunResult, type SandboxStatus, type StoredSandboxState } from '@grunt/core/ports/sandbox.js';
import type { ResolvedFolder } from '@grunt/core/types/workspace.js';
import { channelFromProcess } from './agent-channel.js';
import { AgentClient, type AgentOutcome } from './agent-client.js';
import { AgentPool, type AgentPoolOptions } from './agent-pool.js';
import { MountManager, wslMountRunner, type MountRunner } from './mounts.js';
import { PROTECTED_PROBES, runSelfTest, selfTestCases } from './selftest.js';
import { distroNames, INSTALL_DIR, installExtraPackages, isAptPackageName, notAnAptPackageName, runSetup, SETUP_STEPS, type SetupStep } from './setup.js';
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

/** A ready state, without what an earlier failed package install left in detail and log. */
function readyState(s: StoredSandboxState): StoredSandboxState {
  return { state: 'ready', packages: s.packages, ...(s.versions ? { versions: s.versions } : {}) };
}

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

/**
 * The allowlist as the runtime gets it: trimmed, lower-cased, and only entries core's rule takes. A profile
 * synced from a peer never went through the routes' checks, and the runtime lets an allowlisted IP literal
 * (or localhost) through without judging where it leads, so one of those is dropped here, not handed over.
 */
export function runtimeHosts(hosts: readonly string[]): string[] {
  const names = hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== '' && sandboxHostProblem(h) === null);
  return [...new Set(names)];
}

/** Whether canonical Windows path `inner` is `outer` or lies inside it, compared as Windows does (without case). */
function isSameOrInside(inner: string, outer: string): boolean {
  const i = inner.toLowerCase();
  const o = outer.toLowerCase();
  return i === o || i.startsWith(o.endsWith('\\') ? o : `${o}\\`);
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
  /** Counts the chat's agents going away, so a command that was mounting meanwhile doesn't put back the old `granted`. */
  epoch: number;
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
  /** The writable folders (canonical Windows paths) of each command running now; see writeTurn. */
  private readonly writing = new Set<{ keys: string[]; finished: Promise<void> }>();
  private job: Promise<void> | null = null;
  private jobLog: string[] = [];
  private removal: Promise<void> | null = null;
  /** Setup or Remove is closing every agent: the distro restarts or goes, so mounts are forgotten, not taken down one by one. */
  private resetting = false;
  /** close() has run: Grunt is stopping. */
  private closed = false;

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
    // A detail and log on a ready sandbox say why the last package install failed.
    const report = { ...(stored.detail ? { detail: stored.detail } : {}), ...(stored.log ? { log: stored.log } : {}) };
    if (stored.state === 'ready') {
      // While a Remove runs the distro is expected to go: that isn't a failure.
      if (!this.removal && (await this.distroExists()) === false) {
        // The answer took a while: only a sandbox still ready, with nothing running on it, is marked failed.
        if (this.job || this.removal || this.stored().state !== 'ready') return this.status();
        const detail = `The ${DISTRO} WSL distro is gone. Press Set up to make it again.`;
        this.opts.state.set({ state: 'failed', detail, packages: stored.packages });
        return { state: 'failed', detail, ...base };
      }
      return { state: 'ready', ...(stored.versions ? { versions: stored.versions } : {}), ...report, ...base };
    }
    if (stored.state === 'failed') return { state: 'failed', ...report, ...base };
    return { state: 'not_set_up', ...base };
  }

  setup(): Promise<void> {
    if (this.job) return this.job;
    return this.startJob(async (log) => {
      await this.removal?.catch(() => undefined);
      // Overwritten by the outcome; if Grunt stops first, the sandbox isn't left looking ready.
      this.opts.state.set({ state: 'failed', detail: 'Setup was interrupted.', packages: this.stored().packages });
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
      // Removed only when the list says so: a list that couldn't be read proves nothing.
      if (r.code !== 0 && (await this.distroExists()) !== false) {
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
    // Setup installs the list as root, so a name apt would read as an option never gets stored.
    const bad = packages.find((p) => !isAptPackageName(p));
    if (bad !== undefined) throw new SandboxError('bad_package', notAnAptPackageName(bad));
    const stored = this.stored();
    // On a ready sandbox a new list also clears what an earlier failed install left in detail and log.
    this.opts.state.set({ ...(stored.state === 'ready' ? readyState(stored) : stored), packages: [...packages] });
    if (stored.state !== 'ready' || packages.length === 0) return;
    // A failed install leaves the sandbox ready (what was there still works) and says why in detail and log.
    void this.startJob(async (log) => {
      try {
        await installExtraPackages(this.opts.runner, packages, log);
        return readyState(this.stored());
      } catch (err) {
        const detail = `Installing packages: ${messageOf(err)}`;
        log(`✖ ${detail}`);
        return { ...readyState(this.stored()), detail, log: [...this.jobLog] };
      }
    });
  }

  /** Resolves when no setup or install is running (tests; the routes poll status instead). */
  idle(): Promise<void> {
    return this.job ?? Promise.resolve();
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.refuseIfBusy();
    if (this.stored().state !== 'ready') throw new SandboxError('not_set_up', `The sandbox isn't set up on ${this.opts.machineName()}. Set it up in Settings > Sandbox.`);
    if (req.signal.aborted) throw new SandboxError('aborted', NOT_STARTED);
    return this.runIn(req.chatId, this.places(req.workspaceRoot, req.folders, req.writable), req);
  }

  async release(chatId: string): Promise<void> {
    await this.dropChat(chatId);
    if (this.job || this.removal || this.stored().state !== 'ready') return;
    await this.removeChatFolders(chatId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pool.closeAll();
    this.chats.clear();
    await this.mounts.clear().catch(() => undefined);
  }

  private stored(): StoredSandboxState {
    return this.opts.state.get() ?? { state: 'not_set_up', packages: [] };
  }

  /** Refuses a chat's command while Grunt is stopping, or the sandbox is being set up or removed. */
  private refuseIfBusy(): void {
    if (this.closed) throw new SandboxError('agent_failed', 'The sandbox is shutting down.');
    const machine = this.opts.machineName();
    if (this.job) throw new SandboxError('not_set_up', `The sandbox on ${machine} is being set up. Try again when it's ready.`);
    if (this.removal) throw new SandboxError('not_set_up', `The sandbox on ${machine} is being removed.`);
  }

  /**
   * Refuses a command that waited (for the chat's previous command, or for its mounts) while the chat was
   * released or its agents were closed for setup or Remove (its ChatState is no longer the chat's), or while
   * the sandbox started being set up or removed. Without this it would start a fresh agent for it.
   */
  private refuseIfStale(chatId: string, mine: ChatState, selfTest: boolean): void {
    // The self-test runs inside the setup job, so only Grunt stopping refuses it.
    if (!selfTest) this.refuseIfBusy();
    else if (this.closed) throw new SandboxError('agent_failed', 'The sandbox is shutting down.');
    if (this.chats.get(chatId) !== mine) throw new SandboxError('aborted', "The chat's sandbox was closed before this command started, so it was not run.");
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
      chat.epoch += 1;
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
    // First, so a command of the chat that gets past its wait while the agent closes (the agent reports the
    // running command done before it exits) is refused rather than starting a fresh agent.
    this.chats.delete(chatId);
    await this.pool.release(chatId);
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
   * is mounted. So does a read-only folder inside a writable one (or the same folder): the runtime's
   * read-only bind sits on its exact spelling, and Windows folders in the VM ignore case, so `RO/x` would
   * reach it through the writable parent. A writable folder inside a read-only one ends up read-only (the
   * runtime binds the read-only parent over the writable child), which is narrower, not wider.
   */
  private places(workspaceRoot: string, folders: readonly ResolvedFolder[], writable: boolean): Places {
    const entries = [{ root: workspaceRoot, writable }, ...folders.map((f) => ({ root: f.root, writable: writable && f.access === 'readwrite' }))];
    const places: Places = { cwd: '', needs: [], read: [], write: [], denyWrite: [] };
    const resolved = entries.map((entry) => {
      try {
        const windowsPath = normaliseWindowsPath(this.realpath(entry.root));
        return { ...entry, windowsPath, linux: toSandboxPath(windowsPath) };
      } catch (err) {
        throw new SandboxError('bad_folder', `${entry.root} can't be used in the sandbox: ${err instanceof SandboxPathError ? err.reason : messageOf(err)}`);
      }
    });
    for (const inner of resolved) {
      if (inner.writable) continue;
      const outer = resolved.find((o) => o.writable && isSameOrInside(inner.windowsPath, o.windowsPath));
      if (outer) {
        throw new SandboxError(
          'bad_folder',
          `${inner.root} is read-only but sits inside the writable ${outer.root}; the sandbox can't keep it read-only. Make it a separate folder, or make the parent read-only.`
        );
      }
    }
    resolved.forEach((entry, i) => {
      if (i === 0) places.cwd = entry.linux;
      places.needs.push({ windowsPath: entry.windowsPath, writable: entry.writable });
      places.read.push(entry.linux);
      (entry.writable ? places.write : places.denyWrite).push(entry.linux);
    });
    return places;
  }

  private async runIn(chatId: string, places: Places, input: RunInput, selfTest = false): Promise<SandboxRunResult> {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { granted: [], tail: Promise.resolve(), active: 0, epoch: 0 };
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
      this.refuseIfStale(chatId, mine, selfTest);
      const epoch = mine.epoch;
      const needs = unionOf(mine.granted, places.needs);
      await this.mounts.set(chatId, needs);
      // The agent went while mounting: the next one starts from this command's folders alone.
      mine.granted = mine.epoch === epoch ? needs : places.needs;
      this.refuseIfStale(chatId, mine, selfTest);
      const writing = await this.writeTurn(places, input.signal);
      try {
        this.refuseIfStale(chatId, mine, selfTest);
        outcome = await this.pool.run(chatId, {
          command: input.command,
          cwd: places.cwd,
          timeoutMs: input.timeoutMs,
          readPaths: places.read,
          writePaths: places.write,
          denyWritePaths: places.denyWrite,
          allowedHosts: runtimeHosts(input.allowedHosts),
          signal: input.signal,
          askHost: (host, port, askSignal) => (host.length > MAX_HOST_CHARS ? Promise.resolve(false) : input.askHost(host, port, askSignal)),
        });
      } finally {
        writing.done();
      }
    } finally {
      finished();
      mine.active -= 1;
      // No agent for this chat (it didn't start, or it went) means nothing would ever take its folders down.
      // A chat released meanwhile has no entry: its folders go too. One that started afresh has a new entry, which keeps them.
      if (mine.active === 0 && !this.pool.has(chatId) && (this.chats.get(chatId) ?? mine) === mine) this.chatGone(chatId);
    }
    return { command: input.command, ...outcome, timeoutMsUsed: input.timeoutMs, sandbox: true, cwd: places.cwd };
  }

  /**
   * Waits until no other command that can write any of this command's writable folders (the same folder, or
   * one inside the other) is running, then holds them until `done()`. Each chat's agent copies the protected
   * files of the folders its command can write and puts them back afterwards; two commands in the same
   * folder at once would each copy what the other planted and put it back. Rejects as not started when the
   * turn is stopped while waiting.
   */
  private async writeTurn(places: Places, signal: AbortSignal): Promise<{ done: () => void }> {
    const keys = places.needs.filter((n) => n.writable).map((n) => n.windowsPath);
    if (keys.length === 0) return { done: () => undefined };
    const clashes = (): Promise<void>[] =>
      [...this.writing].filter((w) => w.keys.some((a) => keys.some((b) => isSameOrInside(a, b) || isSameOrInside(b, a)))).map((w) => w.finished);
    for (let busy = clashes(); busy.length > 0; busy = clashes()) await untilTurn(Promise.all(busy).then(() => undefined), signal);
    let done!: () => void;
    const entry = { keys, finished: new Promise<void>((resolve) => (done = resolve)) };
    this.writing.add(entry);
    return {
      done: () => {
        this.writing.delete(entry);
        done();
      },
    };
  }

  /** The self-test (spec §4) through the real agent and mounts, as a chat of its own. */
  private async selfTest(log: (line: string) => void): Promise<void> {
    const dir = this.opts.selfTestDir;
    const ro = join(dir, 'ro');
    const rw = join(dir, 'rw');
    await mkdir(ro, { recursive: true });
    await writeFile(join(ro, 'hello.txt'), 'hello from Grunt\n');
    // The folders of the protected files the self-test writes (so a write is refused by the sandbox, not by a
    // missing folder), with nothing an earlier self-test may have left in them.
    for (const rel of PROTECTED_PROBES) {
      await mkdir(join(rw, rel, '..'), { recursive: true });
      await rm(join(rw, rel), { recursive: true, force: true });
    }
    await rm(join(ro, 'nope.txt'), { force: true });
    const route = await this.opts.runner.exec('root', ['/usr/sbin/ip', 'route', 'show', 'default'], { timeoutMs: 30_000 });
    const gateway = /default via (\S+)/.exec(route.stdout)?.[1] ?? null;
    const gruntPort = this.opts.gruntPort();
    if (gateway === null || gruntPort === null) {
      log(`(skipping the check on Grunt's own port: ${gateway === null ? 'the distro has no default route' : "Grunt's port isn't known"})`);
    }
    const places = this.places(rw, [{ root: ro, access: 'read' }], true);
    const [rwLinux, roLinux] = places.read as [string, string];
    const cases = selfTestCases({ rwLinux, roLinux, gateway, gruntPort });
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
          }, true),
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

  /** Whether the distro is registered; null when WSL couldn't say (wsl.exe timed out or didn't start). */
  private async distroExists(): Promise<boolean | null> {
    const list = await this.opts.runner.wsl(['--list', '--quiet'], { timeoutMs: 30_000 });
    if (list.timedOut || list.code === null) return null;
    return distroNames(list.stdout).some((n) => n.toLowerCase() === DISTRO);
  }
}
