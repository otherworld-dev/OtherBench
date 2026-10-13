import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannedMount } from '@grunt/core/domain/sandbox-paths.js';
import type { SandboxRunRequest, StoredSandboxState } from '@grunt/core/ports/sandbox.js';
import { SELF_TEST_STEP } from '../src/setup.js';
import { UnsupportedSandbox } from '../src/unsupported-sandbox.js';
import { WslSandbox, type StateStore, type WslSandboxOptions } from '../src/wsl-sandbox.js';
import { happyWsl, scriptedAgent, type FakeChannel, type FakeWsl, type RunMessage } from './helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'grunt-wsl-sandbox-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const VERSIONS = { distro: 'Ubuntu 24.04.5 LTS', runtime: '0.0.79', node: 'v24.21.0' };
const READY: StoredSandboxState = { state: 'ready', packages: [], versions: VERSIONS };

function memoryState(initial: StoredSandboxState | null): StateStore & { value: StoredSandboxState | null } {
  const s = {
    value: initial,
    get: () => s.value,
    set: (v: StoredSandboxState) => {
      s.value = v;
    },
  };
  return s;
}

function make(over: Partial<WslSandboxOptions> = {}, onRun?: (msg: RunMessage, ch: FakeChannel) => void, initial: StoredSandboxState | null = READY) {
  const channels: { chatId: string; channel: FakeChannel }[] = [];
  const mounts: string[] = [];
  const state = memoryState(initial);
  const runner = (over.runner as FakeWsl | undefined) ?? happyWsl({ distros: 'Ubuntu\r\ngrunt-sandbox\r\n', node: true });
  const sandbox = new WslSandbox({
    runner,
    resourcesDir: () => 'E:\\Grunt\\packages\\sandbox\\resources',
    state,
    machineName: () => 'Gigabyte',
    gruntPort: () => 4747,
    selfTestDir: join(tmp, 'selftest'),
    realpath: (p) => p,
    readWslConfig: async () => null,
    startAgent: (chatId) => {
      const agent = scriptedAgent({ onRun: onRun ?? ((m, ch) => queueMicrotask(() => ch.finish(m.id, 'ran\n'))) });
      channels.push({ chatId, channel: agent.channel });
      return agent.client;
    },
    mountRunner: {
      mount: async (m: PlannedMount) => {
        mounts.push(`mount ${m.mode} ${m.windowsPath} ${m.linuxPath}`);
      },
      unmount: async (m: PlannedMount) => {
        mounts.push(`unmount ${m.linuxPath}`);
      },
    },
    ...over,
  });
  return { sandbox, channels, mounts, state, runner };
}

const request = (over: Partial<SandboxRunRequest> = {}): SandboxRunRequest => ({
  chatId: 'chat-1',
  command: 'make test',
  timeoutMs: 120_000,
  workspaceRoot: 'E:\\Git\\Grunt',
  folders: [{ root: 'D:\\Refs', access: 'read' }],
  fs: 'readwrite',
  allowedHosts: ['pypi.org'],
  signal: new AbortController().signal,
  askHost: async () => false,
  ...over,
});
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** An agent script that holds every run until the test finishes it. */
function holding() {
  const held: { m: RunMessage; ch: FakeChannel }[] = [];
  return { held, onRun: (m: RunMessage, ch: FakeChannel) => void held.push({ m, ch }) };
}

