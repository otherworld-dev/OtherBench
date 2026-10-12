import { describe, expect, it } from 'vitest';
import { createWslRunner, decodeWslOutput, DISTRO, type SpawnFn } from '../src/wsl.js';
import { fakeChild, type FakeChild } from './helpers.js';

const EXE = 'C:\\Windows\\System32\\wsl.exe';

describe('decodeWslOutput', () => {
  it("reads wsl.exe's own UTF-16LE output, with or without a BOM", () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\r\ngrunt-sandbox\r\n', 'utf16le'))).toBe('Ubuntu\r\ngrunt-sandbox\r\n');
    expect(decodeWslOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('WSL version: 2.7.3.0', 'utf16le')]))).toBe('WSL version: 2.7.3.0');
  });

  it("reads a Linux program's UTF-8 output", () => {
    expect(decodeWslOutput(Buffer.from('PRETTY_NAME="Ubuntu 24.04.5 LTS"\nZoë\n', 'utf8'))).toBe('PRETTY_NAME="Ubuntu 24.04.5 LTS"\nZoë\n');
    expect(decodeWslOutput(Buffer.alloc(0))).toBe('');
  });
});

describe('createWslRunner', () => {
  function recorder(behave: (f: FakeChild) => void = (f) => setImmediate(() => f.exit(0))) {
    const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const spawn: SpawnFn = (file, args, options) => {
      const f = fakeChild();
      calls.push({ file, args, env: options.env });
      behave(f);
      return f.child;
    };
    return { calls, runner: createWslRunner(spawn, EXE) };
  }

  it('runs in-distro programs with --exec as the given user, arguments untouched and never through a shell', async () => {
    const { calls, runner } = recorder((f) =>
      setImmediate(() => {
        f.stdout.write('ok\n');
        f.exit(0);
      })
    );
    const win = "C:\\Users\\Zoë O'Brien\\x y";
    const linux = "/mnt/c/Users/Zoë O'Brien/x y";
    const r = await runner.exec('root', ['/bin/mount', '-t', 'drvfs', win, linux, '-o', 'ro']);
    expect(r).toEqual({ code: 0, stdout: 'ok\n', stderr: '', timedOut: false });
    expect(calls[0]!.file).toBe(EXE);
    expect(calls[0]!.args).toEqual(['-d', DISTRO, '-u', 'root', '--exec', '/bin/mount', '-t', 'drvfs', win, linux, '-o', 'ro']);
    expect(calls[0]!.args).not.toContain('--');
    expect(calls[0]!.env?.['WSL_UTF8']).toBe('1');
  });

  it("decodes wsl.exe's UTF-16 messages and reports a non-zero exit without throwing", async () => {
    const { runner } = recorder((f) =>
      setImmediate(() => {
        f.stderr.write(Buffer.from('There is no distribution with the supplied name.\r\n', 'utf16le'));
        f.exit(1);
      })
    );
    const r = await runner.wsl(['--terminate', DISTRO]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('There is no distribution');
  });

  it('kills a command that runs past its timeout', async () => {
    const { runner } = recorder(() => undefined);
    expect(await runner.wsl(['--install', 'Ubuntu-24.04'], { timeoutMs: 20 })).toMatchObject({ code: null, timedOut: true });
  });

  it('kills a command when its signal aborts', async () => {
    const { runner } = recorder(() => undefined);
    const ac = new AbortController();
    const running = runner.wsl(['--version'], { signal: ac.signal });
    ac.abort();
    expect(await running).toMatchObject({ code: null, timedOut: false });
  });

  it('does not start a command whose signal is already aborted', async () => {
    const { calls, runner } = recorder(() => undefined);
    const ac = new AbortController();
    ac.abort();
    expect(await runner.wsl(['--install', 'Ubuntu-24.04'], { signal: ac.signal })).toEqual({ code: null, stdout: '', stderr: '', timedOut: false });
    expect(calls).toHaveLength(0);
  });

  it('reports a wsl.exe that cannot start as code null with the reason', async () => {
    const runner = createWslRunner(() => {
      throw new Error('spawn wsl.exe ENOENT');
    }, EXE);
    expect(await runner.wsl(['--version'])).toEqual({ code: null, stdout: '', stderr: 'spawn wsl.exe ENOENT', timedOut: false });
  });

  it('starts long-lived programs as the given user with --exec', () => {
    const { calls, runner } = recorder(() => undefined);
    runner.spawn('grunt', ['/opt/grunt-sandbox/node/bin/node', '/opt/grunt-sandbox/agent.mjs']);
    expect(calls[0]!.args).toEqual(['-d', DISTRO, '-u', 'grunt', '--exec', '/opt/grunt-sandbox/node/bin/node', '/opt/grunt-sandbox/agent.mjs']);
  });
});
