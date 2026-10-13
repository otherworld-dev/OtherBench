// Grunt's sandbox agent (spec 2026-10-12-sandbox-design §2). It runs inside the
// grunt-sandbox WSL distro as the grunt user, one process per chat, and runs
// every command through Anthropic's sandbox runtime: confined to the chat's
// folders, its home and a temp folder of its own, with network only through
// the runtime's proxy. JSON lines in (stdin) and out (stdout); the messages
// are mirrored in ../src/protocol.ts, so change both together.
//
// This file imports nothing, so tests drive it with a fake runtime; agent.mjs
// wires it to the real runtime, to stdin/stdout, to Node and to process.env.
//
// The host is trusted to speak the protocol, not to be well-formed: ids, paths
// and timeouts are checked before they reach the file system or a timer. One
// command runs at a time per agent (Grunt serialises them too); a second `run`
// while one is in flight is refused.
//
// Temp folders, and why they are laid out the way they are (found by running
// the real runtime 0.0.79 in the distro):
//  - /tmp is unreadable inside a command (DENY_READ), so another chat's temp
//    files can't be seen. But the runtime puts its network proxy sockets in the
//    os.tmpdir() of THIS process, and a hidden socket means no command has any
//    network. So at init TMPDIR is pointed at ${tmpRoot}/rt, which every
//    command may read (allowRead), and the runtime's sockets live there.
//  - The runtime sets the command's own TMPDIR itself, from this process's
//    CLAUDE_CODE_TMPDIR at the moment wrapWithSandboxArgv is called (a TMPDIR
//    in the spawn env is overridden). So each run points CLAUDE_CODE_TMPDIR at
//    its own folder, ${tmpRoot}/${id}, right before wrapping. Runs are serialised
//    per agent, so this process-global is safe.
//  - A path in allowRead that is the PARENT of a path in allowWrite is bound
//    read-only over it. So tmpRoot itself is never in allowRead (only rt and the
//    run's own folder are), or the run's folder would come out read-only.
//
// Private networks. A command may reach the public internet and nothing else,
// by the same rule as Grunt's own browser (isPublicAddress in core's
// browser-hosts.ts). The runtime always refuses loopback, link-local, this
// host's own addresses and cloud metadata at connect time, on the address it
// actually dials (so a name that resolves to one is caught even when it changes
// between the check and the connect). It refuses the rest only when told to,
// which is DENIED_RESOLVED_ADDRESSES in the network config: everything
// isPrivateAddress refuses, as ranges. On top of that ask() resolves a host
// before bothering Grunt with a card, and answers no when the name can't be
// resolved or any address is one the sandbox must not reach. For a name that is
// an early refusal only: the runtime's check is the enforcement. For a host
// given as a number it is the only check (the runtime doesn't judge those).
//
// Protected files. Some files in a folder make something run when the folder is
// next used ON WINDOWS: git's hooks and config (Git for Windows, and VS Code
// runs git on its own), VS Code's tasks and settings, Claude Code's project
// settings and hooks (Grunt's own Claude Code engine loads them), MCP server
// lists. The runtime keeps a command off them, but only (a) in this process's
// own working folder, so the agent moves there while it wraps a command, and
// (b) by their exact spelling, while Windows folders in the VM are
// case-insensitive: `.GIT/hooks/x` lands in .git/hooks past the runtime's
// guard. So the agent itself, outside the inner sandbox, copies those paths in
// every folder the command can write before it runs, and puts them back after
// it ends (done, timed out, cancelled or failed), saying what it undid.

/** Combined stdout+stderr kept per command, as run_command keeps on the host. */
export const MAX_OUTPUT_BYTES = 100 * 1024;
/** Between SIGTERM and SIGKILL when a command times out or is cancelled. */
export const KILL_GRACE_MS = 2000;
/** The longest a command may run, whatever the host asks for (run_command's cap). */
export const MAX_TIMEOUT_MS = 600_000;
/** The runtime's note on what it blocked is kept to this many bytes. */
export const MAX_NOTE_BYTES = 4096;
/** PATH for commands: Grunt's Node first (so node and npm work), then the system's. */
export const COMMAND_PATH = '/opt/grunt-sandbox/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Unreadable unless a run allows a path below them: other chats' folders, homes and temp files. */
export const DENY_READ = ['/mnt', '/home', '/tmp'];

/** The longest ask() waits for a host name to resolve before refusing it. */
export const LOOKUP_TIMEOUT_MS = 5000;

/**
 * Paths below each folder a command can write (and its home) that the agent
 * puts back after the command: relative, in their usual spelling. A folder at
 * one of them is kept whole, except those in SHALLOW_PROTECTED (only their own
 * entries). The runtime also gets each as a write deny (the .git ones only when
 * .git is a folder, as the runtime does: a deny there would stop `git init`).
 */
export const PROTECTED_PATHS = [
  '.git/hooks',
  '.git/config',
  '.gitmodules',
  '.gitconfig',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.ripgreprc',
  '.mcp.json',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.vscode',
  '.idea',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks',
  '.claude/commands',
  '.claude/agents',
  '.claude/skills',
];
const SHALLOW_PROTECTED = new Set(['.idea']);
/** A protected file bigger than this refuses the run: the agent couldn't put it back. */
export const MAX_PROTECTED_FILE_BYTES = 1024 * 1024;
/** Nor more than this in all, per run. */
export const MAX_PROTECTED_BYTES = 8 * 1024 * 1024;
/** Nor more files and folders than this, per run. */
export const MAX_PROTECTED_ENTRIES = 10_000;
/** How many undone paths the note names before "and N more". */
const MAX_NAMED_UNDONE = 20;

