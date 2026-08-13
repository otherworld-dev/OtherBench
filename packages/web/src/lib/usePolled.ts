import { useEffect, useState } from 'react';

/**
 * How often a `usePolled` consumer re-fetches by default. There is no push
 * channel for the honest-state data this hook backs (MCP server health,
 * grants, audit trail -- unlike the thread itself, which is SSE-driven):
 * each changes on its own timeline (health checks/reconnects, an approval
 * resolved from a sibling component, a gated tool call) with nothing to
 * notify the consuming component. Polling is the simple, honest choice over
 * wiring a second SSE channel or lifting shared state up.
 */
export const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * Polls `fetcher` every `intervalMs` (default {@link DEFAULT_POLL_INTERVAL_MS}),
 * starting immediately and restarting whenever `deps` changes (e.g.
 * switching chats, or navigating to a different settings tab). Deliberately
 * does NOT clear `data` back to `null` between ticks of the SAME poll loop
 * -- only on a genuine restart -- so a routine re-poll updates values in
 * place instead of flashing back to a loading state every few seconds.
 */
export function usePolled<T>(fetcher: () => Promise<T>, deps: unknown[], intervalMs = DEFAULT_POLL_INTERVAL_MS): { data: T | null; failed: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setFailed(false);

    async function tick(): Promise<void> {
      try {
        const result = await fetcher();
        if (!cancelled) {
          setData(result);
          setFailed(false);
        }
      } catch (err) {
        console.error('[grunt-web] usePolled fetch failed:', err);
        if (!cancelled) setFailed(true);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's own explicit restart list, not derivable from `fetcher`'s identity.
  }, deps);

  return { data, failed };
}
