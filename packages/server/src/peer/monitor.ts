import type { IncomingMessage } from 'node:http';
import type { AppEventBus } from '../stream/events.js';
import type { PeerService } from './service.js';

export interface PeerStatus {
  status: 'unknown' | 'reachable' | 'unreachable';
  /** When it last changed. */
  since: number;
  /** Why the last attempt failed, when it did. */
  error?: string;
}

export interface PeerMonitorOptions {
  events?: AppEventBus;
  now?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Each event a peer's stream carries, other than its hello (Task 51 listens for `changes-available`). */
  onMessage?: (nodeId: string, event: string, data: unknown) => void;
  /** A peer's stream (re)connected: a good moment to sync with it. */
  onConnected?: (nodeId: string) => void;
  /** How long a stream may go without a byte (keepalives included) before it's taken as lost. */
  idleTimeoutMs?: number;
}

/**
 * A peer's `/peer/events` stream carries a keepalive every 25 s, so a minute
 * with nothing at all means the connection died without closing (a laptop
 * asleep, a network changed under it), which TCP alone may never report.
 */
const IDLE_TIMEOUT_MS = 60_000;

interface Loop {
  stopped: boolean;
  close: (() => void) | null;
  wake: (() => void) | null;
}

/**
 * Calls `onEvent` for each event record in a text/event-stream body, and
 * `onChunk` for every chunk received (comments included); resolves when the
 * stream ends.
 */
export async function readEventStream(response: IncomingMessage, onEvent: (event: string, data: unknown) => void, onChunk?: () => void): Promise<void> {
  let buffer = '';
  response.setEncoding('utf8');
  for await (const chunk of response) {
    onChunk?.();
    buffer += chunk as string;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const record = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of record.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      let parsed: unknown = data.join('\n');
      try {
        parsed = JSON.parse(parsed as string);
      } catch {
        // not JSON: pass the text
      }
      onEvent(event, parsed);
    }
  }
}

/**
 * Keeps every paired machine's `/peer/events` stream open (v2 plan, Task 48),
 * so this machine knows which peers are reachable and hears about their
 * changes. A dropped or refused stream is retried with backoff from 1s up to
 * a minute; `peer-status` is announced only when a peer's status changes.
 */
export class PeerMonitor {
  private readonly loops = new Map<string, Loop>();
  private readonly statuses = new Map<string, PeerStatus>();
  private started = false;
  private readonly now: () => number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly idleTimeout: number;

  constructor(
    private readonly service: PeerService,
    private readonly options: PeerMonitorOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.minBackoff = options.minBackoffMs ?? 1_000;
    this.maxBackoff = options.maxBackoffMs ?? 60_000;
    this.idleTimeout = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  }

  start(): void {
    this.started = true;
    this.reconcile();
  }

  /** Watches exactly the peers that exist now. */
  reconcile(): void {
    if (!this.started) return;
    const current = new Set(this.service.list().map((p) => p.nodeId));
    for (const [nodeId, loop] of this.loops) {
      if (!current.has(nodeId)) {
        this.stopLoop(loop);
        this.loops.delete(nodeId);
        this.statuses.delete(nodeId);
      }
    }
    for (const nodeId of current) {
      if (this.loops.has(nodeId)) continue;
      const loop: Loop = { stopped: false, close: null, wake: null };
      this.loops.set(nodeId, loop);
      void this.run(nodeId, loop);
    }
  }

  status(nodeId: string): PeerStatus {
    return this.statuses.get(nodeId) ?? { status: 'unknown', since: this.now() };
  }

  /** Tries every unreachable peer again now, rather than at the end of its backoff. */
  retryNow(): void {
    for (const loop of this.loops.values()) loop.wake?.();
  }

  stop(): void {
    this.started = false;
    for (const loop of this.loops.values()) this.stopLoop(loop);
    this.loops.clear();
  }

  private stopLoop(loop: Loop): void {
    loop.stopped = true;
    loop.close?.();
    loop.wake?.();
  }

  private set(nodeId: string, status: PeerStatus['status'], error?: string): void {
    const previous = this.statuses.get(nodeId);
    if (previous?.status === status) {
      if (error !== undefined) this.statuses.set(nodeId, { ...previous, error });
      return;
    }
    const since = this.now();
    this.statuses.set(nodeId, { status, since, ...(error !== undefined ? { error } : {}) });
    if (status !== 'unknown') this.options.events?.emit({ type: 'peer-status', nodeId, status, since });
  }

  private async run(nodeId: string, loop: Loop): Promise<void> {
    let backoff = this.minBackoff;
    while (!loop.stopped) {
      let error: string | undefined;
      try {
        const token = await this.service.heldToken(nodeId);
        const peer = this.service.peer(nodeId);
        if (!peer || !token) return;
        const { response, address, close } = await this.service.client.stream(
          { addresses: peer.addresses, fingerprint: peer.fingerprint },
          { method: 'GET', path: '/peer/events', token, headers: { accept: 'text/event-stream' } }
        );
        loop.close = close;
        if (loop.stopped) {
          close();
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          close();
          error = response.statusCode === 401 ? `${peer.name} no longer accepts this machine (removed there?).` : `HTTP ${response.statusCode}`;
        } else {
          this.service.noteReached(peer, address);
          this.set(nodeId, 'reachable');
          backoff = this.minBackoff;
          this.options.onConnected?.(nodeId);
          let silent = false;
          let idle: ReturnType<typeof setTimeout> | undefined;
          const heardFrom = (): void => {
            clearTimeout(idle);
            idle = setTimeout(() => {
              silent = true;
              close();
            }, this.idleTimeout);
          };
          heardFrom();
          try {
            await readEventStream(
              response,
              (event, data) => {
                if (event !== 'hello') this.options.onMessage?.(nodeId, event, data);
              },
              heardFrom
            );
          } catch (err) {
            if (!silent) throw err;
          } finally {
            clearTimeout(idle);
          }
          close();
          error = silent ? `Heard nothing from ${peer.name} in ${Math.round(this.idleTimeout / 1000)} s, so the connection was taken as lost.` : 'The connection closed.';
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      loop.close = null;
      if (loop.stopped) return;
      this.set(nodeId, 'unreachable', error);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff);
        loop.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      loop.wake = null;
      backoff = Math.min(backoff * 2, this.maxBackoff);
    }
  }
}