/** Slack on top of KILL_GRACE_MS that close() waits for a killed command to report. */
const CLOSE_MARGIN_MS = 500;

/**
 * @typedef {{ host: string, port?: number }} HostPattern
 * @typedef {{
 *   initialize(config: object, ask: (p: HostPattern) => Promise<boolean>): Promise<void>,
 *   updateConfig(config: object): void,
 *   wrapWithSandboxArgv(command: string, shell: string, custom: object, signal: AbortSignal, cwd: string, options: object): Promise<{ argv: string[], env: Record<string, string | undefined> }>,
 *   annotateStderrWithSandboxFailures(commandId: string, stderr: string): string,
 *   cleanupAfterCommand(): void,
 *   reset(): Promise<void>,
 * }} Runtime
 * @typedef {{
 *   runtime: Runtime,
 *   spawn: typeof import('node:child_process').spawn,
 *   send: (message: object) => void,
 *   mkdir: (path: string, options: object) => Promise<unknown>,
 *   rm: (path: string, options: object) => Promise<unknown>,
 *   lstat: (path: string) => Promise<{ isSymbolicLink(): boolean, isDirectory(): boolean, isFile(): boolean, size: number, ino: number, dev: number, mode: number }>,
 *   realpath: (path: string) => Promise<string>,
 *   readFile: (path: string) => Promise<Uint8Array>,
 *   createFile: (path: string, data: Uint8Array, mode: number) => Promise<unknown>,
 *   chmod: (path: string, mode: number) => Promise<unknown>,
 *   readdir: (path: string) => Promise<string[]>,
 *   readlink: (path: string) => Promise<string>,
 *   symlink: (target: string, path: string) => Promise<unknown>,
 *   chdir: (path: string) => void,
 *   cwd: () => string,
 *   warn?: (message: string) => void,
 *   kill: (pid: number, signal: string) => void,
 *   exit: (code: number) => void,
 *   env: Record<string, string | undefined>,
 *   lookup: (host: string) => Promise<Array<{ address: string }>>,
 * }} AgentDeps
 */

/** Length in UTF-8 bytes of one code point (a lone surrogate encodes as U+FFFD, three bytes). @param {number} cp */
const codePointBytes = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** The longest prefix of `text` that encodes to at most `maxBytes` of UTF-8, cut between characters. */
function fit(text, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    bytes += codePointBytes(/** @type {number} */ (ch.codePointAt(0)));
    if (bytes > maxBytes) break;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** A path that is absolute in the distro (the drive-letter form is accepted so tests can use the host's temp folder). */
const isAbsolute = (value) => typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
const strings = (value) => (Array.isArray(value) ? value.map(String) : []);
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

// Addresses the sandbox must not reach.
//
// The rule is core's isPublicAddress (packages/core/src/domain/browser-hosts.ts),
// the one Grunt's browser and the sandbox's network card use: an address may be
// reached only when it is on the public internet. This script runs in the VM
// and can't import core, so the two tables and the reading of an address below
// are its own copy of core's. sandbox/test/agent-addresses.test.ts holds the
// copy to core: the tables must be equal, isPrivateAddress must answer
// !isPublicAddress (at every range boundary, for every IPv6 form that carries
// an IPv4 address, across a seeded sample and for text that isn't an address),
// and DENIED_RESOLVED_ADDRESSES must cover exactly what isPrivateAddress
// refuses. core's testing/shared-host-vectors.ts lists the cases by name.
// Change a range in core and here together.

/** IPv4 ranges that are not the public internet: [a, b, c, d, prefix length]. Core's V4_NOT_PUBLIC, row for row. */
export const V4_NOT_PUBLIC = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10], // CGNAT
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16], // link-local, cloud metadata
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // TEST-NET-1
  [192, 88, 99, 0, 24], // 6to4 relay anycast
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // TEST-NET-2
  [203, 0, 113, 0, 24], // TEST-NET-3
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, broadcast
];

/**
 * Blocks of global unicast (2000::/3) that are not the public internet either:
 * [first group, second group, prefix length]. Core's V6_GLOBAL_NOT_PUBLIC, row
 * for row.
 */
export const V6_GLOBAL_NOT_PUBLIC = [
  [0x2001, 0x0000, 23], // IETF protocol assignments (Teredo, ORCHID, ...)
  [0x2001, 0x0db8, 32], // documentation
  [0x3fff, 0x0000, 20], // documentation (RFC 9637)
];

/** An IPv6 block: its eight groups (those given, then zeros) and its prefix length. @param {number[]} groups @param {number} prefix */
const block = (groups, prefix) => ({ g: [...groups, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8), prefix });
/** The only IPv6 that is the public internet, less the blocks above. */
const GLOBAL_UNICAST = block([0x2000], 3);
/** The IPv6 forms that carry an IPv4 address and are judged by it: ::ffff:a.b.c.d, 64:ff9b::a.b.c.d (both in the last two groups) and 2002:aabb:ccdd:: (in the second and third). */
const V4_MAPPED = block([0, 0, 0, 0, 0, 0xffff], 96);
const NAT64 = block([0x64, 0xff9b], 96);
const SIX_TO_FOUR = block([0x2002], 16);

