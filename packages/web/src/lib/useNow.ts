import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs`: for text like "5m" that has to keep up without anything else
 * changing. Null stops the clock (a card that has finished), keeping the last reading; the reading is the time
 * of the last tick, not of the render, so a render for another reason doesn't move it.
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
