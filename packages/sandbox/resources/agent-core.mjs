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
 * isPrivateAddress below and the ranges in core's network-hosts.ts.
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
 *   lstat: (path: string) => Promise<{ isSymbolicLink(): boolean, isDirectory(): boolean }>,
 *   realpath: (path: string) => Promise<string>,
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
  const warn = deps.warn ?? (() => undefined);
  /** new -> initialising -> ready -> closing; dead after a failed init. */
  let phase = 'new';
  /** Set once the runtime has started; realTmpRoot is tmpRoot with every link resolved. @type {{ home: string, tmpRoot: string, realTmpRoot: string, rt: string, allowedHosts: string[] } | null} */
  let chat = null;
  /** The one command in flight. @type {{ id: number, controller: AbortController, done: Promise<void> } | null} */
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
    active = { id, controller, done: new Promise((resolve) => (release = resolve)) };
    // A cancel (or close) while the command is still being wrapped, possibly waiting on a network ask, has no child to kill yet.
    controller.signal.addEventListener('abort', refuseAsks, { once: true });
    const tmp = `${chat.tmpRoot}/${id}`;
    const commandId = `grunt-run-${id}`;
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
      const custom = { filesystem: runFilesystem(strings(msg.readPaths), strings(msg.writePaths), strings(msg.denyWritePaths), tmp) };
      // The runtime reads this when it wraps, to set the command's own TMPDIR.
      env.CLAUDE_CODE_TMPDIR = tmp;
      const command = msg.command;
      const wrapped = await runtime.wrapWithSandboxArgv(command, 'bash', custom, controller.signal, msg.cwd, { commandId, commandText: command });
      if (controller.signal.aborted) {
        // Cancelled while wrapping: nothing was started, so report it as the killed command it would have been.
        send({ type: 'done', id, exitCode: null, signal: 'SIGTERM', timedOut: false, truncated: false, note: '' });
        return;
      }
      const outcome = await collect(id, wrapped, msg.cwd, Math.min(msg.timeoutMs, MAX_TIMEOUT_MS), tmp, controller.signal);
      const note = fit(String(runtime.annotateStderrWithSandboxFailures(commandId, '') ?? '').trim(), MAX_NOTE_BYTES);
      send({ type: 'done', id, ...outcome, note });
    } catch (err) {
      send({ type: 'failed', id, message: errorMessage(err) });
    } finally {
      refuseAsks();
      try {
        runtime.cleanupAfterCommand();
      } catch {
        // best effort
      }
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
