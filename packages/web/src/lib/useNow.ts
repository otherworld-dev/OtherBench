import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs`: for text like "5m" that has to keep up without anything else changing. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
