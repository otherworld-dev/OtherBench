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
// Private networks. The runtime always refuses loopback, link-local, this host's
// own addresses and cloud metadata at connect time, on the address it actually
// dials (so a name that resolves to one is caught even when it changes between
// the check and the connect). It refuses the private-use ranges only when told
// to, which is DENIED_RESOLVED_ADDRESSES in the network config. On top of that
// ask() resolves a host before bothering Grunt with a card, and answers no when
// the name can't be resolved or any address is one the sandbox must not reach.
// That is an early refusal only: the runtime's check is the enforcement.
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

/**
 * Addresses a permitted host name must not resolve to, given to the runtime as
 * `deniedResolvedAddresses`: the private-use ranges (RFC 1918, CGNAT, unique
 * local), multicast, the reserved block and benchmarking. Loopback and
 * link-local are listed too, though the runtime refuses them anyway. Mirrors
 * isPrivateAddress below. This script can't import core, so both are its own
 * copy of the ranges, which in core now live in browser-hosts.ts
 * (isPublicAddress; network-hosts.ts uses that). The copy is looser for a few
 * special ranges: core's testing/shared-host-vectors.ts pins each one, and
 * sandbox/test/shared-address-vectors.test.ts runs that table against
 * isPrivateAddress.
 */
export const DENIED_RESOLVED_ADDRESSES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '198.18.0.0/15',
  '127.0.0.0/8',
  '169.254.0.0/16',
];
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

/** The four numbers of a dotted-decimal IPv4 address, or null for anything else (leading zeros included: they are ambiguous). @param {string} text */
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

/** The eight 16-bit groups of an IPv6 address (brackets and zone dropped, a dotted IPv4 tail allowed), or null. @param {string} text */
function parseIpv6(text) {
  let rest = text.replace(/^\[|\]$/g, '');
  const zone = rest.indexOf('%');
  if (zone !== -1) rest = rest.slice(0, zone);
  if (rest.includes('.')) {
    const tail = rest.lastIndexOf(':');
    const v4 = parseIpv4(rest.slice(tail + 1));
    if (!v4) return null;
    rest = `${rest.slice(0, tail + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const back = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - back.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...back];
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** Whether an IPv4 address (its four numbers) is one the sandbox must not reach: this host, the LAN, link-local, CGNAT, multicast and reserved, benchmarking and documentation. @param {number[]} o */
function isPrivateIpv4([a, b, c]) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * Whether a resolved address is one the sandbox must not reach: loopback,
 * unspecified, private-use, link-local, multicast, reserved and documentation,
 * in IPv4 and IPv6, and an IPv4 address carried inside IPv6 (::ffff:a.b.c.d,
 * the deprecated ::a.b.c.d, and NAT64's 64:ff9b::a.b.c.d). An address that
 * can't be read counts as private: the answer is no when in doubt.
 * @param {unknown} address
 */
export function isPrivateAddress(address) {
  if (typeof address !== 'string') return true;
  const v4 = parseIpv4(address);
  if (v4) return isPrivateIpv4(v4);
  const g = parseIpv6(address);
  if (!g) return true;
  const embedded = () => isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return embedded();
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded();
  return (
    (g[0] & 0xffc0) === 0xfe80 ||
    (g[0] & 0xffc0) === 0xfec0 ||
    (g[0] & 0xfe00) === 0xfc00 ||
    g[0] >> 8 === 0xff ||
    (g[0] === 0x2001 && g[1] === 0xdb8)
  );
}

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
