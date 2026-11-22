/**
 * Hybrid logical clock (v2 spec §4): wall-clock milliseconds, a counter for
 * events in the same millisecond (or while the wall clock is behind), and
 * the node id as the tie-break. Encoded as `<ms:13>-<counter:4>-<nodeId>`,
 * zero-padded, so stamps compare correctly as plain strings.
 */

const COUNTER_MAX = 9999;

/**
 * How far ahead of this machine's wall clock another machine's stamp may be
 * and still be taken. Past it the other machine's clock is wrong (or the stamp
 * is made up): following it would push this clock, and every stamp it gives
 * from then on, that far into the future for good.
 */
export const HLC_MAX_AHEAD_MS = 5 * 60_000;

/**
 * Whether `stamp` is further ahead of `wall` than a stamp from a machine with
 * a sane clock can be. Compared as text, the way stamps decide winners, so a
 * stamp that isn't shaped like one (and would sort after every real stamp) is
 * too far ahead as well.
 */
export function hlcTooFarAhead(stamp: string, wall: number): boolean {
  return compareHlc(stamp, encodeHlc(wall + HLC_MAX_AHEAD_MS + 1, 0, '')) >= 0;
}

/**
 * How far ahead a stamp may be and still be worth waiting for. A clock an hour
 * or a time zone out gives stamps this machine's time reaches soon enough, so
 * what they stamp is asked for again until it can be taken. One more than a day
 * ahead is a wrong date (or made up): waiting for it would hold sync up for as
 * long as the date was wrong by, so it is passed over instead, and a clock is
 * never started from one.
 */
export const HLC_MAX_WAIT_MS = 24 * 60 * 60_000;

/** Whether `stamp` is too far ahead of `wall` to take now, but near enough that it will be (see `HLC_MAX_WAIT_MS`). */
export function hlcWorthWaitingFor(stamp: string, wall: number): boolean {
  return hlcTooFarAhead(stamp, wall) && compareHlc(stamp, encodeHlc(wall + HLC_MAX_WAIT_MS + 1, 0, '')) < 0;
}

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

  /**
   * `after`: a stamp this clock starts later than (the newest one the store
   * holds), so a restart with the wall clock behind it can't hand out stamps
   * older than ones already written. It is this machine's own record, so it is
   * taken however far ahead it is.
   */
  constructor(
    private readonly nodeId: string,
    private readonly now: () => number = Date.now,
    after = ''
  ) {
    const start = parseHlc(after);
    this.ms = start.ms;
    this.counter = start.counter;
  }

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

  /**
   * Moves past a stamp received from another node, so the next local stamp is
   * later than it. A stamp too far ahead of the wall clock (`hlcTooFarAhead`)
   * moves nothing and answers false: the caller must not take what it stamps.
   */
  observe(remote: string): boolean {
    const wall = this.now();
    if (hlcTooFarAhead(remote, wall)) return false;
    const r = parseHlc(remote);
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
    return true;
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
