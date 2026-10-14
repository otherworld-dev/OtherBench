import type { SandboxRunResult } from '@grunt/core/ports/sandbox.js';
import { INSTALL_DIR, INTEROP_OFF } from './setup.js';

/** One check run inside the inner sandbox as grunt (spec 2026-10-12-sandbox-design §4, "Self-test"). */
export interface SelfTestCase {
  name: string;
  command: string;
  /** 'ok': must exit 0. 'blocked': must not. */
  expect: 'ok' | 'blocked';
  allowedHosts: string[];
  /**
   * The output must also match: for a 'blocked' case, so a command that fails for another reason (a missing
   * folder, a typo) doesn't count as the sandbox blocking it; for an 'ok' case, to see what the sandbox said.
   */
  expectOutput?: RegExp;
  /** How long the command may run; 60 s when absent. */
  timeoutMs?: number;
}

/** What bash prints when a write is refused because the place is read-only or not ours. */
const WRITE_REFUSED = /Read-only file system|Permission denied/;

/** What bash prints when a path doesn't resolve: another spelling of a read-only folder can't reach it. */
const WRITE_REFUSED_OR_MISSING = /Read-only file system|Permission denied|No such file or directory/;

/** Protected files (the agent's PROTECTED_PATHS) the self-test tries to write in the workspace; their folders are there. */
export const PROTECTED_PROBES = ['.git/hooks/x', '.claude/settings.local.json', '.vscode/tasks.json'];

/**
 * The probe that is already there, with this content, before the self-test writes it: rewriting existing
 * settings is the attack. (A MISSING denied file can't be written in any spelling: the runtime's empty
 * placeholder for it comes out read-only on a Windows folder. A new file in a denied folder can.)
 */
export const EXISTING_PROBE = '.claude/settings.local.json';
export const EXISTING_PROBE_CONTENT = '{}';

/** Where the self-test's folders are in the sandbox, and how to reach Grunt from the VM. */
export interface SelfTestPlaces {
  /** The self-test chat's workspace, mounted read-write, with .git/hooks, .claude and .vscode folders in it. */
  rwLinux: string;
  /** A read-only folder beside it (never inside it: the sandbox refuses that), with hello.txt in it. */
  roLinux: string;
  /** The Windows host as the VM sees it (the default route), or null. */
  gateway: string | null;
  /** Grunt's port, or null when not known yet. */
  gruntPort: number | null;
}

/** The path with the case of its last name's letters flipped (`/mnt/c/st/ro` to `/mnt/c/st/RO`): the same Windows folder. */
export function otherSpelling(path: string): string {
  const cut = path.lastIndexOf('/') + 1;
  const flip = (ch: string): string => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
  return path.slice(0, cut) + [...path.slice(cut)].map(flip).join('');
}

