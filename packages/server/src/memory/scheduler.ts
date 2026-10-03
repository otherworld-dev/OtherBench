/** The timers `ProjectMemoryService` uses; injected so tests drive time by hand (test/memory/manual-clock.ts). */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers, unref'd: a pending quiet timer or call timeout never keeps the process alive. */
export const realScheduler: Scheduler = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