/** The four numbers of a dotted-decimal IPv4 address, or null for anything else (leading zeros included: some parsers read them as octal). @param {string} text */
function parseIpv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return null;
    octets.push(Number(part));
  }
  return octets;
}

/**
 * The eight 16-bit groups of an IPv6 address, or null: `::`, a dotted IPv4 tail
 * and a `%zone` are read, brackets are not. Core's parseIPv6, step for step, so
 * the two never read the same text differently. @param {string} text
 */
function parseIpv6(text) {
  let s = text;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let v4Tail = [];
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    if (cut < 0) return null;
    const v4 = parseIpv4(s.slice(cut + 1));
    if (!v4) return null;
    v4Tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, cut + 1);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => {
    if (part === '') return [];
    const out = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !rest) return null;
  const total = 8 - v4Tail.length;
  if (halves.length === 2) {
    const fill = total - head.length - rest.length;
    if (fill < 1) return null;
    return [...head, ...Array(fill).fill(0), ...rest, ...v4Tail];
  }
  return head.length === total ? [...head, ...v4Tail] : null;
}

/** Whether the eight groups `g` are inside an IPv6 block. @param {number[]} g @param {{ g: number[], prefix: number }} range */
function inBlock(g, range) {
  for (let bit = 0; bit < range.prefix; bit += 1) {
    const mask = 1 << (15 - (bit & 15));
    if ((g[bit >> 4] & mask) !== (range.g[bit >> 4] & mask)) return false;
  }
  return true;
}

/** The IPv4 address (its four numbers) in the two groups of `g` from `at`. @param {number[]} g @param {number} at */
const v4In = (g, at) => [g[at] >> 8, g[at] & 0xff, g[at + 1] >> 8, g[at + 1] & 0xff];
/** @param {number[]} o */
const v4Number = (o) => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;

