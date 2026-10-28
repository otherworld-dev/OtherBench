import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildChildEnv } from '@otherbench/engine-claude-code/env.js';
import type { ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { Connection } from '@otherbench/core/types/config.js';

/** What the CLI says about an account's login. Only these three fields are kept: no token ever leaves the CLI. */
export interface LoginStatus {
  signedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
}

const STATUS_TIMEOUT_MS = 15_000;
const STATUS_CACHE_MS = 60_000;
/** How long a failed status read is answered from memory, so a stuck CLI isn't started again on every poll. */
const FAILED_STATUS_CACHE_MS = 15_000;
const LOGIN_LIFETIME_MS = 10 * 60_000;
/** How long `signIn` waits for the CLI to print its sign-in link before answering without one. */
const URL_WAIT_MS = 20_000;
const SIGN_IN_URL = /visit:\s*(https:\/\/\S+)/;

/** The Claude Code CLI bundled with the Agent SDK for this platform. */
export function bundledCliPath(): string {
  const pkg = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
  return join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
}

interface Login {
  child: ChildProcess;
  url: string | null;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Signs Claude accounts in and out, and reads who is signed in, by running the
 * bundled Claude Code CLI (`auth status|login|logout`) with the account's
 * `CLAUDE_CONFIG_DIR`. The environment comes from `buildChildEnv`, so no
 * `ANTHROPIC_*` credential reaches the CLI.
 */
export class ClaudeLoginRunner {
  private readonly spawnFn: typeof nodeSpawn;
  private readonly cliPath: () => string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: LoginStatus }>();
  /** The status read running per account: calls made while it runs share it. */
  private readonly reading = new Map<string, Promise<LoginStatus>>();
  /** The last status read that failed, per account, until a read succeeds or the account's status is forgotten. */
  private readonly failed = new Map<string, { at: number; error: unknown }>();
  private readonly logins = new Map<string, Login>();
  /** Every child still running (logins, status reads, logouts), so `dispose` can end them. */
  private readonly live = new Set<ChildProcess>();

  constructor(deps: { spawn?: typeof nodeSpawn; cliPath?: () => string; baseEnv?: NodeJS.ProcessEnv; now?: () => number } = {}) {
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.cliPath = deps.cliPath ?? bundledCliPath;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.now = deps.now ?? Date.now;
  }

  /**
   * `auth status --json`, cached 60 s per account. Rejects when the CLI fails,
   * can't be parsed, or takes over 15 s; that failure is given again for 15 s
   * without running the CLI. Calls made while a read runs share it.
   */
  async status(account: ClaudeAccountRef): Promise<LoginStatus> {
    const slug = account.slug;
    const hit = this.cache.get(slug);
    if (hit && this.now() - hit.at < STATUS_CACHE_MS) return hit.value;
    const failed = this.failed.get(slug);
    if (failed && this.now() - failed.at < FAILED_STATUS_CACHE_MS) throw failed.error;
    const running = this.reading.get(slug);
    if (running) return running;
    const read: Promise<LoginStatus> = this.readStatus(account).then(
      (value) => {
        // Kept only while this is still the account's read: a sign-in or sign-out since forgot it.
        if (this.reading.get(slug) === read) {
          this.cache.set(slug, { at: this.now(), value });
          this.failed.delete(slug);
        }
        return value;
      },
      (error: unknown) => {
        if (this.reading.get(slug) === read) this.failed.set(slug, { at: this.now(), error });
        throw error;
      }
    );
    this.reading.set(slug, read);
    try {
      return await read;
    } finally {
      if (this.reading.get(slug) === read) this.reading.delete(slug);
    }
  }

  /**
   * What the last status read said of the account's login, however old:
   * true or false, or null when it hasn't been read (or was forgotten by a
   * sign-in or sign-out). Synchronous, for picking an account to move a chat to.
   */
  cachedSignedIn(slug: string): boolean | null {
    return this.cache.get(slug)?.value.signedIn ?? null;
  }

  private async readStatus(account: ClaudeAccountRef): Promise<LoginStatus> {
    const { stdout } = await this.run(account, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS, true);
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new Error('Claude Code gave an unreadable sign-in status.');
    }
    const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const signedIn = o['loggedIn'] === true;
    return {
      signedIn,
      email: signedIn && typeof o['email'] === 'string' ? o['email'] : null,
      subscriptionType: signedIn && typeof o['subscriptionType'] === 'string' ? o['subscriptionType'] : null,
    };
  }

  /** Forgets what is known of the account's login: its cached status, a failed read, and a read still running. */
  private forget(slug: string): void {
    this.cache.delete(slug);
    this.failed.delete(slug);
    this.reading.delete(slug);
  }

  /**
   * Starts `auth login --claudeai` (one per account) and answers with the
   * sign-in link the CLI prints, once it has. `started` is false when a login
   * was already running; its link is returned again. The login ends by itself
   * when the browser calls back, or when a code is given to `submitCode`; it is
   * killed after 10 minutes.
   */
  async signIn(account: ClaudeAccountRef): Promise<{ started: boolean; url: string | null }> {
    const running = this.logins.get(account.slug);
    if (running) return { started: false, url: running.url };
    if (account.configDir) mkdirSync(account.configDir, { recursive: true });
    const child = this.spawnFn(this.cliPath(), ['auth', 'login', '--claudeai'], this.options(account));
    this.track(child);
    child.stdin?.on('error', () => {});
    const login: Login = { child, url: null, timer: setTimeout(() => child.kill(), LOGIN_LIFETIME_MS) };
    login.timer.unref?.();
    this.logins.set(account.slug, login);

    return new Promise((resolve) => {
      let out = '';
      let wait: ReturnType<typeof setTimeout> | undefined;
      const answer = (failed = false): void => {
        if (wait) clearTimeout(wait);
        resolve({ started: !failed, url: login.url });
      };
      wait = setTimeout(answer, URL_WAIT_MS);
      wait.unref?.();
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (login.url) return;
        out += chunk.toString();
        const m = SIGN_IN_URL.exec(out);
        if (m) {
          login.url = m[1]!;
          answer();
        }
      });
      child.stderr?.on('data', () => {});
      const ended = (): void => {
        clearTimeout(login.timer);
        if (this.logins.get(account.slug) === login) this.logins.delete(account.slug);
        this.forget(account.slug);
        // Ended before printing a link: the login did not start.
        answer(login.url === null);
      };
      child.on('close', ended);
      child.on('error', ended);
    });
  }

  signingIn(slug: string): boolean {
    return this.logins.has(slug);
  }

  /** Ends the sign-in running for an account, if any. */
  cancel(slug: string): void {
    this.logins.get(slug)?.child.kill();
  }

  /** Ends everything still running: logins, status reads and logouts. For server shutdown. */
  dispose(): void {
    for (const login of this.logins.values()) clearTimeout(login.timer);
    this.logins.clear();
    for (const child of [...this.live]) child.kill();
    this.live.clear();
  }

  private track(child: ChildProcess): void {
    this.live.add(child);
    const gone = (): void => void this.live.delete(child);
    child.on('close', gone);
    child.on('error', gone);
  }

  /** Gives the running login the code the sign-in page showed. False when no login is running. */
  submitCode(slug: string, code: string): boolean {
    const login = this.logins.get(slug);
    if (!login?.child.stdin) return false;
    login.child.stdin.write(`${code.trim()}\n`);
    return true;
  }

  /** `auth logout`, after ending a sign-in still waiting on this account. Forgets the cached status. */
  async signOut(account: ClaudeAccountRef): Promise<void> {
    this.cancel(account.slug);
    try {
      await this.run(account, ['auth', 'logout'], STATUS_TIMEOUT_MS, false);
    } finally {
      this.forget(account.slug);
    }
  }

  private options(account: ClaudeAccountRef): { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true } {
    return { env: buildChildEnv(this.baseEnv, { baseUrl: null } as Connection, null, '', account), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  }

  /** Runs the CLI to completion. `anyExit` accepts a non-zero exit too (a signed-out `auth status` exits 1). */
  private run(account: ClaudeAccountRef, args: string[], timeoutMs: number, anyExit: boolean): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.cliPath(), args, this.options(account));
      this.track(child);
      let stdout = '';
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error('Claude Code took too long to answer.')));
        child.kill();
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer | string) => (stdout += chunk.toString()));
      child.stderr?.on('data', () => {});
      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', (code) => finish(() => (anyExit || code === 0 ? resolve({ stdout }) : reject(new Error(`Claude Code exited with code ${code ?? 'null'}.`)))));
    });
  }
}
