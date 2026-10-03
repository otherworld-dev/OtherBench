import type { Scheduler } from '../../src/memory/scheduler.js';

/** A clock and scheduler driven by hand: `advance` moves time and fires every timer that falls due, earliest first. */
export class ManualClock implements Scheduler {
  time: number;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();
  private nextId = 1;

  constructor(start = 1_000_000_000) {
    this.time = start;
  }

  readonly now = (): number => this.time;

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { due: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = next[1].due;
      next[1].fn();
    }
    this.time = target;
  }

  /** How long from now each pending timer has left, soonest first. */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.due - this.time).sort((a, b) => a - b);
  }
}
