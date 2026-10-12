import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { parseAgentMessage, type AgentMessage, type HostMessage } from './protocol.js';

/** Longer than any message the agent has reason to send (its output comes in pieces): past this it is stopped. */
export const MAX_LINE_CHARS = 1024 * 1024;
/** How much of the agent's stderr is kept to explain its exit. The pipe is always drained, so a chatty agent can't stall. */
const STDERR_TAIL_CHARS = 4000;
/** How much of that tail goes into an exit's detail. */
const DETAIL_CHARS = 2000;

export interface AgentExit {
  code: number | null;
  /** Why it stopped: the end of its stderr, or what Grunt saw. */
  detail: string;
}

/** The agent's two pipes as messages. */
export interface AgentChannel {
  send(message: HostMessage): void;
  onMessage(cb: (message: AgentMessage) => void): void;
  onExit(cb: (exit: AgentExit) => void): void;
  kill(): void;
}

/** JSON lines over an agent process started through wsl.exe. */
export function channelFromProcess(child: ChildProcessWithoutNullStreams): AgentChannel {
  const messageListeners: ((m: AgentMessage) => void)[] = [];
  const exitListeners: ((e: AgentExit) => void)[] = [];
  const decoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let stderrTail = '';
  let buffered = '';
  let exited = false;
  let detail = '';

  const exit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    const info: AgentExit = { code, detail: detail || stderrTail.slice(-DETAIL_CHARS) };
    for (const cb of exitListeners) cb(info);
  };

  child.stdout.on('data', (buf: Buffer) => {
    buffered += decoder.write(buf);
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl).replace(/\r$/, '');
      buffered = buffered.slice(nl + 1);
      const message = parseAgentMessage(line);
      if (message) for (const cb of messageListeners) cb(message);
    }
    if (buffered.length > MAX_LINE_CHARS) {
      buffered = '';
      detail = 'The sandbox agent sent a line longer than 1 MB, so Grunt stopped it.';
      child.kill();
    }
  });
  // Read to the end whatever the agent prints (it warns here), keeping only the last few KB.
  child.stderr.on('data', (buf: Buffer) => {
    stderrTail = (stderrTail + stderrDecoder.write(buf)).slice(-STDERR_TAIL_CHARS);
  });
  // The agent went away mid-write: its exit says why.
  child.stdin.on('error', () => undefined);
  child.on('error', (err: Error) => {
    detail = err.message;
    exit(null);
  });
  child.on('close', (code: number | null) => exit(code));

  return {
    send: (message) => {
      if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (cb) => {
      messageListeners.push(cb);
    },
    onExit: (cb) => {
      exitListeners.push(cb);
    },
    kill: () => {
      child.kill();
    },
  };
}