/** A protected file's path in the workspace with its first name in another spelling (`.GIT/hooks/x`). */
const respelt = (rel: string): string => {
  const [first = '', ...rest] = rel.split('/');
  return [otherSpelling(first), ...rest].join('/');
};
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    { name: "the read-only folder can't be written", command: `echo no > ${shellQuote(`${p.roLinux}/nope.txt`)}`, expect: 'blocked', allowedHosts: none, expectOutput: WRITE_REFUSED },
    // Windows folders in the VM ignore case: another spelling of the read-only folder must not reach it either.
    {
      name: "the read-only folder can't be written in another spelling",
      command: `echo no > ${shellQuote(`${otherSpelling(p.roLinux)}/nope.txt`)}`,
      expect: 'blocked',
      allowedHosts: none,
      expectOutput: WRITE_REFUSED_OR_MISSING,
    },
    { name: 'nothing landed in the read-only folder', command: `test ! -e ${shellQuote(`${p.roLinux}/nope.txt`)}`, expect: 'ok', allowedHosts: none },
    // Files that would run code on Windows: in their usual spelling the runtime refuses the write...
    ...PROTECTED_PROBES.map(
      (rel): SelfTestCase => ({
        name: `${rel} in the workspace can't be written`,
        command: `echo no > ${shellQuote(`${p.rwLinux}/${rel}`)}`,
        expect: 'blocked',
        allowedHosts: none,
        expectOutput: WRITE_REFUSED,
      })
    ),
    // ...and in another spelling the write lands, but the agent undoes it once the command ends, and says so.
    {
      name: 'protected files written in another spelling are undone',
      command: PROTECTED_PROBES.map((rel) => `echo no > ${shellQuote(`${p.rwLinux}/${respelt(rel)}`)}`).join(' && '),
      expect: 'ok',
      allowedHosts: none,
      expectOutput: new RegExp(`The sandbox undid changes to ${PROTECTED_PROBES.map((rel) => `(?=[^\\n]*${escapeRegExp(rel)})`).join('')}`),
    },
    {
      name: 'the protected files are as they were again',
      command: PROTECTED_PROBES.map((rel) => {
        const path = shellQuote(`${p.rwLinux}/${rel}`);
        return rel === EXISTING_PROBE ? `test "$(cat ${path})" = ${shellQuote(EXISTING_PROBE_CONTENT)}` : `test ! -e ${path}`;
      }).join(' && '),
      expect: 'ok',
      allowedHosts: none,
    },
    { name: "cmd.exe isn't there", command: 'cmd.exe /c echo hi', expect: 'blocked', allowedHosts: none },
    { name: "Windows programs by path aren't there", command: '/mnt/c/Windows/System32/cmd.exe /c echo hi', expect: 'blocked', allowedHosts: none },
    // The same check setup runs as root, here as grunt inside the runtime: tries to start a Windows program, also
    // pointed at each interop socket, and says INTEROP_OFF (exit 0) only if every attempt fails the way it does with
    // interop off. Exit 3 (interop on) or 4 (couldn't tell) fails the self-test. Each attempt can take about 10 s.
    {
      name: "Windows programs can't be started, even pointed at an interop socket",
      command: `/bin/sh ${INSTALL_DIR}/interop-check.sh`,
      expect: 'ok',
      allowedHosts: none,
      expectOutput: new RegExp(`^${INTEROP_OFF}$`, 'm'),
      timeoutMs: 180_000,
    },
    { name: '/etc/shadow is unreadable', command: 'cat /etc/shadow', expect: 'blocked', allowedHosts: none },
    { name: "a host that isn't allowlisted is refused", command: 'curl -sS -m 15 -o /dev/null https://example.com/', expect: 'blocked', allowedHosts: none },
  ];
  if (p.gateway !== null && p.gruntPort !== null) {
    // Straight at the machine, not through the runtime's proxy (which would answer 403 and prove nothing about the
    // network boundary). curl exits 0 on any HTTP status, so "blocked" is: the connection failed (non-zero exit) and
    // no HTTP status came back (http_code=000), whatever Grunt would have answered.
    cases.push({
      name: "Grunt's own API on this machine is unreachable",
      command: `curl -sS --noproxy '*' -m 10 -o /dev/null -w 'http_code=%{http_code}' http://${p.gateway}:${p.gruntPort}/api/health`,
      expect: 'blocked',
      allowedHosts: none,
      expectOutput: /http_code=000/,
    });
    // In sign-in mode (remote access) Grunt's port speaks HTTPS only, and a plain-HTTP request to it gets no HTTP
    // status either (the TLS handshake fails), so the check above would pass even if the port were reachable.
    // The same check over HTTPS (any certificate) covers that port: whichever one Grunt speaks answers if reachable.
    cases.push({
      name: "Grunt's own API on this machine is unreachable over HTTPS too",
      command: `curl -sS -k --noproxy '*' -m 10 -o /dev/null -w 'http_code=%{http_code}' https://${p.gateway}:${p.gruntPort}/api/health`,
      expect: 'blocked',
      allowedHosts: none,
      expectOutput: /http_code=000/,
    });
  }
  return cases;
}

/** Runs the cases in order; throws on the first one that doesn't behave, so the sandbox is marked failed and not used. */
export async function runSelfTest(cases: SelfTestCase[], run: (c: SelfTestCase) => Promise<SandboxRunResult>, log: (line: string) => void): Promise<void> {
  for (const c of cases) {
    const r = await run(c);
    const succeeded = r.exitCode === 0 && !r.timedOut;
    const unexpected = c.expectOutput !== undefined && !c.expectOutput.test(r.output);
    const wrongWay = c.expect === 'blocked' && !succeeded && unexpected;
    const passed = c.expect === 'ok' ? succeeded && !unexpected : !succeeded && !wrongWay;
    log(`${passed ? '✔' : '✖'} ${c.name}`);
    if (!passed) {
      const what =
        c.expect === 'ok'
          ? succeeded
            ? `ran, but its output doesn't show what it should (expected ${String(c.expectOutput)})`
            : 'failed'
          : wrongWay
            ? `failed, but not the way a block does (expected ${String(c.expectOutput)})`
            : 'was not blocked';
      throw new Error(`Self-test "${c.name}" ${what} (exit ${String(r.exitCode)}): ${r.output.trim().slice(-500)}`);
    }
  }
}
