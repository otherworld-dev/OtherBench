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
//    per agent by Grunt, so this process-global is safe.
//  - A path in allowRead that is the PARENT of a path in allowWrite is bound
//    read-only over it. So tmpRoot itself is never in allowRead (only rt and the
//    run's own folder are), or the run's folder would come out read-only.

/** Combined stdout+stderr kept per command, as run_command keeps on the host. */
export const MAX_OUTPUT_BYTES = 100 * 1024;
/** Between SIGTERM and SIGKILL when a command times out or is cancelled. */
export const KILL_GRACE_MS = 2000;
/** PATH for commands: Grunt's Node first (so node and npm work), then the system's. */
export const COMMAND_PATH = '/opt/grunt-sandbox/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Unreadable unless a run allows a path below them: other chats' folders, homes and temp files. */
export const DENY_READ = ['/mnt', '/home', '/tmp'];

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

/** @param {AgentDeps} deps */
export function createAgent(deps) {
  const { runtime, spawn, send, mkdir, rm, kill, exit, env } = deps;
  /** @type {{ home: string, tmpRoot: string, rt: string, allowedHosts: string[] } | null} */
  let chat = null;
  /** @type {Map<number, AbortController>} */
  const runs = new Map();
  /** @type {Map<number, (allowed: boolean) => void>} */
  const asks = new Map();
  let nextAskId = 1;
  let closing = false;

  /** What the runtime is started with, and told again when the allowlist changes: no run's folders. */
  const baseFilesystem = () => ({ denyRead: DENY_READ, allowRead: [chat.home, chat.rt], allowWrite: [chat.home], denyWrite: [] });
  /** What one command gets: the chat's folders, the home, the runtime's socket folder (read) and its own temp folder. */
  const runFilesystem = (readPaths, writePaths, denyWritePaths, tmp) => ({
    denyRead: DENY_READ,
    allowRead: [...readPaths, chat.home, chat.rt, tmp],
    allowWrite: [...writePaths, chat.home, tmp],
    denyWrite: [...denyWritePaths],
  });
  const config = () => ({
    network: { allowedDomains: [...chat.allowedHosts], deniedDomains: [], allowLocalBinding: false },
    filesystem: baseFilesystem(),
  });
  const strings = (value) => (Array.isArray(value) ? value.map(String) : []);

  /** The runtime's "may this host be reached?" callback: Grunt raises the card and answers. @param {HostPattern} pattern */
  function ask({ host, port }) {
    if (closing) return Promise.resolve(false);
    const askId = nextAskId++;
    send({ type: 'ask', askId, host: String(host), port: typeof port === 'number' ? port : null });
    return new Promise((resolve) => asks.set(askId, resolve));
  }

  async function init(msg) {
    const tmpRoot = String(msg.tmpRoot);
    chat = { home: String(msg.home), tmpRoot, rt: `${tmpRoot}/rt`, allowedHosts: strings(msg.allowedHosts) };
    await mkdir(chat.home, { recursive: true, mode: 0o700 });
    await mkdir(chat.tmpRoot, { recursive: true, mode: 0o700 });
    await mkdir(chat.rt, { recursive: true, mode: 0o700 });
    // Before initialize: the runtime puts its proxy sockets in os.tmpdir().
    env.TMPDIR = chat.rt;
    await runtime.initialize(config(), ask);
    send({ type: 'ready' });
  }

  /** Spawns the wrapped command and collects its output under the cap. */
  function collect(id, wrapped, msg, tmp, signal) {
    return new Promise((resolve, reject) => {
      const [file, ...args] = wrapped.argv;
      // detached: its own process group, so a kill reaches everything it started.
      const child = spawn(file, args, {
        cwd: msg.cwd,
        env: { ...wrapped.env, HOME: chat.home, TMPDIR: tmp, PATH: COMMAND_PATH },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let hard;
      const take = (decoder) => (buf) => {
        if (bytes >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const room = MAX_OUTPUT_BYTES - bytes;
        const slice = buf.length > room ? buf.subarray(0, room) : buf;
        if (slice.length < buf.length) truncated = true;
        bytes += slice.length;
        const chunk = decoder.decode(slice, { stream: true });
        if (chunk) send({ type: 'output', id, chunk });
      };
      const out = new TextDecoder();
      const err = new TextDecoder();
      child.stdout.on('data', take(out));
      child.stderr.on('data', take(err));
      const stop = () => {
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
      }, msg.timeoutMs);
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
        for (const decoder of [out, err]) {
          const tail = decoder.decode();
          if (tail) send({ type: 'output', id, chunk: tail });
        }
        resolve({ exitCode: code, signal: sig, timedOut, truncated });
      });
    });
  }

  async function run(msg) {
    const id = msg.id;
    if (!chat) {
      send({ type: 'failed', id, message: 'The sandbox agent was not started for a chat.' });
      return;
    }
    // One agent per chat serves every variant of a compare turn, one command
    // at a time, each with its own profile's allowlist.
    const hosts = strings(msg.allowedHosts);
    if (hosts.join('\n') !== chat.allowedHosts.join('\n')) {
      chat.allowedHosts = hosts;
      runtime.updateConfig(config());
    }
    const tmp = `${chat.tmpRoot}/${id}`;
    const controller = new AbortController();
    runs.set(id, controller);
    const commandId = `grunt-run-${id}`;
    try {
      await mkdir(tmp, { recursive: true, mode: 0o700 });
      const custom = { filesystem: runFilesystem(strings(msg.readPaths), strings(msg.writePaths), strings(msg.denyWritePaths), tmp) };
      // The runtime reads this when it wraps, to set the command's own TMPDIR.
      env.CLAUDE_CODE_TMPDIR = tmp;
      const wrapped = await runtime.wrapWithSandboxArgv(String(msg.command), 'bash', custom, controller.signal, String(msg.cwd), { commandId, commandText: String(msg.command) });
      const outcome = await collect(id, wrapped, msg, tmp, controller.signal);
      const note = String(runtime.annotateStderrWithSandboxFailures(commandId, '') ?? '').trim();
      send({ type: 'done', id, ...outcome, note });
    } catch (err) {
      send({ type: 'failed', id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      runs.delete(id);
      try {
        runtime.cleanupAfterCommand();
      } catch {
        // best effort
      }
      // Only this run's folder: the runtime's sockets in rt live as long as the agent.
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function answer(msg) {
    const resolve = asks.get(msg.askId);
    if (!resolve) return;
    asks.delete(msg.askId);
    resolve(msg.allowed === true);
  }

  async function close() {
    if (closing) return;
    closing = true;
    for (const controller of runs.values()) controller.abort();
    for (const resolve of asks.values()) resolve(false);
    asks.clear();
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
      try {
        if (msg.type === 'init') await init(msg);
        else if (msg.type === 'run') await run(msg);
        else if (msg.type === 'cancel') runs.get(msg.id)?.abort();
        else if (msg.type === 'answer') answer(msg);
        else if (msg.type === 'close') await close();
      } catch (err) {
        if (msg.type === 'init') {
          send({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
          exit(1);
        }
      }
    },
  };
}
