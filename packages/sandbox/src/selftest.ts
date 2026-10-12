import type { SandboxRunResult } from '@grunt/core/ports/sandbox.js';

/** One check run inside the inner sandbox as grunt (spec 2026-10-12-sandbox-design §4, "Self-test"). */
export interface SelfTestCase {
  name: string;
  command: string;
  /** 'ok': must exit 0. 'blocked': must not. */
  expect: 'ok' | 'blocked';
  allowedHosts: string[];
}

/** Where the self-test's folders are in the sandbox, and how to reach Grunt from the VM. */
export interface SelfTestPlaces {
  /** The self-test chat's workspace, mounted read-write. */
  rwLinux: string;
  /** A read-only folder with hello.txt in it. */
  roLinux: string;
  /** A read-only folder inside the read-write one (mounted under it read-write; only the runtime keeps it read-only). */
  lockedLinux: string;
  /** The Windows host as the VM sees it (the default route), or null. */
  gateway: string | null;
  /** Grunt's port, or null when not known yet. */
  gruntPort: number | null;
}

/** A word for bash: single-quoted, apostrophes included. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function selfTestCases(p: SelfTestPlaces): SelfTestCase[] {
  const none: string[] = [];
  const cases: SelfTestCase[] = [
    { name: 'a plain command runs', command: 'echo grunt-sandbox-ok', expect: 'ok', allowedHosts: none },
    { name: 'the read-only folder can be read', command: `cat ${shellQuote(`${p.roLinux}/hello.txt`)}`, expect: 'ok', allowedHosts: none },
    { name: 'the read-write folder can be written', command: `echo ok > ${shellQuote(`${p.rwLinux}/written.txt`)}`, expect: 'ok', allowedHosts: none },
    // The agent gives each command its home and a temp folder of its own, both writable.
    { name: "the command's home can be written", command: 'echo ok > "$HOME/written.txt"', expect: 'ok', allowedHosts: none },
    { name: "the command's temp folder can be written", command: 'echo ok > "$TMPDIR/written.txt"', expect: 'ok', allowedHosts: none },
    // The canary for the runtime's proxy sockets: with them hidden, no command has any network, silently.
    { name: 'an allowlisted host is reachable', command: 'curl -sS -m 30 -o /dev/null https://registry.npmjs.org/', expect: 'ok', allowedHosts: ['registry.npmjs.org'] },
    { name: "a path outside the chat's folders is unreadable", command: 'ls /mnt/c/Windows', expect: 'blocked', allowedHosts: none },
    { name: 'the rest of /home is unreadable', command: 'cat /home/grunt/.bashrc', expect: 'blocked', allowedHosts: none },
    { name: "the read-only folder can't be written", command: `echo no > ${shellQuote(`${p.roLinux}/nope.txt`)}`, expect: 'blocked', allowedHosts: none },
    { name: "a read-only folder inside a writable one can't be written", command: `echo no > ${shellQuote(`${p.lockedLinux}/nope.txt`)}`, expect: 'blocked', allowedHosts: none },
    { name: "cmd.exe isn't there", command: 'cmd.exe /c echo hi', expect: 'blocked', allowedHosts: none },
    { name: "Windows programs by path aren't there", command: '/mnt/c/Windows/System32/cmd.exe /c echo hi', expect: 'blocked', allowedHosts: none },
    { name: '/etc/shadow is unreadable', command: 'cat /etc/shadow', expect: 'blocked', allowedHosts: none },
    { name: "a host that isn't allowlisted is refused", command: 'curl -sS -m 15 -o /dev/null https://example.com/', expect: 'blocked', allowedHosts: none },
  ];
  if (p.gateway !== null && p.gruntPort !== null) {
    cases.push({
      name: "Grunt's own API on this machine is unreachable",
      command: `curl -sS -m 10 -o /dev/null http://${p.gateway}:${p.gruntPort}/api/health`,
      expect: 'blocked',
      allowedHosts: none,
    });
  }
  return cases;
}

/** Runs the cases in order; throws on the first one that doesn't behave, so the sandbox is marked failed and not used. */
export async function runSelfTest(cases: SelfTestCase[], run: (c: SelfTestCase) => Promise<SandboxRunResult>, log: (line: string) => void): Promise<void> {
  for (const c of cases) {
    const r = await run(c);
    const succeeded = r.exitCode === 0 && !r.timedOut;
    const passed = c.expect === 'ok' ? succeeded : !succeeded;
    log(`${passed ? '✔' : '✖'} ${c.name}`);
    if (!passed) {
      const what = c.expect === 'ok' ? 'failed' : 'was not blocked';
      throw new Error(`Self-test "${c.name}" ${what} (exit ${String(r.exitCode)}): ${r.output.trim().slice(-500)}`);
    }
  }
}