describe('WslSandbox.run', () => {
  it("runs a command in the chat's agent with its folders mounted, and answers like run_command plus sandbox and cwd", async () => {
    const { sandbox, channels, mounts } = make();
    const result = await sandbox.run(request());
    expect(mounts).toEqual(['mount ro D:\\Refs /mnt/d/Refs', 'mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
    expect(channels.map((c) => c.chatId)).toEqual(['chat-1']);
    expect(channels[0]!.channel.runs()[0]).toMatchObject({
      command: 'make test',
      cwd: '/mnt/e/Git/Grunt',
      timeoutMs: 120_000,
      readPaths: ['/mnt/e/Git/Grunt', '/mnt/d/Refs'],
      writePaths: ['/mnt/e/Git/Grunt'],
      denyWritePaths: ['/mnt/d/Refs'],
      allowedHosts: ['pypi.org'],
    });
    expect(result).toEqual({ command: 'make test', exitCode: 0, signal: null, timedOut: false, truncated: false, output: 'ran\n', timeoutMsUsed: 120_000, sandbox: true, cwd: '/mnt/e/Git/Grunt' });
  });

  it('hands the runtime only host names from the allowlist: IP literals and localhost (a synced profile skips the routes) are dropped', async () => {
    const { sandbox, channels } = make();
    const allowedHosts = ['pypi.org', '127.0.0.1', '10.0.0.1:8080', '[::1]:443', '::1', 'localhost', 'api.localhost', ' PyPI.org ', '*.example.com:8443', '192.168.1.1', ''];
    await sandbox.run(request({ allowedHosts }));
    expect(channels[0]!.channel.runs()[0]!.allowedHosts).toEqual(['pypi.org', '*.example.com:8443']);
  });

  it('with the profile reading files only, nothing is writable and the workspace is mounted read-only', async () => {
    const { sandbox, channels, mounts } = make();
    await sandbox.run(request({ fs: 'read', folders: [] }));
    expect(mounts).toEqual(['mount ro E:\\Git\\Grunt /mnt/e/Git/Grunt']);
    expect(channels[0]!.channel.runs()[0]).toMatchObject({ writePaths: [], denyWritePaths: ['/mnt/e/Git/Grunt'] });
  });

  it("with file access off, the command gets none of the chat's folders: nothing mounted, nothing allowed, and it starts in its home", async () => {
    const { sandbox, channels, mounts } = make();
    // The workspace and folders a caller names anyway are ignored, not mounted.
    const result = await sandbox.run(request({ fs: 'off' }));
    expect(mounts).toEqual([]);
    expect(channels[0]!.channel.runs()[0]).toMatchObject({ cwd: '/home/grunt/chats/chat-1', readPaths: [], writePaths: [], denyWritePaths: [] });
    expect(result.cwd).toBe('/home/grunt/chats/chat-1');
  });

  it('with file access off, ignores a workspace that is missing or could never be mounted', async () => {
    const { sandbox, mounts } = make();
    await expect(sandbox.run(request({ fs: 'off', workspaceRoot: null, folders: [] }))).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.run(request({ fs: 'off', workspaceRoot: '\\\\nas\\share', folders: [{ root: 'Z:\\bad|name', access: 'readwrite' }] }))).resolves.toMatchObject({ exitCode: 0 });
    expect(mounts).toEqual([]);
  });

  it('refuses a command with file access and no workspace, mounting nothing', async () => {
    const { sandbox, channels, mounts } = make();
    await expect(sandbox.run(request({ fs: 'read', workspaceRoot: null }))).rejects.toMatchObject({ code: 'bad_folder' });
    expect(mounts).toEqual([]);
    expect(channels).toHaveLength(0);
  });

  it("with file access off after a read run in the same chat, mounts nothing (not even the chat's earlier folders) and allows none of them", async () => {
    const mounted: string[] = [];
    let failMounts = false;
    const { sandbox, channels } = make({
      mountRunner: {
        mount: async (m: PlannedMount) => {
          if (failMounts) throw new Error('drvfs is not answering');
          mounted.push(`mount ${m.mode} ${m.linuxPath}`);
        },
        unmount: async (m: PlannedMount) => void mounted.push(`unmount ${m.linuxPath}`),
      },
    });
    await sandbox.run(request({ fs: 'read', folders: [] }));
    expect(mounted).toEqual(['mount ro /mnt/e/Git/Grunt']);
    await sandbox.run(request({ fs: 'off' }));
    expect(mounted).toEqual(['mount ro /mnt/e/Git/Grunt']);
    expect(channels[0]!.channel.runs()[1]).toMatchObject({ cwd: '/home/grunt/chats/chat-1', readPaths: [], writePaths: [], denyWritePaths: [] });
    // Another chat's agent dies, so every mount may be gone (wsl --shutdown) and the next change of the chat's
    // mounts would mount its earlier folders again; here that remount fails, so the doubt stays.
    await sandbox.run(request({ chatId: 'chat-2', fs: 'off' }));
    failMounts = true;
    channels[1]!.channel.emitExit(1, 'wsl shut down');
    await tick();
    failMounts = false;
    // The chat's next files-off command doesn't put its earlier folder back: it touches no mount at all.
    await sandbox.run(request({ fs: 'off' }));
    expect(mounted).toEqual(['mount ro /mnt/e/Git/Grunt']);
    expect(channels[0]!.channel.runs()[2]).toMatchObject({ readPaths: [], writePaths: [], denyWritePaths: [] });
    // A later read run of the chat does.
    await sandbox.run(request({ fs: 'read', folders: [] }));
    expect(mounted).toEqual(['mount ro /mnt/e/Git/Grunt', 'mount ro /mnt/e/Git/Grunt']);
  });

  it("with file access off, runs alongside another chat's command writing the workspace: it holds no folder", async () => {
    const { held, onRun } = holding();
    const { sandbox } = make({}, onRun);
    const writing = sandbox.run(request({ chatId: 'a', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const off = sandbox.run(request({ chatId: 'b', fs: 'off' }));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    for (const { m, ch } of held) ch.finish(m.id);
    await Promise.all([writing, off]);
  });

  it("refuses when the sandbox isn't set up, naming this machine", async () => {
    const { sandbox, channels } = make({}, undefined, { state: 'not_set_up', packages: [] });
    await expect(sandbox.run(request())).rejects.toMatchObject({ code: 'not_set_up', message: expect.stringContaining("The sandbox isn't set up on Gigabyte.") });
    expect(channels).toEqual([]);
  });

  it('refuses while the sandbox is being set up', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sandbox } = make({ steps: [{ name: 'Wait', run: () => gate }] });
    const job = sandbox.setup();
    await expect(sandbox.run(request())).rejects.toMatchObject({ code: 'not_set_up', message: expect.stringContaining('being set up') });
    release();
    await job;
  });

  it('refuses a folder on a mapped network drive, mounting nothing and starting nothing, and other chats carry on', async () => {
    const { sandbox, mounts, channels } = make({ realpath: (p) => (p.startsWith('Z:') ? `\\\\nas\\share${p.slice(2)}` : p) });
    await expect(sandbox.run(request({ folders: [{ root: 'Z:\\Docs', access: 'read' }] }))).rejects.toMatchObject({
      code: 'bad_folder',
      message: expect.stringMatching(/Z:\\Docs can't be used in the sandbox: network/),
    });
    expect(mounts).toEqual([]);
    expect(channels).toEqual([]);
    expect((await sandbox.run(request({ chatId: 'other', folders: [] }))).exitCode).toBe(0);
    expect(mounts).toEqual(['mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
  });

  it('refuses a read-only folder inside a writable one (in any spelling, or the same folder), mounting nothing and starting nothing', async () => {
    const { sandbox, mounts, channels } = make();
    for (const folders of [
      [{ root: 'E:\\Git\\Grunt\\vendor', access: 'read' as const }],
      [{ root: 'e:\\git\\grunt\\Vendor\\lib', access: 'read' as const }],
      [{ root: 'E:\\GIT\\GRUNT', access: 'read' as const }],
      // Inside a writable extra folder, not only the workspace.
      [
        { root: 'D:\\Data', access: 'readwrite' as const },
        { root: 'D:\\Data\\raw', access: 'read' as const },
      ],
    ]) {
      await expect(sandbox.run(request({ folders }))).rejects.toMatchObject({ code: 'bad_folder', message: expect.stringContaining("is read-only but sits inside the writable") });
    }
    await expect(sandbox.run(request({ folders: [{ root: 'E:\\Git\\Grunt\\vendor', access: 'read' }] }))).rejects.toThrow(
      "E:\\Git\\Grunt\\vendor is read-only but sits inside the writable E:\\Git\\Grunt; the sandbox can't keep it read-only. Make it a separate folder, or make the parent read-only."
    );
    expect(mounts).toEqual([]);
    expect(channels).toEqual([]);
  });

  it('allows a read-only folder inside another read-only one, a sibling with a shared prefix, and a writable folder inside a read-only one', async () => {
    const { sandbox } = make();
    await expect(sandbox.run(request({ fs: 'read', folders: [{ root: 'E:\\Git\\Grunt\\vendor', access: 'read' }] }))).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.run(request({ chatId: 'b', folders: [{ root: 'E:\\Git\\Grunt-refs', access: 'read' }] }))).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.run(request({ chatId: 'c', folders: [{ root: 'E:\\Git', access: 'read' }] }))).resolves.toMatchObject({ exitCode: 0 });
  });

  it("uses each folder's real path, so another spelling of the same folder lands in the same place", async () => {
    const { sandbox, channels } = make({ realpath: (p) => (p.toLowerCase() === 'e:\\git\\grunt' ? 'E:\\Git\\Grunt' : p) });
    expect((await sandbox.run(request({ workspaceRoot: 'e:\\git\\grunt', folders: [] }))).cwd).toBe('/mnt/e/Git/Grunt');
    expect(channels[0]!.channel.runs()[0]!.cwd).toBe('/mnt/e/Git/Grunt');
  });

  it('tidies forward slashes and repeated or trailing separators before mounting', async () => {
    const { sandbox, channels, mounts } = make();
    const result = await sandbox.run(request({ workspaceRoot: 'e:/Git//Grunt/', folders: [{ root: 'D:\\Refs\\', access: 'read' }] }));
    expect(result.cwd).toBe('/mnt/e/Git/Grunt');
    expect(mounts).toEqual(['mount ro D:\\Refs /mnt/d/Refs', 'mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
    expect(channels[0]!.channel.runs()[0]).toMatchObject({ readPaths: ['/mnt/e/Git/Grunt', '/mnt/d/Refs'], denyWritePaths: ['/mnt/d/Refs'] });
  });

  it('starts a new agent and mounts the folders again after the old agent died (wsl --shutdown)', async () => {
    const { sandbox, channels, mounts } = make();
    await sandbox.run(request({ folders: [] }));
    channels[0]!.channel.emitExit(1, 'wsl shut down');
    await tick();
    await sandbox.run(request({ folders: [] }));
    expect(channels).toHaveLength(2);
    expect(mounts.filter((m) => m.startsWith('mount'))).toEqual(['mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt', 'mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
  });

  it("keeps a chat's folders read-write while its agent lives, so a read-only run doesn't narrow them under a writable one", async () => {
    const { held, onRun } = holding();
    const { sandbox, mounts } = make({}, onRun);
    const writing = sandbox.run(request({ folders: [] }));
    const reading = sandbox.run(request({ fs: 'read', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(mounts).toEqual(['mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
    held[0]!.ch.finish(held[0]!.m.id, 'w\n');
    await vi.waitFor(() => expect(held).toHaveLength(2));
    // The runtime still keeps the read-only run from writing.
    expect(held[1]!.m).toMatchObject({ writePaths: [], denyWritePaths: ['/mnt/e/Git/Grunt'] });
    held[1]!.ch.finish(held[1]!.m.id, 'r\n');
    expect((await writing).output).toBe('w\n');
    expect((await reading).output).toBe('r\n');
    expect(mounts).toEqual(['mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
  });

  it("widens a chat's folder only once its command in that folder has finished", async () => {
    const { held, onRun } = holding();
    const { sandbox, mounts } = make({}, onRun);
    const reading = sandbox.run(request({ fs: 'read', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const writing = sandbox.run(request({ folders: [] }));
    await tick();
    expect(mounts).toEqual(['mount ro E:\\Git\\Grunt /mnt/e/Git/Grunt']);
    held[0]!.ch.finish(held[0]!.m.id);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(mounts).toEqual(['mount ro E:\\Git\\Grunt /mnt/e/Git/Grunt', 'unmount /mnt/e/Git/Grunt', 'mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
    held[1]!.ch.finish(held[1]!.m.id);
    await Promise.all([reading, writing]);
  });

  it('a command waiting behind another in its chat is dropped when its turn is stopped', async () => {
    const { held, onRun } = holding();
    const { sandbox } = make({}, onRun);
    const first = sandbox.run(request({ folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const stop = new AbortController();
    const second = sandbox.run(request({ folders: [], signal: stop.signal }));
    stop.abort();
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
    held[0]!.ch.finish(held[0]!.m.id);
    await first;
    expect(held).toHaveLength(1);
  });

  it("runs another chat's command that can write the same folder (or one inside it) only after the running one, and others alongside", async () => {
    const { held, onRun } = holding();
    const { sandbox } = make({}, onRun);
    const first = sandbox.run(request({ chatId: 'a', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const same = sandbox.run(request({ chatId: 'b', workspaceRoot: 'e:\\git\\grunt', folders: [] }));
    const inside = sandbox.run(request({ chatId: 'c', workspaceRoot: 'E:\\Git\\Grunt\\packages', folders: [] }));
    // Reading the folder, or writing another one, doesn't wait.
    const reading = sandbox.run(request({ chatId: 'd', fs: 'read', folders: [] }));
    const elsewhere = sandbox.run(request({ chatId: 'e', workspaceRoot: 'E:\\Git\\Other', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(3));
    for (let i = 0; i < 5; i += 1) await tick();
    expect(held).toHaveLength(3);
    for (const h of held.splice(1)) h.ch.finish(h.m.id);
    await Promise.all([reading, elsewhere]);
    held[0]!.ch.finish(held[0]!.m.id);
    await first;
    // Then the two waiting ones, one after the other.
    await vi.waitFor(() => expect(held).toHaveLength(2));
    for (let i = 0; i < 5; i += 1) await tick();
    expect(held).toHaveLength(2);
    held[1]!.ch.finish(held[1]!.m.id);
    await vi.waitFor(() => expect(held).toHaveLength(3));
    held[2]!.ch.finish(held[2]!.m.id);
    await Promise.all([same, inside]);
  });

  it("holds a cancelled command's folders until its agent has reported it, restore and all", async () => {
    const { held, onRun } = holding();
    const { sandbox } = make({}, onRun);
    const stop = new AbortController();
    const first = sandbox.run(request({ chatId: 'a', folders: [], signal: stop.signal }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const second = sandbox.run(request({ chatId: 'b', folders: [] }));
    stop.abort();
    held[0]!.ch.emit({ type: 'restoring', id: held[0]!.m.id });
    for (let i = 0; i < 10; i += 1) await tick();
    expect(held).toHaveLength(1);
    held[0]!.ch.finish(held[0]!.m.id);
    await first;
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1]!.ch.finish(held[1]!.m.id);
    await second;
  });

  it("refuses commands that would write a folder an agent couldn't confirm it put back, until release or Repair", async () => {
    let unguarded = true;
    const { sandbox, channels } = make({}, (m, ch) => queueMicrotask(() => ch.finish(m.id, 'ran\n', 0, unguarded ? ['/mnt/e/Git/Grunt'] : [])));
    // The run itself still answers (its note says what failed).
    expect((await sandbox.run(request({ chatId: 'a', folders: [] }))).exitCode).toBe(0);
    unguarded = false;
    const refusal = { code: 'agent_failed', message: expect.stringContaining("The sandbox couldn't confirm it undid changes to protected files in E:\\Git\\Grunt") };
    await expect(sandbox.run(request({ chatId: 'a', fs: 'read', folders: [] }))).rejects.toMatchObject(refusal);
    await expect(sandbox.run(request({ chatId: 'b', folders: [] }))).rejects.toMatchObject(refusal);
    await expect(sandbox.run(request({ chatId: 'c', workspaceRoot: 'E:\\Git\\Grunt\\packages', folders: [] }))).rejects.toMatchObject(refusal);
    // Reading it, or writing somewhere else, goes ahead.
    await expect(sandbox.run(request({ chatId: 'd', fs: 'read', folders: [] }))).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.run(request({ chatId: 'e', workspaceRoot: 'E:\\Git\\Other', folders: [] }))).resolves.toMatchObject({ exitCode: 0 });
    // Refused before anything was sent to an agent for them.
    expect(channels.filter((c) => ['b', 'c'].includes(c.chatId))).toEqual([]);
    await sandbox.release('a');
    await expect(sandbox.run(request({ chatId: 'b', folders: [] }))).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.run(request({ chatId: 'a', folders: [] }))).resolves.toMatchObject({ exitCode: 0 });
  });

  it('treats an agent that died before reporting a command (mid-restore) as having left its folders unguarded', async () => {
    const { held, onRun } = holding();
    const { sandbox } = make({ steps: [] }, onRun);
    const first = sandbox.run(request({ chatId: 'a', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    held[0]!.ch.emit({ type: 'restoring', id: held[0]!.m.id });
    held[0]!.ch.emitExit(1, 'wsl shut down');
    await expect(first).rejects.toMatchObject({ code: 'agent_failed' });
    await expect(sandbox.run(request({ chatId: 'b', folders: [] }))).rejects.toMatchObject({ message: expect.stringContaining("couldn't confirm") });
    // Repair starts over.
    await sandbox.setup();
    await sandbox.idle();
    const next = sandbox.run(request({ chatId: 'b', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1]!.ch.finish(held[1]!.m.id);
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
  });

  it('a command waiting for another chat to finish writing its folder is dropped when its turn is stopped', async () => {
    const { held, onRun } = holding();
    const { sandbox } = make({}, onRun);
    const first = sandbox.run(request({ chatId: 'a', folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const stop = new AbortController();
    const second = sandbox.run(request({ chatId: 'b', folders: [], signal: stop.signal }));
    for (let i = 0; i < 5; i += 1) await tick();
    stop.abort();
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
    held[0]!.ch.finish(held[0]!.m.id);
    await first;
    expect(held).toHaveLength(1);
  });

  it("keeps the chat's folders mounted when its idle agent closes while its next command is being set up", async () => {
    let releaseMount!: () => void;
    const gate = new Promise<void>((r) => (releaseMount = r));
    const mounts: string[] = [];
    let seen: string[] = [];
    const { sandbox, channels } = make(
      {
        pool: { idleMs: 20 },
        mountRunner: {
          mount: async (m) => {
            if (m.windowsPath === 'D:\\Refs') await gate;
            mounts.push(`mount ${m.mode} ${m.linuxPath}`);
          },
          unmount: async (m) => {
            mounts.push(`unmount ${m.linuxPath}`);
          },
        },
      },
      (m, ch) => {
        seen = [...mounts];
        queueMicrotask(() => ch.finish(m.id));
      }
    );
    await sandbox.run(request({ folders: [] }));
    const next = sandbox.run(request({ folders: [{ root: 'D:\\Refs', access: 'read' }] }));
    await vi.waitFor(() => expect(channels[0]!.channel.sent.at(-1)).toEqual({ type: 'close' }));
    releaseMount();
    await next;
    expect(channels).toHaveLength(2);
    expect(seen).toEqual(['mount rw /mnt/e/Git/Grunt', 'mount ro /mnt/d/Refs']);
  });

  it("passes the agent's question signal through to askHost, and refuses a host longer than 253 characters without asking", async () => {
    const { held, onRun } = holding();
    const { sandbox, channels } = make({}, onRun);
    const asked: { host: string; port: number | undefined; signal: AbortSignal | undefined }[] = [];
    const running = sandbox.run(
      request({
        folders: [],
        askHost: (host, port, signal) => {
          asked.push({ host, port, signal });
          return new Promise<boolean>(() => undefined);
        },
      })
    );
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const ch = channels[0]!.channel;
    ch.emit({ type: 'ask', askId: 1, host: `${'a'.repeat(250)}.com`, port: 443 });
    ch.emit({ type: 'ask', askId: 2, host: 'pypi.org', port: 443 });
    await vi.waitFor(() => expect(ch.sent).toContainEqual({ type: 'answer', askId: 1, allowed: false }));
    expect(asked.map((a) => [a.host, a.port])).toEqual([['pypi.org', 443]]);
    expect(asked[0]!.signal?.aborted).toBe(false);
    ch.finish(held[0]!.m.id);
    await running;
    // The command ended: the question no longer matters.
    expect(asked[0]!.signal?.aborted).toBe(true);
  });

  it('refuses a command queued behind a running one when the chat is released, starting no agent and leaving nothing mounted', async () => {
    const { held, onRun } = holding();
    const { sandbox, channels, mounts } = make({}, onRun);
    const first = sandbox.run(request({ folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const queued = sandbox.run(request({ folders: [{ root: 'D:\\Refs', access: 'read' }] }));
    const firstFails = expect(first).rejects.toMatchObject({ code: 'agent_failed' });
    const queuedRefused = expect(queued).rejects.toMatchObject({ code: 'aborted' });
    await sandbox.release('chat-1');
    await firstFails;
    await queuedRefused;
    await tick();
    expect(channels).toHaveLength(1);
    expect(mounts).toEqual(['mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt', 'unmount /mnt/e/Git/Grunt']);
  });

  it('refuses a command queued behind a running one on release even when the closing agent reports the running one done', async () => {
    const { held, onRun } = holding();
    const agents: FakeChannel[] = [];
    const { sandbox, mounts } = make({
      startAgent: () => {
        // As the real agent: on close it stops the running command and reports it done, then exits.
        const agent = scriptedAgent({ onRun, finishOnClose: true });
        agents.push(agent.channel);
        return agent.client;
      },
    });
    const first = sandbox.run(request({ folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // Same folders as the running command: its mounting changes nothing, so only the chat's token can stop it.
    const queued = sandbox.run(request({ folders: [] }));
    const queuedRefused = expect(queued).rejects.toMatchObject({ code: 'aborted' });
    await sandbox.release('chat-1');
    expect(await first).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    await queuedRefused;
    await tick();
    expect(agents).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(mounts).toEqual(['mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt', 'unmount /mnt/e/Git/Grunt']);
  });

  it('refuses a command queued behind a running one when setup starts, starting no agent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { held, onRun } = holding();
    const { sandbox, channels } = make({ steps: [{ name: 'Wait', run: () => gate }] }, onRun);
    const first = sandbox.run(request({ folders: [] }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const queued = sandbox.run(request({ folders: [] }));
    const firstFails = expect(first).rejects.toMatchObject({ code: 'agent_failed' });
    const queuedRefused = expect(queued).rejects.toMatchObject({ code: expect.stringMatching(/^(not_set_up|aborted)$/) });
    const job = sandbox.setup();
    await firstFails;
    await queuedRefused;
    release();
    await job;
    expect(channels).toHaveLength(1);
  });

  it('refuses a command once the sandbox has closed, mounting nothing', async () => {
    const { sandbox, mounts, channels } = make();
    await sandbox.close();
    await expect(sandbox.run(request())).rejects.toMatchObject({ code: 'agent_failed' });
    expect(mounts).toEqual([]);
    expect(channels).toEqual([]);
  });

  it("narrows the chat's folders again when its agent closed while the next command was mounting", async () => {
    let releaseMount!: () => void;
    const gate = new Promise<void>((r) => (releaseMount = r));
    const mounts: string[] = [];
    const { sandbox, channels } = make({
      pool: { idleMs: 20 },
      mountRunner: {
        mount: async (m) => {
          if (m.windowsPath === 'D:\\Refs') await gate;
          mounts.push(`mount ${m.mode} ${m.linuxPath}`);
        },
        unmount: async (m) => {
          mounts.push(`unmount ${m.linuxPath}`);
        },
      },
    });
    // The first command writes; its agent goes idle and closes while the second (read-only) one mounts D:\Refs.
    await sandbox.run(request({ folders: [] }));
    const second = sandbox.run(request({ fs: 'read', folders: [{ root: 'D:\\Refs', access: 'read' }] }));
    await vi.waitFor(() => expect(channels[0]!.channel.sent.at(-1)).toEqual({ type: 'close' }));
    releaseMount();
    await second;
    mounts.length = 0;
    await sandbox.run(request({ fs: 'read', folders: [] }));
    // The new agent's commands have only ever asked for read-only: the workspace is no longer kept read-write.
    expect(mounts).toContain('mount ro /mnt/e/Git/Grunt');
  });

  it('runs commands again after a setup', async () => {
    const { sandbox, channels, mounts } = make({ steps: [] });
    await sandbox.run(request({ folders: [] }));
    await sandbox.setup();
    expect(channels[0]!.channel.sent.at(-1)).toEqual({ type: 'close' });
    expect((await sandbox.run(request({ folders: [] }))).exitCode).toBe(0);
    expect(channels).toHaveLength(2);
    // Setup restarts the distro, which drops the mounts: nothing is unmounted one by one, and the next command mounts again.
    expect(mounts).toEqual(['mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt', 'mount rw E:\\Git\\Grunt /mnt/e/Git/Grunt']);
  });
});

describe('WslSandbox.release and close', () => {
  it("closes the chat's agent, unmounts its folders and removes its home and temp folders in the VM as grunt", async () => {
    const { sandbox, channels, mounts, runner } = make();
    await sandbox.run(request({ folders: [] }));
    await sandbox.release('chat-1');
    expect(channels[0]!.channel.sent.at(-1)).toEqual({ type: 'close' });
    expect(mounts.at(-1)).toBe('unmount /mnt/e/Git/Grunt');
    expect(runner.calls).toContainEqual({ kind: 'exec', user: 'grunt', argv: ['/bin/rm', '-rf', '--one-file-system', '/home/grunt/chats/chat-1', '/tmp/grunt-chats/chat-1'] });
    expect(runner.commands.some((l) => l.startsWith('root: /bin/rm'))).toBe(false);
  });

  it("names the chat's folders in the VM with a safe name", async () => {
    const { sandbox, runner } = make();
    await sandbox.release('../x y');
    expect(runner.calls).toContainEqual({ kind: 'exec', user: 'grunt', argv: ['/bin/rm', '-rf', '--one-file-system', '/home/grunt/chats/___x_y', '/tmp/grunt-chats/___x_y'] });
  });

  it('close closes every agent and unmounts everything', async () => {
    const { sandbox, channels, mounts } = make();
    await sandbox.run(request({ chatId: 'a', folders: [] }));
    await sandbox.run(request({ chatId: 'b', workspaceRoot: 'D:\\Other', folders: [] }));
    await sandbox.close();
    expect(channels.every((c) => c.channel.sent.at(-1)?.type === 'close')).toBe(true);
    expect(mounts.filter((m) => m.startsWith('unmount')).sort()).toEqual(['unmount /mnt/d/Other', 'unmount /mnt/e/Git/Grunt']);
  });
});

describe('WslSandbox setup and status', () => {
  it('is setting up (with its log) while setup runs, then ready with the versions; a second Set up joins the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sandbox, state } = make({ steps: [{ name: 'Wait', run: () => gate }] }, undefined, { state: 'not_set_up', packages: ['ffmpeg'] });
    expect((await sandbox.status()).state).toBe('not_set_up');
    const job = sandbox.setup();
    expect(sandbox.setup()).toBe(job);
    await vi.waitFor(async () => expect(await sandbox.status()).toMatchObject({ state: 'setting_up', log: ['▶ Wait'], packages: ['ffmpeg'], machine: 'Gigabyte' }));
    release();
    await job;
    expect(await sandbox.status()).toEqual({ state: 'ready', versions: VERSIONS, packages: ['ffmpeg'], machine: 'Gigabyte' });
    expect(state.value).toEqual({ state: 'ready', versions: VERSIONS, packages: ['ffmpeg'] });
  });

  it('a failed step leaves the sandbox failed with the step, the message and the log', async () => {
    const { sandbox } = make({ steps: [{ name: 'Install Node', run: async () => Promise.reject(new Error('no network')) }] }, undefined, null);
    await sandbox.setup();
    const status = await sandbox.status();
    expect(status).toMatchObject({ state: 'failed', detail: 'Install Node: no network' });
    expect(status.log).toContain('✖ Install Node: no network');
  });

  it('a missing resource folder fails setup instead of throwing', async () => {
    const { sandbox } = make(
      {
        resourcesDir: () => {
          throw new Error("Grunt's sandbox files (agent.mjs) weren't found");
        },
      },
      undefined,
      null
    );
    await sandbox.setup();
    expect(await sandbox.status()).toMatchObject({ state: 'failed', detail: expect.stringContaining('agent.mjs') });
  });

  it('says the distro is gone when it was unregistered by hand, and remembers it', async () => {
    const { sandbox, state } = make({ runner: happyWsl({ distros: 'Ubuntu\r\n' }) });
    expect(await sandbox.status()).toMatchObject({ state: 'failed', detail: expect.stringContaining('is gone') });
    expect(state.value?.state).toBe('failed');
  });

  it("keeps the sandbox ready when WSL can't list its distros (timed out or didn't start), without remembering anything", async () => {
    for (const answer of [{ code: null, stdout: '', timedOut: true }, { code: null, stdout: '', stderr: 'spawn failed' }]) {
      const runner = happyWsl({ override: (call) => (call.kind === 'wsl' && call.args[0] === '--list' ? answer : undefined) });
      const { sandbox, state } = make({ runner });
      expect(await sandbox.status()).toMatchObject({ state: 'ready', versions: VERSIONS });
      expect(state.value).toEqual(READY);
    }
  });

  it("doesn't call the distro gone while it is being removed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = happyWsl({ distros: 'Ubuntu\r\n' });
    const wsl = runner.wsl.bind(runner);
    runner.wsl = async (args) => {
      if (args[0] === '--unregister') await gate;
      return wsl(args);
    };
    const { sandbox, state } = make({ runner });
    const removing = sandbox.remove();
    await tick();
    expect((await sandbox.status()).state).not.toBe('failed');
    expect(state.value?.state).toBe('ready');
    release();
    await removing;
    expect(state.value).toEqual({ state: 'not_set_up', packages: [] });
  });

  it("doesn't overwrite what a Remove wrote with a gone distro it saw before the Remove finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = happyWsl({ distros: 'Ubuntu\r\n' });
    const wsl = runner.wsl.bind(runner);
    let gateList = true;
    runner.wsl = async (args) => {
      if (args[0] === '--list' && gateList) {
        gateList = false;
        await gate;
      }
      return wsl(args);
    };
    const { sandbox, state } = make({ runner });
    const status = sandbox.status();
    await tick();
    await sandbox.remove();
    release();
    expect((await status).state).toBe('not_set_up');
    expect(state.value).toEqual({ state: 'not_set_up', packages: [] });
  });

  it('records a setup as interrupted while it runs, so a Grunt stopped mid-Repair is not left ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sandbox, state } = make({ steps: [{ name: 'Wait', run: () => gate }] });
    const job = sandbox.setup();
    await vi.waitFor(() => expect(state.value).toMatchObject({ state: 'failed', detail: 'Setup was interrupted.' }));
    release();
    await job;
    expect(state.value).toEqual(READY);
  });

  it("warns when WSL's mirrored networking is on", async () => {
    const { sandbox } = make({ readWslConfig: async () => '[wsl2]\r\nnetworkingMode=mirrored\r\n' });
    expect((await sandbox.status()).warnings).toEqual([expect.stringContaining('mirrored')]);
  });

  it.skipIf(process.platform !== 'win32')('marks the sandbox failed when the self-test finds a surprise', async () => {
    const { sandbox } = make({ steps: [SELF_TEST_STEP] }, (m, ch) => queueMicrotask(() => ch.finish(m.id, '', 0)), null);
    await sandbox.setup();
    expect(await sandbox.status()).toMatchObject({ state: 'failed', detail: expect.stringMatching(/^Self-test: Self-test ".*" was not blocked/) });
  });

  it.skipIf(process.platform !== 'win32')('passes the self-test when the sandbox blocks what it should, then lets its agent go', async () => {
    const works = /grunt-sandbox-ok|hello\.txt|written\.txt|registry\.npmjs\.org|^test ! -e /;
    const undone = 'The sandbox undid changes to .git/hooks/x, .claude/settings.local.json, .vscode/tasks.json (protected files).';
    const { sandbox, channels, mounts } = make(
      { steps: [SELF_TEST_STEP] },
      (m, ch) =>
        queueMicrotask(() => {
          if (m.command.includes('/.GIT/hooks/x')) ch.finish(m.id, `\n\n${undone}`, 0);
          else if (works.test(m.command)) ch.finish(m.id, '', 0);
          else ch.finish(m.id, 'bash: Read-only file system\nhttp_code=000', 1);
        }),
      null
    );
    await sandbox.setup();
    expect((await sandbox.status()).state).toBe('ready');
    expect(channels[0]!.chatId).toBe('__selftest__');
    const first = channels[0]!.channel.runs()[0]!;
    // The read-only folder sits beside the workspace, never inside it.
    expect(first.denyWritePaths).toHaveLength(1);
    expect(first.denyWritePaths[0]).toMatch(/\/selftest\/ro$/);
    expect(first.writePaths[0]).toMatch(/\/selftest\/rw$/);
    // The folders of the protected files it writes are there, so a refusal is the sandbox's doing.
    for (const folder of ['.git/hooks', '.claude', '.vscode']) expect(existsSync(join(tmp, 'selftest', 'rw', folder))).toBe(true);
    // And the settings file it rewrites is there first.
    expect(readFileSync(join(tmp, 'selftest', 'rw', '.claude', 'settings.local.json'), 'utf8')).toBe('{}');
    expect(channels[0]!.channel.sent.at(-1)).toEqual({ type: 'close' });
    expect(mounts.filter((m) => m.startsWith('unmount'))).toHaveLength(mounts.filter((m) => m.startsWith('mount')).length);
  });
});

describe('WslSandbox remove and packages', () => {
  it('remove unregisters the distro and keeps the package list', async () => {
    const { sandbox, runner, state } = make({}, undefined, { ...READY, packages: ['ffmpeg'] });
    await sandbox.remove();
    expect(runner.commands).toContain('wsl --unregister grunt-sandbox');
    expect(state.value).toEqual({ state: 'not_set_up', packages: ['ffmpeg'] });
  });

  it('remove is refused while setup runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sandbox } = make({ steps: [{ name: 'Wait', run: () => gate }] });
    const job = sandbox.setup();
    await expect(sandbox.remove()).rejects.toMatchObject({ code: 'busy' });
    release();
    await job;
  });

  it('refuses commands while the distro is being removed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = happyWsl({ distros: 'Ubuntu\r\ngrunt-sandbox\r\n', node: true });
    const wsl = runner.wsl.bind(runner);
    runner.wsl = async (args) => {
      if (args[0] === '--unregister') await gate;
      return wsl(args);
    };
    const { sandbox, channels } = make({ runner });
    const removing = sandbox.remove();
    await expect(sandbox.run(request())).rejects.toMatchObject({ code: 'not_set_up', message: expect.stringContaining('being removed') });
    release();
    await removing;
    expect(channels).toEqual([]);
  });

  it('setPackages stores the list, and installs it as root when the sandbox is ready', async () => {
    const { sandbox, runner, state } = make();
    await sandbox.setPackages(['ffmpeg', 'pandoc']);
    await sandbox.idle();
    expect(runner.commands).toContain('root: /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -q ffmpeg pandoc');
    expect(state.value).toMatchObject({ state: 'ready', packages: ['ffmpeg', 'pandoc'], versions: VERSIONS });
  });

  it("a failed package install leaves the sandbox ready, says why, and commands still run", async () => {
    const runner = happyWsl({
      distros: 'Ubuntu\r\ngrunt-sandbox\r\n',
      node: true,
      override: (call) => (call.kind === 'exec' && call.argv.includes('install') ? { code: 100, stderr: 'E: Unable to locate package nosuch' } : undefined),
    });
    const { sandbox, state } = make({ runner });
    await sandbox.setPackages(['nosuch']);
    await sandbox.idle();
    const status = await sandbox.status();
    expect(status).toMatchObject({ state: 'ready', versions: VERSIONS, packages: ['nosuch'], detail: expect.stringContaining('Unable to locate package nosuch') });
    expect(status.log).toEqual(expect.arrayContaining([expect.stringContaining('✖')]));
    expect(state.value).toMatchObject({ state: 'ready', versions: VERSIONS });
    expect((await sandbox.run(request({ folders: [] }))).exitCode).toBe(0);
  });

  it('a later successful install clears the earlier failure', async () => {
    let fail = true;
    const runner = happyWsl({
      distros: 'Ubuntu\r\ngrunt-sandbox\r\n',
      node: true,
      override: (call) => (fail && call.kind === 'exec' && call.argv.includes('install') ? { code: 100, stderr: 'E: nope' } : undefined),
    });
    const { sandbox, state } = make({ runner });
    await sandbox.setPackages(['nosuch']);
    await sandbox.idle();
    fail = false;
    await sandbox.setPackages(['ffmpeg']);
    await sandbox.idle();
    expect(state.value).toEqual({ state: 'ready', versions: VERSIONS, packages: ['ffmpeg'] });
  });

  it('a package list change that installs nothing also clears an earlier failed install', async () => {
    const runner = happyWsl({
      distros: 'Ubuntu\r\ngrunt-sandbox\r\n',
      node: true,
      override: (call) => (call.kind === 'exec' && call.argv.includes('install') ? { code: 100, stderr: 'E: nope' } : undefined),
    });
    const { sandbox, state } = make({ runner });
    await sandbox.setPackages(['nosuch']);
    await sandbox.idle();
    expect(state.value?.detail).toContain('nope');
    await sandbox.setPackages([]);
    expect(state.value).toEqual({ state: 'ready', versions: VERSIONS, packages: [] });
    expect(await sandbox.status()).not.toHaveProperty('detail');
  });

  it("remove refuses when wsl --unregister fails and the distro list can't be read", async () => {
    const runner = happyWsl({
      override: (call) => {
        if (call.kind !== 'wsl') return undefined;
        if (call.args[0] === '--unregister') return { code: 1, stderr: 'The service is busy.' };
        if (call.args[0] === '--list') return { code: null, stdout: '', timedOut: true };
        return undefined;
      },
    });
    const { sandbox, state } = make({ runner });
    await expect(sandbox.remove()).rejects.toMatchObject({ code: 'remove_failed' });
    expect(state.value).toEqual(READY);
  });

  it('setPackages only stores the list when the sandbox is not set up', async () => {
    const { sandbox, runner, state } = make({}, undefined, { state: 'not_set_up', packages: [] });
    await sandbox.setPackages(['ffmpeg']);
    expect(runner.commands.some((l) => l.includes('apt-get'))).toBe(false);
    expect(state.value).toEqual({ state: 'not_set_up', packages: ['ffmpeg'] });
  });

  it('setPackages refuses a name apt would read as something else, and stores nothing', async () => {
    const { sandbox, runner, state } = make({}, undefined, { state: 'not_set_up', packages: ['ffmpeg'] });
    for (const bad of ['foo-', 'x.deb', 'a:b', '-y', 'Foo']) {
      await expect(sandbox.setPackages(['pandoc', bad])).rejects.toMatchObject({ code: 'bad_package', message: `"${bad}" is not an apt package name.` });
    }
    expect(state.value).toEqual({ state: 'not_set_up', packages: ['ffmpeg'] });
    expect(runner.commands.some((l) => l.includes('apt-get'))).toBe(false);
  });
});

describe('UnsupportedSandbox', () => {
  it('says the sandbox is not available on this platform, and refuses everything but release and close', async () => {
    const sandbox = new UnsupportedSandbox(() => 'Laptop');
    expect(await sandbox.status()).toEqual({ state: 'unsupported', detail: "The sandbox isn't available on this platform yet.", packages: [], machine: 'Laptop' });
    await expect(sandbox.setup()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(sandbox.run(request())).rejects.toMatchObject({ code: 'unsupported', message: "The sandbox isn't available on this platform yet." });
    await expect(sandbox.release('chat-1')).resolves.toBeUndefined();
    await expect(sandbox.close()).resolves.toBeUndefined();
  });
});