/** @param {number[]} o */
function isPublicIpv4(o) {
  const ip = v4Number(o);
  return !V4_NOT_PUBLIC.some(([a, b, c, d, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((ip & mask) >>> 0) === ((v4Number([a, b, c, d]) & mask) >>> 0);
  });
}

/** Core's isPublicV6, step for step. @param {number[]} g */
function isPublicIpv6(g) {
  if (inBlock(g, V4_MAPPED) || inBlock(g, NAT64)) return isPublicIpv4(v4In(g, 6));
  // Only 2000::/3 is global unicast: this also refuses ::, ::1, ::a.b.c.d,
  // 100::/64, 64:ff9b:1::/48, fc00::/7, fe80::/10, fec0::/10 and ff00::/8.
  if (!inBlock(g, GLOBAL_UNICAST)) return false;
  if (V6_GLOBAL_NOT_PUBLIC.some(([a, b, prefix]) => inBlock(g, block([a, b], prefix)))) return false;
  if (inBlock(g, SIX_TO_FOUR)) return isPublicIpv4(v4In(g, 1));
  return true;
}

/**
 * Whether a resolved address is one the sandbox must not reach: anything but
 * the public internet. The answer is !isPublicAddress(address) of core's
 * browser-hosts.ts for every string, so loopback, unspecified, private-use,
 * CGNAT, link-local, multicast, reserved, documentation and the other
 * special-purpose blocks in IPv4; all of IPv6 outside global unicast (2000::/3)
 * and the special blocks inside it; and an IPv4 address carried in IPv6
 * (v4-mapped, NAT64, 6to4) by the IPv4 address it carries. An address that
 * can't be read counts as private: the answer is no when in doubt.
 * @param {unknown} address
 */
export function isPrivateAddress(address) {
  if (typeof address !== 'string') return true;
  const v4 = parseIpv4(address);
  if (v4) return !isPublicIpv4(v4);
  const g = parseIpv6(address);
  return g ? !isPublicIpv6(g) : true;
}

/** An IPv6 address (its eight groups) as text, its longest run of zero groups as `::`. @param {number[]} g */
function ipv6Text(g) {
  let start = 0;
  let length = 0;
  for (let i = 0; i < 8; i += 1) {
    let end = i;
    while (end < 8 && g[end] === 0) end += 1;
    if (end - i > length) [start, length] = [i, end - i];
  }
  const text = (part) => part.map((x) => x.toString(16)).join(':');
  return length < 2 ? text(g) : `${text(g.slice(0, start))}::${text(g.slice(start + length))}`;
}

/**
 * An IPv6 block less the `holes` inside it, as whole blocks: it is halved until
 * each piece is clear of every hole (kept) or inside one (dropped).
 * @param {{ g: number[], prefix: number }} range @param {Array<{ g: number[], prefix: number }>} holes
 * @returns {Array<{ g: number[], prefix: number }>}
 */
function outside(range, holes) {
  if (holes.some((hole) => hole.prefix <= range.prefix && inBlock(range.g, hole))) return [];
  if (!holes.some((hole) => inBlock(hole.g, range))) return [range];
  const upper = [...range.g];
  upper[range.prefix >> 4] |= 1 << (15 - (range.prefix & 15));
  return [...outside({ g: range.g, prefix: range.prefix + 1 }, holes), ...outside({ g: upper, prefix: range.prefix + 1 }, holes)];
}

/** An IPv4 range inside an IPv6 form that carries IPv4 from group `at`. @param {{ g: number[], prefix: number }} form @param {number} at @param {number[]} range */
function carried(form, at, [a, b, c, d, prefix]) {
  const g = [...form.g];
  g[at] = (a << 8) | b;
  g[at + 1] = (c << 8) | d;
  return { g, prefix: form.prefix + prefix };
}

/**
 * Addresses a permitted host name must not resolve to, given to the runtime as
 * `deniedResolvedAddresses`, which it enforces on the address it dials: all
 * that isPrivateAddress refuses and nothing else, as CIDR ranges built from the
 * same tables.
 *  - every IPv4 range in V4_NOT_PUBLIC;
 *  - all of IPv6 outside global unicast, less the two forms there that carry an
 *    IPv4 address (::ffff:0:0/96 and 64:ff9b::/96): one range can't leave a
 *    hole, so this is some 180 of them, down to /96 on each side of both;
 *  - the special blocks of global unicast (V6_GLOBAL_NOT_PUBLIC);
 *  - every IPv4 range again inside NAT64 and inside 6to4.
 * The v4-mapped form has no entries of its own, because the runtime can't hold
 * one: it reads a v4-mapped range as the IPv4 range itself, and it matches a
 * v4-mapped address against the IPv4 entries. So the IPv4 ranges cover it.
 * (The runtime also applies the IPv4 entries to the IPv4 address in a NAT64 or
 * 6to4 answer. Those are listed anyway, so the list doesn't lean on that.)
 */
export const DENIED_RESOLVED_ADDRESSES = [
  ...V4_NOT_PUBLIC.map(([a, b, c, d, prefix]) => `${a}.${b}.${c}.${d}/${prefix}`),
  ...[
    ...outside(block([], 0), [GLOBAL_UNICAST, V4_MAPPED, NAT64]),
    ...V6_GLOBAL_NOT_PUBLIC.map(([a, b, prefix]) => block([a, b], prefix)),
    ...V4_NOT_PUBLIC.flatMap((range) => [carried(NAT64, 6, range), carried(SIX_TO_FOUR, 1, range)]),
  ].map((range) => `${ipv6Text(range.g)}/${range.prefix}`),
];

/** @param {AgentDeps} deps */
export function createAgent(deps) {
  const { runtime, spawn, send, mkdir, rm, lstat, realpath, kill, exit, env, lookup } = deps;
  const { readFile, createFile, chmod, readdir, readlink, symlink, chdir, cwd } = deps;
  const warn = deps.warn ?? (() => undefined);
  /** new -> initialising -> ready -> closing; dead after a failed init. */
  let phase = 'new';
  /** Set once the runtime has started; realTmpRoot is tmpRoot with every link resolved. @type {{ home: string, tmpRoot: string, realTmpRoot: string, rt: string, allowedHosts: string[] } | null} */
  let chat = null;
  /**
   * The one command in flight. `restore` puts its protected files back (once, however often it is called) and
   * says what it did; null until they are copied.
   * @type {{ id: number, controller: AbortController, done: Promise<void>, restore: (() => Promise<string>) | null } | null}
   */
  let active = null;
  /** @type {Map<number, (allowed: boolean) => void>} */
  const asks = new Map();
  let nextAskId = 1;

  /** What the runtime is started with, and told again when the allowlist changes: no run's folders. */
  const baseFilesystem = (c) => ({ denyRead: DENY_READ, allowRead: [c.home, c.rt], allowWrite: [c.home], denyWrite: [] });
  /** What one command gets: the chat's folders, the home, the runtime's socket folder (read) and its own temp folder. */
  const runFilesystem = (readPaths, writePaths, denyWritePaths, tmp) => ({
    denyRead: DENY_READ,
    allowRead: [...readPaths, chat.home, chat.rt, tmp],
    allowWrite: [...writePaths, chat.home, tmp],
    denyWrite: [...denyWritePaths],
  });
  const config = (c, allowedHosts) => ({
    network: { allowedDomains: [...allowedHosts], deniedDomains: [], allowLocalBinding: false, deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES },
    filesystem: baseFilesystem(c),
  });

  /** Whether a host name resolves, within LOOKUP_TIMEOUT_MS, to public addresses only. Any failure is a no. @param {string} host */
  async function resolvesToPublicOnly(host) {
    let timer;
    try {
      const addresses = await Promise.race([
        lookup(host),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The lookup timed out.')), LOOKUP_TIMEOUT_MS);
        }),
      ]);
      return Array.isArray(addresses) && addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry?.address));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The runtime's "may this host be reached?" callback: Grunt raises the card and
   * answers. A host that doesn't resolve, or resolves anywhere private, is
   * refused here without a card, since the runtime would refuse the connection
   * anyway. @param {HostPattern} pattern
   */
  async function ask({ host, port }) {
    if (phase === 'closing') return false;
    const during = active;
    if (!(await resolvesToPublicOnly(String(host)))) return false;
    // The run (or the agent) may have ended while the name was resolving: nobody is waiting for a card.
    if (phase === 'closing' || active !== during || during?.controller.signal.aborted) return false;
    const askId = nextAskId++;
    send({ type: 'ask', askId, host: String(host), port: typeof port === 'number' ? port : null });
    return new Promise((resolve) => asks.set(askId, resolve));
  }

  /** Runs are serialised, so every outstanding ask belongs to the run that is ending: its command is gone, nobody is waiting on an answer. */
  function refuseAsks() {
    for (const resolve of asks.values()) resolve(false);
    asks.clear();
  }

  async function init(msg) {
    if (phase !== 'new') return;
    if (!isAbsolute(msg.home) || !isAbsolute(msg.tmpRoot)) {
      phase = 'dead';
      send({ type: 'fatal', message: 'The sandbox agent was started without absolute home and temp folders.' });
      exit(1);
      return;
    }
    phase = 'initialising';
    const tmpRoot = msg.tmpRoot;
    const next = { home: msg.home, tmpRoot, realTmpRoot: tmpRoot, rt: `${tmpRoot}/rt`, allowedHosts: strings(msg.allowedHosts) };
    try {
      await mkdir(next.home, { recursive: true, mode: 0o700 });
      await mkdir(next.tmpRoot, { recursive: true, mode: 0o700 });
      await mkdir(next.rt, { recursive: true, mode: 0o700 });
      // mkdir -p is happy with a link to a folder; the leaves must be real folders
      // (this agent deletes below tmpRoot, and commands may write to home).
      for (const folder of [next.home, next.tmpRoot, next.rt]) {
        const st = await lstat(folder);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${folder} is not a plain folder.`);
      }
      next.realTmpRoot = await realpath(next.tmpRoot);
      // Before initialize: the runtime puts its proxy sockets in os.tmpdir().
      env.TMPDIR = next.rt;
      await runtime.initialize(config(next, next.allowedHosts), ask);
    } catch (err) {
      // A close that arrived while the runtime was starting has already exited us.
      if (phase !== 'initialising') return;
      phase = 'dead';
      send({ type: 'fatal', message: errorMessage(err) });
      exit(1);
      return;
    }
    // A close that arrived while the runtime was starting wins.
    if (phase !== 'initialising') return;
    chat = next;
    phase = 'ready';
    send({ type: 'ready' });
  }

  /**
   * Deletes a run's temp folder. The agent runs outside the inner sandbox and the
   * command could write to that folder, so before deleting anything it checks that
   * the path is still a real folder (not a link) that resolves to exactly
   * ${tmpRoot}/${id}. Anything else is left alone and noted, never thrown: the
   * run's reply must not depend on it. rm -r unlinks a link below the folder
   * instead of following it; never swap in anything that dereferences.
   * (A command that outlives its run could still swap the folder between this
   * check and the delete; the delete then removes the link, not what it points at.)
   * @param {string} tmp @param {number} id
   * @returns {Promise<boolean>} false when something is still there
   */
  async function removeRunFolder(tmp, id) {
    try {
      let st;
      try {
        st = await lstat(tmp);
      } catch (err) {
        if (err && err.code === 'ENOENT') return true;
        throw err;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        warn(`Left ${tmp} alone: it is not a plain folder.`);
        return false;
      }
      const real = await realpath(tmp);
      const root = chat.realTmpRoot;
      if (!(real.startsWith(root) && (real[root.length] === '/' || real[root.length] === '\\') && real.slice(root.length + 1) === String(id))) {
        warn(`Left ${tmp} alone: it resolves to ${real}.`);
        return false;
      }
      await rm(tmp, { recursive: true, force: true });
      return true;
    } catch (err) {
      warn(`Could not remove ${tmp}: ${errorMessage(err)}`);
      return false;
    }
  }

  // --- protected files (see the header) ---
  // A node is what was at one path: { kind: 'absent' | 'file' | 'dir' | 'link' | 'other' }, with the file's
  // bytes, the link's target, the folder's dev and ino, and `children` by name. A folder copied whole has
  // `full` set: anything in it afterwards that wasn't there is new. Paths are only ever looked at with lstat,
  // parents first, and below a parent that isn't a real folder nothing is looked at: never through a link.

  /** What is at `path`, without following a link there. ENOENT and ENOTDIR are "nothing". */
  async function stateOf(path) {
    let st;
    try {
      st = await lstat(path);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { kind: 'absent' };
      throw err;
    }
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    return { kind, size: st.size, ino: st.ino, dev: st.dev, mode: st.mode & 0o7777 };
  }

  class ProtectError extends Error {}

  /** A copy of what is at `path`; a folder with its entries down to `depth` folders (files at that depth still copied). */
  async function copyOf(path, rel, depth, budget) {
    const state = await stateOf(path);
    if (++budget.entries > MAX_PROTECTED_ENTRIES) throw new ProtectError(`there are more than ${MAX_PROTECTED_ENTRIES} protected files and folders`);
    if (state.kind === 'file') {
      if (state.size > MAX_PROTECTED_FILE_BYTES) throw new ProtectError(`${rel} is over ${MAX_PROTECTED_FILE_BYTES / 1024 / 1024} MB`);
      budget.bytes += state.size;
      if (budget.bytes > MAX_PROTECTED_BYTES) throw new ProtectError(`the protected files come to over ${MAX_PROTECTED_BYTES / 1024 / 1024} MB`);
      return { kind: 'file', bytes: await readFile(path), mode: state.mode, children: new Map() };
    }
    if (state.kind === 'link') return { kind: 'link', target: await readlink(path), children: new Map() };
    if (state.kind !== 'dir') return { kind: state.kind, children: new Map() };
    const node = { kind: 'dir', ino: state.ino, dev: state.dev, children: new Map(), full: depth > 0 };
    if (depth > 0) {
      for (const name of await readdir(path)) node.children.set(name, await copyOf(`${path}/${name}`, `${rel}/${name}`, depth - 1, budget));
    }
    return node;
  }

  /**
   * The protected paths below a folder the command can write, or null when it
   * isn't a real folder (nothing of it is there to protect). Throws
   * ProtectError when they are too big to copy: the run is refused.
   */
  async function snapshotOf(root, budget) {
    if ((await stateOf(root)).kind !== 'dir') return null;
    const tree = { kind: 'dir', children: new Map(), full: false };
    for (const rel of PROTECTED_PATHS) {
      const names = rel.split('/');
      let parent = tree;
      let path = root;
      // Below a parent that isn't a real folder, the path can't be reached: it counts as nothing.
      let reachable = true;
      for (const [i, name] of names.entries()) {
        path = `${path}/${name}`;
        const here = names.slice(0, i + 1).join('/');
        let node = parent.children.get(name);
        if (!node) {
          if (!reachable) node = { kind: 'absent', children: new Map() };
          else if (i === names.length - 1) node = await copyOf(path, here, SHALLOW_PROTECTED.has(rel) ? 1 : Infinity, budget);
          else node = await copyOf(path, here, 0, budget);
          parent.children.set(name, node);
        }
        reachable = reachable && node.kind === 'dir';
        parent = node;
      }
    }
    return { root, tree };
  }

  /** Two names for one file (a folder that ignores case): same dev and inode, as lstat sees them. */
  async function sameEntry(a, b) {
    const [x, y] = await Promise.all([stateOf(a), stateOf(b)]);
    return x.kind !== 'absent' && y.kind !== 'absent' && x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  }

  const removeAt = (path) => rm(path, { recursive: true, force: true });
  const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

  /** Puts back what was at `path` (`before`), noting each path it changed in `undone` (relative to the folder). */
  async function restoreAt(path, rel, before, undone) {
    const now = await stateOf(path);
    switch (before.kind) {
      case 'dir':
        // Removed by the command: nothing of it is left to plant code with. Recreating it would make a broken copy.
        if (now.kind === 'absent') return;
        if (now.kind !== 'dir') {
          await removeAt(path);
          undone.push(rel);
          return;
        }
        for (const [name, child] of before.children) await restoreAt(`${path}/${name}`, `${rel}/${name}`, child, undone);
        if (before.full) {
          for (const name of await readdir(path)) {
            if (before.children.has(name)) continue;
            const twin = [...before.children.keys()].find((known) => known.toLowerCase() === name.toLowerCase());
            if (twin !== undefined && (await sameEntry(`${path}/${twin}`, `${path}/${name}`))) continue;
            await removeAt(`${path}/${name}`);
            undone.push(`${rel}/${name}`);
          }
        }
        return;
      case 'absent':
        if (now.kind === 'absent') return;
        // A folder made on the way to a protected path (a new repository's .git) stays; what it holds that is protected goes.
        if (now.kind === 'dir' && before.children.size > 0) {
          for (const [name, child] of before.children) await restoreAt(`${path}/${name}`, `${rel}/${name}`, child, undone);
          return;
        }
        await removeAt(path);
        undone.push(rel);
        return;
      case 'file':
        if (now.kind === 'file' && now.size === before.bytes.length && sameBytes(await readFile(path), before.bytes)) {
          // Same bytes, but a changed mode is a change too (on a Windows folder, 444 is the read-only attribute).
          if (now.mode !== before.mode) {
            await chmod(path, before.mode);
            undone.push(rel);
          }
          return;
        }
        // Never written in place: the file may have been made read-only (a write would fail and leave its bytes),
        // or be a hard link to something else. Removed, then made afresh (exclusive, no link followed).
        if (now.kind !== 'absent') await removeAt(path);
        await createFile(path, before.bytes, before.mode);
        await chmod(path, before.mode);
        undone.push(rel);
        return;
      case 'link':
        if (now.kind === 'link' && (await readlink(path)) === before.target) return;
        if (now.kind !== 'absent') await removeAt(path);
        await symlink(before.target, path);
        undone.push(rel);
        return;
      default:
        // A device, socket or pipe: nothing a command could plant code in by changing, and nothing to put back.
        return;
    }
  }

  /**
   * Puts back every protected path of these snapshots. Never throws: what it
   * couldn't put back is said in the note, with what it did ('' for nothing),
   * and `unguarded` lists the folders where anything failed, for Grunt to stop
   * using them until someone has looked. `cwdRoot` is named by relative paths,
   * the home as ~.
   * @returns {Promise<{ note: string, unguarded: string[] }>}
   */
  async function restoreAll(snapshots, cwdRoot) {
    const undone = [];
    const failed = [];
    const unguarded = [];
    for (const { root, tree } of snapshots) {
      const shown = (rel) => (root === chat.home ? `~/${rel}` : root === cwdRoot ? rel : `${root}/${rel}`);
      const fail = (what) => {
        failed.push(what);
        if (!unguarded.includes(root)) unguarded.push(root);
      };
      try {
        // The folder itself went (an unmount): nothing below it can be looked at, and it is never removed.
        if ((await stateOf(root)).kind !== 'dir') {
          fail(`${root} (it is no longer there)`);
          continue;
        }
      } catch (err) {
        fail(`${root} (${errorMessage(err)})`);
        continue;
      }
      for (const [name, node] of tree.children) {
        const found = [];
        try {
          await restoreAt(`${root}/${name}`, name, node, found);
        } catch (err) {
          fail(`${shown(name)} (${errorMessage(err)})`);
        }
        undone.push(...found.map(shown));
      }
    }
    const lines = [];
    if (undone.length > 0) {
      const named = undone.slice(0, MAX_NAMED_UNDONE).join(', ');
      const more = undone.length > MAX_NAMED_UNDONE ? ` and ${undone.length - MAX_NAMED_UNDONE} more` : '';
      lines.push(`The sandbox undid changes to ${named}${more} (protected files).`);
    }
    if (failed.length > 0) lines.push(`The sandbox couldn't check or undo changes to ${failed.join(', ')}; look at them before using the folder on Windows.`);
    return { note: lines.join('\n'), unguarded };
  }

  /** The runtime's own guard on the protected paths, in their usual spelling, under each folder: write denies. */
  async function protectedDenies(roots) {
    const denies = [];
    for (const root of roots) {
      if ((await stateOf(root)).kind !== 'dir') continue;
      const repository = (await stateOf(`${root}/.git`)).kind === 'dir';
      for (const rel of PROTECTED_PATHS) if (repository || !rel.startsWith('.git/')) denies.push(`${root}/${rel}`);
    }
    return denies;
  }

  /** Snapshots of every folder in `roots` (each once). Throws, saying which folder, when one is too big to copy. */
  async function snapshotAll(roots) {
    const budget = { bytes: 0, entries: 0 };
    const snapshots = [];
    for (const root of new Set(roots)) {
      try {
        const snapshot = await snapshotOf(root, budget);
        if (snapshot) snapshots.push(snapshot);
      } catch (err) {
        const why = err instanceof ProtectError ? err.message : errorMessage(err);
        throw new Error(
          `The command was not run: the sandbox keeps a copy of files like .git/hooks and .vscode in ${root} to undo a command's changes to them, and it couldn't (${why}).`
        );
      }
    }
    return snapshots;
  }

  /** Wraps the command with this process in its working folder, where the runtime puts its own guard on the protected paths. */
  async function wrapIn(folder, wrap) {
    const previous = cwd();
    chdir(folder);
    try {
      return await wrap();
    } finally {
      try {
        chdir(previous);
      } catch {
        // stays in the run's folder until the next run moves it
      }
    }
  }

  /** Spawns the wrapped command and collects its output under the cap. */
  function collect(id, wrapped, cwd, timeoutMs, tmp, signal) {
    return new Promise((resolve, reject) => {
      const [file, ...args] = wrapped.argv;
      // detached: its own process group, so a kill reaches everything it started.
      const child = spawn(file, args, {
        cwd,
        env: { ...wrapped.env, HOME: chat.home, TMPDIR: tmp, PATH: COMMAND_PATH },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let sentBytes = 0;
      // Set the moment anything is dropped: after that nothing more is sent, so what Grunt sees is a clean prefix.
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let stopping = false;
      let hard;
      // The cap is on what is SENT, in UTF-8 bytes of the decoded text, cut between characters.
      const emit = (text) => {
        if (!text || truncated) return;
        const kept = fit(text, MAX_OUTPUT_BYTES - sentBytes);
        if (kept.length < text.length) truncated = true;
        if (!kept) return;
        for (const ch of kept) sentBytes += codePointBytes(/** @type {number} */ (ch.codePointAt(0)));
        send({ type: 'output', id, chunk: kept });
      };
      const out = new TextDecoder();
      const err = new TextDecoder();
      child.stdout.on('data', (buf) => emit(out.decode(buf, { stream: true })));
      child.stderr.on('data', (buf) => emit(err.decode(buf, { stream: true })));
      const stop = () => {
        // Cancel after a timeout (or both at once) must not restart the SIGKILL clock.
        if (stopping) return;
        stopping = true;
        refuseAsks();
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          kill(-pid, 'SIGTERM');
        } catch {
          // already gone
        }
        hard = setTimeout(() => {
          try {
            kill(-pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      signal.addEventListener('abort', stop, { once: true });
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(hard);
        signal.removeEventListener('abort', stop);
      };
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        finish();
        reject(e);
      });
      child.on('close', (code, sig) => {
        if (settled) return;
        settled = true;
        finish();
        emit(out.decode());
        emit(err.decode());
        resolve({ exitCode: code, signal: sig, timedOut, truncated });
      });
    });
  }

  /** Why a run message is unusable, or null. The id is checked before this. */
  function problem(msg) {
    if (typeof msg.command !== 'string' || msg.command === '') return 'The command is empty.';
    if (!isAbsolute(msg.cwd)) return 'The working folder is not an absolute path.';
    if (typeof msg.timeoutMs !== 'number' || !Number.isFinite(msg.timeoutMs) || msg.timeoutMs <= 0) return 'The timeout is not a positive number.';
    return null;
  }

  async function run(msg) {
    const id = msg.id;
    if (phase === 'closing') return void send({ type: 'failed', id, message: 'The sandbox agent is closing.' });
    if (phase !== 'ready' || !chat) return void send({ type: 'failed', id, message: 'The sandbox agent was not started for a chat.' });
    if (active) {
      return void send({
        type: 'failed',
        id,
        message: active.id === id ? `Run ${id} is already running.` : 'The sandbox agent is already running a command.',
      });
    }
    const bad = problem(msg);
    if (bad) return void send({ type: 'failed', id, message: bad });

    const controller = new AbortController();
    /** @type {() => void} */
    let release = () => undefined;
    const mine = { id, controller, done: new Promise((resolve) => (release = resolve)), restore: null };
    active = mine;
    // A cancel (or close) while the command is still being wrapped, possibly waiting on a network ask, has no child to kill yet.
    controller.signal.addEventListener('abort', refuseAsks, { once: true });
    const tmp = `${chat.tmpRoot}/${id}`;
    const commandId = `grunt-run-${id}`;
    /** What Grunt is told once the protected files are back. @type {Record<string, unknown>} */
    let reply;
    try {
      // One agent per chat serves every variant of a compare turn, one command
      // at a time, each with its own profile's allowlist.
      const hosts = strings(msg.allowedHosts);
      if (hosts.join('\n') !== chat.allowedHosts.join('\n')) {
        runtime.updateConfig(config(chat, hosts));
        chat.allowedHosts = hosts;
      }
      // A leftover from an earlier agent of this chat goes first. Then mkdir without
      // recursive, so a link (or anything) still at the path is an error instead of
      // a folder the command would get write access to somewhere else.
      if (!(await removeRunFolder(tmp, id))) throw new Error('The temp folder for this run is already taken.');
      await mkdir(tmp, { mode: 0o700 });
      const writePaths = strings(msg.writePaths);
      const guarded = [...writePaths, chat.home];
      // Before anything runs: a copy of each writable folder's protected paths, put back below whatever happens.
      const snapshots = await snapshotAll(guarded);
      let restoring = null;
      // Grunt gives a cancel or a close more time once it hears the restore has started.
      mine.restore = () => {
        if (!restoring) {
          send({ type: 'restoring', id });
          restoring = restoreAll(snapshots, msg.cwd);
        }
        return restoring;
      };
      const denyWrite = [...strings(msg.denyWritePaths), ...(await protectedDenies(guarded))];
      const custom = { filesystem: runFilesystem(strings(msg.readPaths), writePaths, denyWrite, tmp) };
      // The runtime reads this when it wraps, to set the command's own TMPDIR.
      env.CLAUDE_CODE_TMPDIR = tmp;
      const command = msg.command;
      const wrapped = await wrapIn(msg.cwd, () => runtime.wrapWithSandboxArgv(command, 'bash', custom, controller.signal, msg.cwd, { commandId, commandText: command }));
      if (controller.signal.aborted) {
        // Cancelled while wrapping: nothing was started, so report it as the killed command it would have been.
        reply = { type: 'done', id, exitCode: null, signal: 'SIGTERM', timedOut: false, truncated: false, note: '' };
      } else {
        const outcome = await collect(id, wrapped, msg.cwd, Math.min(msg.timeoutMs, MAX_TIMEOUT_MS), tmp, controller.signal);
        const note = fit(String(runtime.annotateStderrWithSandboxFailures(commandId, '') ?? '').trim(), MAX_NOTE_BYTES);
        reply = { type: 'done', id, ...outcome, note };
      }
    } catch (err) {
      reply = { type: 'failed', id, message: errorMessage(err) };
    } finally {
      refuseAsks();
      try {
        runtime.cleanupAfterCommand();
      } catch {
        // best effort
      }
      // After the runtime's clean-up, which takes away the empty files it put where a protected path was missing.
      const { note: undone, unguarded } = mine.restore ? await mine.restore() : { note: '', unguarded: [] };
      if (undone && reply.type === 'done') reply.note = reply.note ? `${undone}\n${reply.note}` : undone;
      else if (undone) reply.message = `${reply.message}\n${undone}`;
      // The folders whose protected files couldn't be confirmed put back: Grunt stops using them.
      reply.unguarded = unguarded;
      send(reply);
      // Grunt sends the next run as soon as it sees done, and clearing a big
      // $TMPDIR (pip and npm caches) can be slow: the agent is free before that.
      // The next run has another id, so this rm can't touch its folder.
      active = null;
      // Only this run's folder: the runtime's sockets in rt live as long as the agent.
      await removeRunFolder(tmp, id);
      release();
    }
  }

  function answer(msg) {
    const resolve = asks.get(msg.askId);
    if (!resolve) return;
    asks.delete(msg.askId);
    resolve(msg.allowed === true);
  }

  async function close() {
    if (phase === 'closing') return;
    phase = 'closing';
    const running = active;
    running?.controller.abort();
    refuseAsks();
    if (running) {
      // The kill is SIGTERM, then SIGKILL after the grace: let the command report before the runtime goes away.
      let timer;
      const give = new Promise((resolve) => {
        timer = setTimeout(resolve, KILL_GRACE_MS + CLOSE_MARGIN_MS);
      });
      await Promise.race([running.done, give]);
      clearTimeout(timer);
      // Whether or not the command reported in time, its protected files are put back before this process goes
      // (the same restore the run does, so never twice). A run whose files were never copied has none to put back.
      if (running.restore) await running.restore();
    }
    try {
      await runtime.reset();
    } catch {
      // exiting anyway
    }
    exit(0);
  }

  return {
    /** One line from Grunt. Never throws; a line that isn't a message is ignored. @param {string} line */
    async receive(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      // The id names a folder that is later removed, so it must be a plain count.
      const hasId = Number.isSafeInteger(msg.id) && msg.id >= 0;
      try {
        if (msg.type === 'init') await init(msg);
        else if (msg.type === 'run') {
          if (hasId) await run(msg);
        } else if (msg.type === 'cancel') {
          if (hasId && active?.id === msg.id) active.controller.abort();
        } else if (msg.type === 'answer') answer(msg);
        else if (msg.type === 'close') await close();
      } catch (err) {
        if (msg.type === 'run' && hasId) send({ type: 'failed', id: msg.id, message: errorMessage(err) });
      }
    },
  };
}
