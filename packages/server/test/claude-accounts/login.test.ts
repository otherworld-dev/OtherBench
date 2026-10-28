import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_ACCOUNT, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import { ClaudeLoginRunner } from '../../src/claude-accounts/login.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  stdin = { write: (s: string) => { this.written.push(s); return true; }, end: () => {} };
  kill(): boolean {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
  say(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }
  finish(code: number): void {
    this.emit('close', code);
  }
}

interface Call { cmd: string; args: string[]; env: Record<string, string>; child: FakeChild }
let calls: Call[];
let onSpawn: (child: FakeChild, call: Call) => void;
let clock: number;
let root: string;

function runner(baseEnv: NodeJS.ProcessEnv = {}): ClaudeLoginRunner {
  const spawn = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    const child = new FakeChild();
    const call = { cmd, args, env: opts.env, child };
    calls.push(call);
    queueMicrotask(() => onSpawn(child, call));
    return child;
  }) as never;
  return new ClaudeLoginRunner({ spawn, cliPath: () => '/cli/claude', baseEnv, now: () => clock });
}

const vh = (): ClaudeAccountRef => ({ slug: 'vh', name: 'VH', configDir: join(root, 'vh') });
const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', orgId: 'o', orgName: 'Org', subscriptionType: 'max', token: 'sk-secret', configDirectory: '/x' });

beforeEach(() => {
  calls = [];
  clock = 1000;
  root = mkdtempSync(join(tmpdir(), 'ob-login-'));
  onSpawn = (child) => {
    child.say(SIGNED_IN);
    child.finish(0);
  };
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('ClaudeLoginRunner.status', () => {
  it('keeps only loggedIn, email and subscriptionType', async () => {
    const result = await runner().status(vh());
    expect(result).toEqual({ signedIn: true, email: 'a@b.c', subscriptionType: 'max' });
    expect(JSON.stringify(result)).not.toContain('token');
    expect(calls[0]!.args).toEqual(['auth', 'status', '--json']);
  });

  it('reads a signed-out answer (exit 1) as not signed in', async () => {
    onSpawn = (child) => {
      child.say(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      child.finish(1);
    };
    expect(await runner().status(vh())).toEqual({ signedIn: false, email: null, subscriptionType: null });
  });

  it("points the CLI at the account's folder and never passes ANTHROPIC credentials", async () => {
    await runner({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', PATH: 'p' }).status(vh());
    const env = calls[0]!.env;
    expect(env['CLAUDE_CONFIG_DIR']).toBe(vh().configDir);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('p');
  });

  it("leaves main's folder to the server's own environment", async () => {
    await runner({ CLAUDE_CONFIG_DIR: '/inherited' }).status(MAIN_ACCOUNT);
    expect(calls[0]!.env['CLAUDE_CONFIG_DIR']).toBe('/inherited');
  });

  it('caches a reading for 60 s per slug, and signing out forgets it', async () => {
    const r = runner();
    await r.status(vh());
    clock += 59_000;
    await r.status(vh());
    expect(calls).toHaveLength(1);
    await r.status(MAIN_ACCOUNT);
    expect(calls).toHaveLength(2);
    clock += 2_000;
    await r.status(vh());
    expect(calls).toHaveLength(3);
    await r.signOut(vh());
    await r.status(vh());
    expect(calls.map((c) => c.args[1])).toEqual(['status', 'status', 'status', 'logout', 'status']);
  });

  it('gives up on a stuck CLI after 15 s', async () => {
    vi.useFakeTimers();
    onSpawn = () => {};
    const pending = runner().status(vh());
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await caught).toBeInstanceOf(Error);
    expect(calls[0]!.child.killed).toBe(true);
  });
});

describe('ClaudeLoginRunner.signOut', () => {
  it('runs auth logout', async () => {
    await runner().signOut(vh());
    expect(calls[0]!.args).toEqual(['auth', 'logout']);
  });
});

describe('ClaudeLoginRunner.signIn', () => {
  const URL_OUT = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s\nPaste code here if prompted > ";
  beforeEach(() => {
    onSpawn = (child) => child.say(URL_OUT);
  });

  it('creates the folder, runs auth login --claudeai and returns the URL from stdout', async () => {
    const r = runner();
    expect(existsSync(vh().configDir!)).toBe(false);
    const result = await r.signIn(vh());
    expect(result).toEqual({ started: true, url: 'https://claude.com/cai/oauth/authorize?code=true&state=s' });
    expect(calls[0]!.args).toEqual(['auth', 'login', '--claudeai']);
    expect(existsSync(vh().configDir!)).toBe(true);
    expect(r.signingIn('vh')).toBe(true);
  });

  it('starts one process when asked twice while the first runs', async () => {
    const r = runner();
    await r.signIn(vh());
    const again = await r.signIn(vh());
    expect(calls).toHaveLength(1);
    expect(again.started).toBe(false);
    expect(again.url).toContain('https://claude.com/cai/oauth/authorize');
  });

  it('writes a pasted code to stdin, and refuses when no login runs', async () => {
    const r = runner();
    expect(r.submitCode('vh', 'abc')).toBe(false);
    await r.signIn(vh());
    expect(r.submitCode('vh', '  abc#def \n')).toBe(true);
    expect(calls[0]!.child.written).toEqual(['abc#def\n']);
  });

  it('stops signing in when the process exits, and forgets the cached status', async () => {
    const r = runner();
    onSpawn = (child, call) => {
      if (call.args[1] === 'status') {
        child.say(SIGNED_IN);
        child.finish(0);
      } else child.say(URL_OUT);
    };
    await r.status(vh());
    await r.signIn(vh());
    calls[1]!.child.finish(0);
    expect(r.signingIn('vh')).toBe(false);
    await r.status(vh());
    expect(calls).toHaveLength(3);
  });

  it('ends a running login when the account signs out', async () => {
    const r = runner();
    await r.signIn(vh());
    onSpawn = (child) => child.finish(0);
    await r.signOut(vh());
    expect(calls[0]!.child.killed).toBe(true);
    expect(r.signingIn('vh')).toBe(false);
  });

  it('kills a login left running for 10 minutes', async () => {
    vi.useFakeTimers();
    const r = runner();
    const p = r.signIn(vh());
    await vi.advanceTimersByTimeAsync(1);
    await p;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(calls[0]!.child.killed).toBe(true);
    expect(r.signingIn('vh')).toBe(false);
  });
});
