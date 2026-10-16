/**
 * The JSON lines between OtherBench and its sandbox agent (resources/agent-core.mjs,
 * which mirrors these shapes: change both together). The agent runs inside
 * the VM, so what it sends is data, checked field by field, never trusted.
 *
 * What the agent holds OtherBench to: run ids are safe non-negative integers (a run's
 * id names its temp folder), one run is in flight at a time, and `timeoutMs` is
 * a finite number above zero (the agent caps it at 600000).
 */

export type HostMessage =
  | { type: 'init'; home: string; tmpRoot: string; allowedHosts: string[] }
  | {
      type: 'run';
      id: number;
      command: string;
      cwd: string;
      timeoutMs: number;
      readPaths: string[];
      writePaths: string[];
      denyWritePaths: string[];
      allowedHosts: string[];
    }
  | { type: 'cancel'; id: number }
  | { type: 'answer'; askId: number; allowed: boolean }
  | { type: 'close' };

export type AgentMessage =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'output'; id: number; chunk: string }
  /**
   * `unguarded` (done and failed): the run's writable folders, as Linux paths, whose protected files the
   * agent couldn't confirm it put back. Absent from an older agent, which counts as none.
   */
  | { type: 'done'; id: number; exitCode: number | null; signal: string | null; timedOut: boolean; truncated: boolean; note: string; unguarded: string[] }
  | { type: 'failed'; id: number; message: string; unguarded: string[] }
  /** The run's command has ended and the agent is putting its protected files back. */
  | { type: 'restoring'; id: number }
  | { type: 'ask'; askId: number; host: string; port: number | null };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
/** `unguarded` as sent: absent is none; anything but a list of strings makes the message unreadable. */
const unguardedOf = (v: unknown): string[] | null => (v === undefined ? [] : Array.isArray(v) && v.every(isStr) ? [...v] : null);

/** One line from the agent as a message, or null for anything that isn't exactly one. */
export function parseAgentMessage(line: string): AgentMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  const id = m['id'];
  switch (m['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'fatal': {
      const message = m['message'];
      return isStr(message) ? { type: 'fatal', message } : null;
    }
    case 'output': {
      const chunk = m['chunk'];
      return isInt(id) && isStr(chunk) ? { type: 'output', id, chunk } : null;
    }
    case 'done': {
      const exitCode = m['exitCode'];
      const signal = m['signal'];
      const timedOut = m['timedOut'];
      const truncated = m['truncated'];
      const note = m['note'];
      if (!isInt(id) || !(exitCode === null || isInt(exitCode)) || !(signal === null || isStr(signal))) return null;
      if (typeof timedOut !== 'boolean' || typeof truncated !== 'boolean' || !isStr(note)) return null;
      const unguarded = unguardedOf(m['unguarded']);
      return unguarded ? { type: 'done', id, exitCode, signal, timedOut, truncated, note, unguarded } : null;
    }
    case 'failed': {
      const message = m['message'];
      const unguarded = unguardedOf(m['unguarded']);
      return isInt(id) && isStr(message) && unguarded ? { type: 'failed', id, message, unguarded } : null;
    }
    case 'restoring':
      return isInt(id) ? { type: 'restoring', id } : null;
    case 'ask': {
      const askId = m['askId'];
      const host = m['host'];
      const port = m['port'];
      return isInt(askId) && isStr(host) && (port === null || isInt(port)) ? { type: 'ask', askId, host, port } : null;
    }
    default:
      return null;
  }
}
