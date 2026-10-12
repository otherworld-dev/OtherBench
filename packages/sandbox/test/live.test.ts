import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toSandboxPath } from '@grunt/core/domain/sandbox-paths.js';
import type { SandboxRunRequest, StoredSandboxState } from '@grunt/core/ports/sandbox.js';
import { sandboxResourcesDir } from '../src/resources.js';
import { otherSpelling, PROTECTED_PROBES } from '../src/selftest.js';
import { WslSandbox } from '../src/wsl-sandbox.js';
import { createWslRunner } from '../src/wsl.js';

/**
 * The real sandbox on this Windows machine (spec 2026-10-12-sandbox-design §6,
 * "Live"): set up or repair the grunt-sandbox distro (which runs the
 * self-test), then real commands. Opt in with GRUNT_SANDBOX_LIVE=1. Not CI.
 */
const live = process.env['GRUNT_SANDBOX_LIVE'] === '1' && process.platform === 'win32';

describe.skipIf(!live)('the sandbox on this machine (live)', () => {
  const runner = createWslRunner();
  let dir = '';
  let stored: StoredSandboxState | null = null;
  let sandbox: WslSandbox;
  const asked: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'grunt-sandbox-live-'));
    mkdirSync(join(dir, 'ws'));
    // The folders of the protected files the live checks write: a refusal is then the sandbox's, not a missing folder's.
    for (const rel of PROTECTED_PROBES) mkdirSync(join(dir, 'ws', rel, '..'), { recursive: true });
    mkdirSync(join(dir, 'refs'));
    writeFileSync(join(dir, 'refs', 'note.txt'), 'read me\n');
    sandbox = new WslSandbox({
      runner,
      resourcesDir: () => sandboxResourcesDir(),
      state: {
        get: () => stored,
        set: (s) => {
          stored = s;
        },
      },
      machineName: () => 'this machine',
      gruntPort: () => 4747,
      selfTestDir: join(dir, 'selftest'),
    });
  });

  afterAll(async () => {
    await sandbox?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const refs = (): string => toSandboxPath(join(dir, 'refs'));
  const req = (command: string, over: Partial<SandboxRunRequest> = {}): SandboxRunRequest => ({
    chatId: 'live-chat',
    command,
    timeoutMs: 120_000,
    workspaceRoot: join(dir, 'ws'),
    folders: [{ root: join(dir, 'refs'), access: 'read' }],
    writable: true,
    allowedHosts: ['registry.npmjs.org'],
    signal: new AbortController().signal,
    askHost: async (host) => {
      asked.push(host);
      return false;
    },
    ...over,
  });
  /** Whether a `sleep` is running anywhere in the distro (pgrep exits 1 for none). */
  const sleeping = async (): Promise<boolean> => (await runner.exec('root', ['/usr/bin/pgrep', '-x', 'sleep'])).code === 0;

  it('sets up (or repairs) the distro, passing the self-test', async () => {
    await sandbox.setup();
    const status = await sandbox.status();
    if (status.state !== 'ready') console.error(status.detail, '\n', status.log?.join('\n'));
    expect(status).toMatchObject({ state: 'ready', versions: { node: 'v24.21.0', runtime: '0.0.79' } });
    expect(status.versions?.distro).toMatch(/Ubuntu 24\.04/);
  }, 60 * 60_000);

  it('runs a command in Linux, in the workspace, and writes there', async () => {
    const r = await sandbox.run(req('uname -s && pwd && echo made-in-sandbox > from-sandbox.txt'));
    expect(r).toMatchObject({ exitCode: 0, sandbox: true, cwd: toSandboxPath(join(dir, 'ws')) });
    expect(r.output).toContain('Linux');
    expect(r.output).toContain(r.cwd);
    expect(readFileSync(join(dir, 'ws', 'from-sandbox.txt'), 'utf8')).toBe('made-in-sandbox\n');
  }, 120_000);

  it("reads the read-only folder but can't write it", async () => {
    const read = await sandbox.run(req(`cat '${refs()}/note.txt'`));
    expect(read).toMatchObject({ exitCode: 0 });
    expect(read.output).toContain('read me');
    const write = await sandbox.run(req(`echo no > '${refs()}/nope.txt'`));
    expect(write.exitCode).not.toBe(0);
    expect(existsSync(join(dir, 'refs', 'nope.txt'))).toBe(false);
  }, 120_000);

  it("keeps the read-only folder read-only in another spelling too, and refuses one inside the writable folder", async () => {
    const write = await sandbox.run(req(`echo no > '${otherSpelling(refs())}/nope-case.txt'`));
    expect(write.exitCode).not.toBe(0);
    expect(existsSync(join(dir, 'refs', 'nope-case.txt'))).toBe(false);
    mkdirSync(join(dir, 'ws', 'inner'), { recursive: true });
    await expect(sandbox.run(req('true', { folders: [{ root: join(dir, 'ws', 'inner'), access: 'read' }] }))).rejects.toMatchObject({
      code: 'bad_folder',
      message: expect.stringContaining("is read-only but sits inside the writable"),
    });
  }, 120_000);

  it('refuses writes to protected files in the workspace as spelt, and undoes them (saying so) in another spelling', async () => {
    for (const rel of PROTECTED_PROBES) {
      const r = await sandbox.run(req(`echo no > '${rel}'`));
      expect(r.exitCode, `${rel}: ${r.output}`).not.toBe(0);
      expect(r.output, rel).toMatch(/Read-only file system|Permission denied/);
      expect(existsSync(join(dir, 'ws', rel)), rel).toBe(false);
    }
    const respelt = PROTECTED_PROBES.map((rel) => rel.replace(/^[^/]+/, (first) => otherSpelling(first)));
    const r = await sandbox.run(req(respelt.map((rel) => `echo no > '${rel}'`).join(' && ')));
    expect(r.exitCode, r.output).toBe(0);
    expect(r.output).toContain('The sandbox undid changes to');
    for (const rel of PROTECTED_PROBES) {
      expect(r.output, rel).toContain(rel);
      expect(existsSync(join(dir, 'ws', rel)), rel).toBe(false);
    }
    console.log(`[sandbox-live] protected files: ${r.output.trim()}`);
  }, 120_000);

  it('reaches an allowlisted host, and asks about one that is not (refused here)', async () => {
    expect((await sandbox.run(req('curl -sS -m 30 -o /dev/null https://registry.npmjs.org/'))).exitCode).toBe(0);
    expect((await sandbox.run(req('curl -sS -m 15 -o /dev/null https://example.com/'))).exitCode).not.toBe(0);
    expect(asked).toContain('example.com');
  }, 120_000);

  it("keeps the proxy off this VM and private networks, by number and by an allowlisted name", async () => {
    // A listener in the distro, outside the inner sandbox, on loopback and the VM's own (private) address.
    // Every request goes through the runtime's proxy (--noproxy '' -x): by default curl honours the NO_PROXY
    // the runtime sets for these ranges and dials them straight into a namespace with no network, which
    // proves nothing about the proxy. Names come from nip.io (a.b.c.d.nip.io resolves to a.b.c.d).
    const eth0 = await runner.exec('root', ['/usr/sbin/ip', '-4', '-o', 'addr', 'show', 'eth0']);
    const vmAddress = /inet (\d+\.\d+\.\d+\.\d+)/.exec(eth0.stdout)?.[1] as string;
    expect(vmAddress, eth0.stdout).toBeDefined();
    const listener = runner.spawn('root', ['/usr/bin/python3', '-m', 'http.server', '8765', '--bind', '0.0.0.0', '--directory', '/usr/share']);
    let served = '';
    listener.stderr.on('data', (d: Buffer) => (served += d.toString('utf8')));
    listener.stdout.resume();
    const requests = (): number => served.split('\n').filter((line) => line.includes(' - - [')).length;
    const viaProxy = (target: string): string =>
      `curl -sS -m 10 --noproxy '' -x "$HTTP_PROXY" -o /dev/null -w 'http_code=%{http_code}\n' http://${target}/; ` +
      `curl -sS -m 10 --noproxy '' -x "$HTTPS_PROXY" -o /dev/null -w 'connect_code=%{http_connect}\n' https://${target}/`;
    try {
      // Up when root, outside the sandbox, can fetch from it.
      for (let i = 0; i < 50 && requests() === 0; i += 1) {
        await runner.exec('root', ['/usr/bin/curl', '-s', '-o', '/dev/null', '--noproxy', '*', 'http://127.0.0.1:8765/']);
        await new Promise((r) => setTimeout(r, 200));
      }
      const before = requests();
      expect(before, served).toBeGreaterThan(0);
      // By number, not on the allowlist, even with every card answered yes: the agent refuses a private
      // address without asking (Grunt's allowlist can't hold an IP literal; the runtime's resolved-address
      // guard is for names only and lets an allowlisted literal through).
      const askedBefore = asked.length;
      for (const target of ['127.0.0.1:8765', `${vmAddress}:8765`, '10.0.0.1:80', '169.254.169.254:80']) {
        const r = await sandbox.run(req(viaProxy(target), {
          askHost: async (host) => {
            asked.push(host);
            return true;
          },
        }));
        expect(r.output, target).toMatch(/http_code=403/);
        expect(r.output, target).toMatch(/connect_code=403/);
      }
      expect(asked.slice(askedBefore)).toEqual([]);
      // By a name on the allowlist that resolves there: the runtime's guard refuses it at connect time.
      const byName: [string, number][] = [
        ['127.0.0.1.nip.io', 8765],
        [`${vmAddress.replace(/\./g, '-')}.nip.io`, 8765],
        ['10-0-0-1.nip.io', 80],
        ['169-254-169-254.nip.io', 80],
      ];
      const names = byName.map(([name]) => name);
      for (const [name, port] of byName) {
        const r = await sandbox.run(req(viaProxy(`${name}:${port}`), { allowedHosts: names }));
        expect(r.output, name).toMatch(/http_code=403/);
        expect(r.output, name).toMatch(/connect_code=403/);
        expect(r.output, name).toMatch(/resolved to/);
      }
      expect(requests(), served).toBe(before);
    } finally {
      listener.kill();
      await runner.exec('root', ['/usr/bin/pkill', '-f', 'http.server 8765']);
    }
  }, 180_000);

  it('keeps the chat home between commands', async () => {
    await sandbox.run(req('echo kept > ~/kept.txt'));
    expect((await sandbox.run(req('cat ~/kept.txt'))).output).toContain('kept');
  }, 120_000);

  it('kills a command at its timeout, with what it started', async () => {
    const r = await sandbox.run(req('setsid sleep 300 & sleep 300 & sleep 60', { timeoutMs: 3000 }));
    expect(r.timedOut).toBe(true);
    expect(await sleeping()).toBe(false);
  }, 120_000);

  it("release removes the chat's home folder", async () => {
    await sandbox.release('live-chat');
    expect((await runner.exec('root', ['/usr/bin/test', '-e', '/home/grunt/chats/live-chat'])).code).toBe(1);
  }, 120_000);
});
