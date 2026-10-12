import { describe, expect, it } from 'vitest';
import type { SandboxRunResult } from '@grunt/core/ports/sandbox.js';
import { otherSpelling, PROTECTED_PROBES, runSelfTest, selfTestCases, shellQuote, type SelfTestCase } from '../src/selftest.js';

const places = { rwLinux: "/mnt/c/Users/O'Brien/rw", roLinux: '/mnt/c/st/ro', gateway: '172.20.48.1', gruntPort: 4747 };
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
        `echo no > ${shellQuote('/mnt/c/st/RO/nope.txt')}`,
        `echo no > ${shellQuote("/mnt/c/Users/O'Brien/rw/.git/hooks/x")}`,
        `echo no > ${shellQuote("/mnt/c/Users/O'Brien/rw/.claude/settings.local.json")}`,
        `echo no > ${shellQuote("/mnt/c/Users/O'Brien/rw/.vscode/tasks.json")}`,
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

  it('wants a refusal (not a missing path) from the write cases spelt as on disk', () => {
    const cases = selfTestCases(places);
    const writes = cases.filter((c) => c.expect === 'blocked' && c.command.startsWith('echo no > ') && !c.command.includes('/RO/'));
    expect(writes).toHaveLength(1 + PROTECTED_PROBES.length);
    for (const write of writes) {
      expect(write.expectOutput?.test('bash: x: Read-only file system')).toBe(true);
      expect(write.expectOutput?.test('bash: x: No such file or directory')).toBe(false);
    }
  });

  it('tries the read-only folder in another spelling, and then checks that nothing landed in it', () => {
    const cases = selfTestCases(places);
    const i = cases.findIndex((c) => c.command === `echo no > ${shellQuote('/mnt/c/st/RO/nope.txt')}`);
    expect(cases[i]).toMatchObject({ expect: 'blocked' });
    // In the command's view that spelling is no folder at all, which is a refusal too.
    expect(cases[i]?.expectOutput?.test('bash: x: No such file or directory')).toBe(true);
    expect(cases[i + 1]).toMatchObject({ expect: 'ok', command: `test ! -e ${shellQuote('/mnt/c/st/ro/nope.txt')}` });
  });

  it('writes protected files in another spelling, wants the agent to say it undid each, then checks they are gone', () => {
    const cases = selfTestCases(places);
    const i = cases.findIndex((c) => c.name === 'protected files written in another spelling are undone');
    const rw = "'/mnt/c/Users/O'\\''Brien/rw";
    expect(cases[i]).toMatchObject({
      expect: 'ok',
      command: `echo no > ${rw}/.GIT/hooks/x' && echo no > ${rw}/.CLAUDE/settings.local.json' && echo no > ${rw}/.VSCODE/tasks.json'`,
    });
    const said = cases[i]!.expectOutput!;
    expect(said.test('The sandbox undid changes to .vscode/tasks.json, .git/hooks/x, .claude/settings.local.json (protected files).')).toBe(true);
    expect(said.test('The sandbox undid changes to .git/hooks/x, .vscode/tasks.json (protected files).')).toBe(false);
    expect(said.test('')).toBe(false);
    // The settings file was there before (rewriting it is the attack): it must hold what it held.
    expect(cases[i + 1]).toMatchObject({
      expect: 'ok',
      command: `test ! -e ${rw}/.git/hooks/x' && test "$(cat ${rw}/.claude/settings.local.json')" = '{}' && test ! -e ${rw}/.vscode/tasks.json'`,
    });
  });

  it('spells a name the other way round', () => {
    expect(otherSpelling('/mnt/c/st/ro')).toBe('/mnt/c/st/RO');
    expect(otherSpelling('.Git')).toBe('.gIT');
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

  it("throws when a case that should work runs but its output doesn't show what it should", async () => {
    const said: SelfTestCase[] = [{ name: 'undone', command: 'echo no > .GIT/x', expect: 'ok', allowedHosts: [], expectOutput: /undid changes/ }];
    await expect(runSelfTest(said, async () => result(0, ''), () => {})).rejects.toThrow(/"undone" ran, but its output doesn't show what it should/);
    await expect(runSelfTest(said, async () => result(0, 'The sandbox undid changes to .git/x (protected files).'), () => {})).resolves.toBeUndefined();
    await expect(runSelfTest(said, async () => result(1, 'undid changes'), () => {})).rejects.toThrow(/"undone" failed/);
  });

  it('throws when a case that should work fails, and counts a timeout as a failure', async () => {
    await expect(runSelfTest(cases, async () => ({ ...result(null), timedOut: true }), () => {})).rejects.toThrow(/"works" failed/);
  });
});
