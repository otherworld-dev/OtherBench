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
 *   kill: (pid: number, signal: string) => void,
 *   exit: (code: number) => void,
 *   env: Record<string, string | undefined>,
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

/** @param {AgentDeps} deps */
export function createAgent(deps) {
  const { runtime, spawn, send, mkdir, rm, kill, exit, env } = deps;
  /** new -> initialising -> ready -> closing; dead after a failed init. */
  let phase = 'new';
  /** Set once the runtime has started. @type {{ home: string, tmpRoot: string, rt: string, allowedHosts: string[] } | null} */
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
    network: { allowedDomains: [...allowedHosts], deniedDomains: [], allowLocalBinding: false },
    filesystem: baseFilesystem(c),
  });

  /** The runtime's "may this host be reached?" callback: Grunt raises the card and answers. @param {HostPattern} pattern */
  function ask({ host, port }) {
    if (phase === 'closing') return Promise.resolve(false);
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
    const next = { home: msg.home, tmpRoot, rt: `${tmpRoot}/rt`, allowedHosts: strings(msg.allowedHosts) };
    try {
      await mkdir(next.home, { recursive: true, mode: 0o700 });
      await mkdir(next.tmpRoot, { recursive: true, mode: 0o700 });
      await mkdir(next.rt, { recursive: true, mode: 0o700 });
      // Before initialize: the runtime puts its proxy sockets in os.tmpdir().
      env.TMPDIR = next.rt;
      await runtime.initialize(config(next, next.allowedHosts), ask);
    } catch (err) {
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
      await mkdir(tmp, { recursive: true, mode: 0o700 });
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
      // Only this run's folder: the runtime's sockets in rt live as long as the agent.
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      active = null;
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
