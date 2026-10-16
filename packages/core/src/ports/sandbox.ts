import type { FsMode } from '../types/config.js';
import type { ResolvedFolder } from '../types/workspace.js';

/**
 * The sandbox port (spec 2026-10-12-sandbox-design §1): where a profile's
 * shell commands run when its `shellRuns` is 'sandbox'. On Windows it is a
 * OtherBench-owned WSL2 distro with Anthropic's sandbox runtime inside
 * (`@otherbench/sandbox`'s WslSandbox); elsewhere it refuses (UnsupportedSandbox).
 * Only `@otherbench/tools`' sandboxed `run_command` calls `run`, and only after
 * the PermissionBroker has allowed the call.
 */

/** The versions inside a ready sandbox, for Settings > Sandbox. */
export interface SandboxVersions {
  distro: string;
  runtime: string;
  node: string;
}

export type SandboxState = 'unsupported' | 'not_set_up' | 'setting_up' | 'ready' | 'failed';

export interface SandboxStatus {
  state: SandboxState;
  /** Why it is unsupported or failed ("<step>: <message>" for a failed setup); on a ready sandbox, why the last package install failed. */
  detail?: string;
  versions?: SandboxVersions;
  /** Progress lines of the running setup or install, or of the last failed one; newest last, at most 200. */
  log?: string[];
  /** Extra apt packages Settings asked for. */
  packages: string[];
  /** Things the user should know, e.g. that WSL's mirrored networking is on. */
  warnings?: string[];
  /** This machine's name, for "The sandbox isn't set up on <machine>." */
  machine: string;
}

/** What WslSandbox keeps in `app_setting` under SANDBOX_SETTING_KEY (machine-local, never synced). */
export interface StoredSandboxState {
  state: 'not_set_up' | 'ready' | 'failed';
  detail?: string;
  versions?: SandboxVersions;
  packages: string[];
  log?: string[];
}

export const SANDBOX_SETTING_KEY = 'sandbox';

/** True for a value that has the shape of a StoredSandboxState (it comes back from the database as JSON). */
export function isStoredSandboxState(value: unknown): value is StoredSandboxState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const state = v['state'];
  const packages = v['packages'];
  return (
    (state === 'not_set_up' || state === 'ready' || state === 'failed') &&
    Array.isArray(packages) &&
    packages.every((p) => typeof p === 'string')
  );
}

/**
 * A file access as the sandbox reads it, failing closed: 'read' and 'readwrite' are themselves, and anything else
 * (a value from a newer peer's synced profile, a typo, nothing) is 'off', so it gets no folders.
 */
export function sandboxFileAccess(fs: unknown): FsMode {
  return fs === 'read' || fs === 'readwrite' ? fs : 'off';
}

export interface SandboxRunRequest {
  chatId: string;
  command: string;
  /** Already clamped by the tool (120 s default, 600 s cap). */
  timeoutMs: number;
  /**
   * The profile's file access (`ToolPolicy.fs`), which decides which of the chat's folders the command gets:
   *  - 'off': none. The sandbox mounts nothing for the command and allows it no folder of the chat's, whatever
   *    `workspaceRoot` and `folders` say (they are ignored), and whatever an earlier command of the chat had
   *    mounted. It sees only its own home and temp folder, and starts in its home.
   *  - 'read': the workspace and every extra folder, read-only.
   *  - 'readwrite': the workspace, and the extra folders the chat made read-write, writable.
   * The chat's home and the command's temp folder are writable in every mode.
   */
  fs: FsMode;
  /** The chat's workspace on this machine; the command starts in its sandbox path. Null only with fs 'off' (a sandbox refuses it otherwise). */
  workspaceRoot: string | null;
  /** The chat's extra folders on this machine. */
  folders: ResolvedFolder[];
  allowedHosts: string[];
  signal: AbortSignal;
  /**
   * A host not on the allowlist: raises the `sandbox_network` card; resolves whether the connection may go ahead.
   * `signal` aborts when the question stops mattering (the turn was stopped, the command ended, the sandbox went
   * away): take the card down then; any answer is ignored.
   */
  askHost(host: string, port: number | undefined, signal?: AbortSignal): Promise<boolean>;
}

/** What `run_command` returns on the host, plus `sandbox: true` and the Linux `cwd` (the chat's home with fs 'off'). */
export interface SandboxRunResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  timeoutMsUsed: number;
  output: string;
  sandbox: true;
  cwd: string;
}

export const SANDBOX_MAX_OUTPUT_BYTES = 100 * 1024;

export type SandboxErrorCode = 'unsupported' | 'not_set_up' | 'busy' | 'bad_folder' | 'mount_failed' | 'agent_failed' | 'remove_failed' | 'aborted' | 'bad_package';

/** A refusal or failure the tool turns into a tool error with this code. */
export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** By name and code rather than `instanceof`, so an error from another copy of core still counts. */
export function isSandboxError(err: unknown): err is SandboxError {
  return err instanceof Error && err.name === 'SandboxError' && typeof (err as { code?: unknown }).code === 'string';
}

export interface Sandbox {
  status(): Promise<SandboxStatus>;
  /** Sets up or repairs (re-runs every step). Resolves when done; a failure lands in status(). Never rejects, except UnsupportedSandbox, which refuses with SandboxError('unsupported'). A second call while one runs gets the same run. */
  setup(): Promise<void>;
  /** Unregisters the distro. Rejects with a SandboxError while setup runs or when it can't. */
  remove(): Promise<void>;
  /** Stores the extra packages and, when ready, starts installing them (progress in status()). Rejects with a SandboxError while setup runs. */
  setPackages(packages: string[]): Promise<void>;
  /**
   * Runs one command for a chat. Rejects with a SandboxError when it can't run at all. The implementation, not
   * the caller, keeps a command with fs 'off' away from every folder of the chat's (see SandboxRunRequest.fs).
   */
  run(req: SandboxRunRequest): Promise<SandboxRunResult>;
  /** The chat was deleted: close its agent, drop its mounts, remove its home folder in the VM. */
  release(chatId: string): Promise<void>;
  /** OtherBench is stopping: close every agent and unmount. */
  close(): Promise<void>;
}
