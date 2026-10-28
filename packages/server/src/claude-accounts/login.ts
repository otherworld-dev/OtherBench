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
  private readonly logins = new Map<string, Login>();

  constructor(deps: { spawn?: typeof nodeSpawn; cliPath?: () => string; baseEnv?: NodeJS.ProcessEnv; now?: () => number } = {}) {
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.cliPath = deps.cliPath ?? bundledCliPath;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.now = deps.now ?? Date.now;
  }

  /** `auth status --json`, cached 60 s per account. Rejects when the CLI fails, can't be parsed, or takes over 15 s. */
  async status(account: ClaudeAccountRef): Promise<LoginStatus> {
    const hit = this.cache.get(account.slug);
    if (hit && this.now() - hit.at < STATUS_CACHE_MS) return hit.value;
    const { stdout } = await this.run(account, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS, true);
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new Error('Claude Code gave an unreadable sign-in status.');
    }
    const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const signedIn = o['loggedIn'] === true;
    const value: LoginStatus = {
      signedIn,
      email: signedIn && typeof o['email'] === 'string' ? o['email'] : null,
      subscriptionType: signedIn && typeof o['subscriptionType'] === 'string' ? o['subscriptionType'] : null,
    };
    this.cache.set(account.slug, { at: this.now(), value });
    return value;
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
    const login: Login = { child, url: null, timer: setTimeout(() => child.kill(), LOGIN_LIFETIME_MS) };
    login.timer.unref?.();
    this.logins.set(account.slug, login);

    return new Promise((resolve) => {
      let out = '';
      let wait: ReturnType<typeof setTimeout> | undefined;
      const answer = (): void => {
        if (wait) clearTimeout(wait);
        resolve({ started: true, url: login.url });
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
        this.cache.delete(account.slug);
        answer();
      };
      child.on('close', ended);
      child.on('error', ended);
    });
  }

  signingIn(slug: string): boolean {
    return this.logins.has(slug);
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
    this.logins.get(account.slug)?.child.kill();
    try {
      await this.run(account, ['auth', 'logout'], STATUS_TIMEOUT_MS, false);
    } finally {
      this.cache.delete(account.slug);
    }
  }

  private options(account: ClaudeAccountRef): { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true } {
    return { env: buildChildEnv(this.baseEnv, { baseUrl: null } as Connection, null, '', account), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  }

  /** Runs the CLI to completion. `anyExit` accepts a non-zero exit too (a signed-out `auth status` exits 1). */
  private run(account: ClaudeAccountRef, args: string[], timeoutMs: number, anyExit: boolean): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.cliPath(), args, this.options(account));
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
