import { describe, expect, it } from 'vitest';
import type { SandboxRunResult } from '@grunt/core/ports/sandbox.js';
import { runSelfTest, selfTestCases, shellQuote, type SelfTestCase } from '../src/selftest.js';

const places = { rwLinux: "/mnt/c/Users/O'Brien/rw", roLinux: '/mnt/c/st/ro', lockedLinux: "/mnt/c/Users/O'Brien/rw/locked", gateway: '172.20.48.1', gruntPort: 4747 };
const result = (exitCode: number | null, output = ''): SandboxRunResult => ({ command: '', exitCode, signal: null, timedOut: false, truncated: false, timeoutMsUsed: 60_000, output, sandbox: true, cwd: '/' });

describe('selfTestCases', () => {
  it("covers the spec's list: unmounted paths, read-only folders, Windows programs, /etc/shadow, an unlisted host, Grunt's own port, and an allowlisted host", () => {
    const cases = selfTestCases(places);
    const blocked = cases.filter((c) => c.expect === 'blocked').map((c) => c.command);
    expect(blocked).toEqual(
      expect.arrayContaining([
        'ls /mnt/c/Windows',
        'cat /home/grunt/.bashrc',
        `echo no > ${shellQuote('/mnt/c/st/ro/nope.txt')}`,
        `echo no > ${shellQuote("/mnt/c/Users/O'Brien/rw/locked/nope.txt")}`,
        'cmd.exe /c echo hi',
        '/mnt/c/Windows/System32/cmd.exe /c echo hi',
        'cat /etc/shadow',
        'curl -sS -m 15 -o /dev/null https://example.com/',
        "curl -sS --noproxy '*' -m 10 -o /dev/null -w 'http_code=%{http_code}' http://172.20.48.1:4747/api/health",
      ])
    );
    expect(cases.find((c) => c.command.includes('registry.npmjs.org'))).toMatchObject({ expect: 'ok', allowedHosts: ['registry.npmjs.org'] });
    expect(cases.find((c) => c.command.includes('example.com'))?.allowedHosts).toEqual([]);
  });

  it("checks that a command's own home and temp folder are writable", () => {
    const ok = selfTestCases(places).filter((c) => c.expect === 'ok').map((c) => c.command);
    expect(ok).toEqual(expect.arrayContaining(['echo ok > "$HOME/written.txt"', 'echo ok > "$TMPDIR/written.txt"']));
  });

  it('has a positive control for the nested read-only folder, and wants a refusal (not a missing path) from the write cases', () => {
    const cases = selfTestCases(places);
    expect(cases.find((c) => c.expect === 'ok' && c.command === `test -d ${shellQuote(places.lockedLinux)}`)).toBeDefined();
    const write = cases.find((c) => c.command.includes('locked/nope.txt'));
    expect(write?.expectOutput?.test('bash: x: Read-only file system')).toBe(true);
    expect(write?.expectOutput?.test('bash: x: No such file or directory')).toBe(false);
  });

  it("decides the Grunt-port check on the connection failing with no HTTP status, not on what Grunt answers", () => {
    const grunt = selfTestCases(places).find((c) => c.command.includes('/api/health'));
    expect(grunt?.expectOutput?.test('curl: (7) Failed to connect\nhttp_code=000')).toBe(true);
    expect(grunt?.expectOutput?.test('http_code=403')).toBe(false);
  });

  it("leaves out the Grunt-port check when the gateway or the port isn't known", () => {
    expect(selfTestCases({ ...places, gruntPort: null }).some((c) => c.command.includes('/api/health'))).toBe(false);
    expect(selfTestCases({ ...places, gateway: null }).some((c) => c.command.includes('/api/health'))).toBe(false);
  });

  it('quotes paths for bash, apostrophes included', () => {
    expect(shellQuote("/mnt/c/Users/O'Brien")).toBe("'/mnt/c/Users/O'\\''Brien'");
  });
});

describe('runSelfTest', () => {
  const cases: SelfTestCase[] = [
    { name: 'works', command: 'echo ok', expect: 'ok', allowedHosts: [] },
    { name: 'is blocked', command: 'cat /etc/shadow', expect: 'blocked', allowedHosts: [] },
  ];

  it('passes when every case behaves, logging each', async () => {
    const log: string[] = [];
    await runSelfTest(cases, async (c) => result(c.expect === 'ok' ? 0 : 1), (l) => log.push(l));
    expect(log).toEqual(['✔ works', '✔ is blocked']);
  });

  it('throws on the first case that was not blocked, with its output', async () => {
    await expect(runSelfTest(cases, async () => result(0, 'root:*:19000:0:99999:7:::'), () => {})).rejects.toThrow(/"is blocked" was not blocked \(exit 0\): root:/);
  });

  it('throws when a blocked case fails the wrong way (output not matching expectOutput), and passes when it matches', async () => {
    const guarded: SelfTestCase[] = [{ name: 'write refused', command: 'echo no > /x', expect: 'blocked', allowedHosts: [], expectOutput: /Read-only file system/ }];
    await expect(runSelfTest(guarded, async () => result(1, 'bash: /x: No such file or directory'), () => {})).rejects.toThrow(/"write refused" failed, but not the way a block does.*No such file/);
    await expect(runSelfTest(guarded, async () => result(1, 'bash: /x: Read-only file system'), () => {})).resolves.toBeUndefined();
    await expect(runSelfTest(guarded, async () => result(0, ''), () => {})).rejects.toThrow(/was not blocked/);
  });

  it('throws when a case that should work fails, and counts a timeout as a failure', async () => {
    await expect(runSelfTest(cases, async () => ({ ...result(null), timedOut: true }), () => {})).rejects.toThrow(/"works" failed/);
  });
});
