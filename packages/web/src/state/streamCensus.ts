/**
 * How many streams this browser holds open to the server across all its tabs. A browser keeps about 6 HTTP/1.1
 * connections per host for everything on it, whichever tab asks, so one tab's count isn't enough to know whether a
 * terminal stream would take the last one (code/terminal/feed.ts). Each tab posts its own count on a
 * BroadcastChannel when it changes; a tab that opens asks the others for theirs, and a tab that's hidden for good
 * (pagehide) posts 0. A tab that crashes leaves its last count with the others, which only makes them more careful.
 */

export type CensusMessage = { tab: string; count: number } | { tab: string; ask: true };

/** The channel between tabs, or a fake one in tests. */
export interface CensusBus {
  post(message: CensusMessage): void;
  onMessage(cb: (message: unknown) => void): void;
}

function isMessage(m: unknown): m is CensusMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (typeof r['tab'] !== 'string') return false;
  return r['ask'] === true || (typeof r['count'] === 'number' && Number.isInteger(r['count']) && r['count'] >= 0 && r['count'] <= 1000);
}

export class StreamCensus {
  private own = 0;
  private readonly others = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly bus: CensusBus | null,
    private readonly tab: string = crypto.getRandomValues(new Uint32Array(2)).join('-')
  ) {
    bus?.onMessage((m) => this.receive(m));
    bus?.post({ tab: this.tab, ask: true });
  }

  /** This tab's streams, all tabs' streams. */
  ownCount(): number {
    return this.own;
  }

  total(): number {
    let sum = this.own;
    for (const n of this.others.values()) sum += n;
    return sum;
  }

  setOwn(count: number): void {
    if (count === this.own) return;
    this.own = count;
    this.bus?.post({ tab: this.tab, count });
    this.notify();
  }

  /** The tab is going away (or into the back-forward cache): the others stop counting its streams. */
  leave(): void {
    this.bus?.post({ tab: this.tab, count: 0 });
  }

  /** Back from the back-forward cache. */
  rejoin(): void {
    this.bus?.post({ tab: this.tab, count: this.own });
    this.bus?.post({ tab: this.tab, ask: true });
  }

  /** Told whenever the total may have changed; returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private receive(message: unknown): void {
    if (!isMessage(message) || message.tab === this.tab) return;
    if ('ask' in message) {
      if (this.own > 0) this.bus?.post({ tab: this.tab, count: this.own });
      return;
    }
    if (message.count === 0) this.others.delete(message.tab);
    else this.others.set(message.tab, message.count);
    this.notify();
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

let census: StreamCensus | null = null;

/**
 * This tab's census, made on first use. Tests get one with no channel: tabs there are separate test files sharing a
 * process, and a real BroadcastChannel would carry one file's counts into another.
 */
export function streamCensus(): StreamCensus {
  if (census) return census;
  let bus: CensusBus | null = null;
  if (typeof BroadcastChannel === 'function' && typeof window !== 'undefined' && import.meta.env.MODE !== 'test') {
    const channel = new BroadcastChannel('otherbench-streams');
    bus = {
      post: (m) => channel.postMessage(m),
      onMessage: (cb) => channel.addEventListener('message', (e) => cb(e.data)),
    };
  }
  const made = new StreamCensus(bus);
  census = made;
  if (bus) {
    window.addEventListener('pagehide', () => made.leave());
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) made.rejoin();
    });
  }
  return made;
}
