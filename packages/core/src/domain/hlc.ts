/**
 * Hybrid logical clock (v2 spec §4): wall-clock milliseconds, a counter for
 * events in the same millisecond (or while the wall clock is behind), and
 * the node id as the tie-break. Encoded as `<ms:13>-<counter:4>-<nodeId>`,
 * zero-padded, so stamps compare correctly as plain strings.
 */

const COUNTER_MAX = 9999;

interface Parsed {
  ms: number;
  counter: number;
}

/** The time and counter of a stamp; '' (never stamped) reads as zero. */
export function parseHlc(stamp: string): Parsed {
  const [ms, counter] = stamp.split('-', 2);
  return { ms: Number(ms) || 0, counter: Number(counter) || 0 };
}

export function encodeHlc(ms: number, counter: number, nodeId: string): string {
  return `${String(ms).padStart(13, '0')}-${String(counter).padStart(4, '0')}-${nodeId}`;
}

/** Orders two stamps: negative when `a` is earlier. '' is earlier than any stamp. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The later of two stamps. */
export function maxHlc(a: string, b: string): string {
  return compareHlc(a, b) >= 0 ? a : b;
}

export class Hlc {
  private ms = 0;
  private counter = 0;

  constructor(
    private readonly nodeId: string,
    private readonly now: () => number = Date.now
  ) {}

  /** A stamp for a local event: later than every stamp this clock has issued or observed. */
  tick(): string {
    const wall = this.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else {
      this.bump();
    }
    return encodeHlc(this.ms, this.counter, this.nodeId);
  }

  /** Moves past a stamp received from another node, so the next local stamp is later than it. */
  observe(remote: string): void {
    const r = parseHlc(remote);
    const wall = this.now();
    const ms = Math.max(this.ms, r.ms, wall);
    if (ms === this.ms && ms === r.ms) {
      this.counter = Math.max(this.counter, r.counter);
      this.bump();
    } else if (ms === this.ms) {
      this.bump();
    } else if (ms === r.ms) {
      this.ms = ms;
      this.counter = r.counter;
      this.bump();
    } else {
      this.ms = ms;
      this.counter = 0;
    }
  }

  /** Next counter; past the counter's width the clock moves a millisecond ahead instead. */
  private bump(): void {
    if (this.counter >= COUNTER_MAX) {
      this.ms += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
  }
}
