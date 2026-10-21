import { useEffect, useState } from 'react';
import type { TerminalStatus } from '@otherbench/core/types/terminal.js';
import { api } from '../../state/api.js';

let cached: Promise<TerminalStatus> | null = null;

/**
 * Whether this server has terminals, and its shells (`GET /api/terminal/status`), fetched once per page. Null until
 * known. A failed fetch counts as none and is asked again on the next mount.
 */
export function useTerminalStatus(): TerminalStatus | null {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  useEffect(() => {
    let live = true;
    // A promise from the start, so any failure (a mocked or older client included) counts as none.
    cached ??= Promise.resolve()
      .then(() => api.terminals.status())
      .catch((): TerminalStatus => {
        cached = null;
        return { available: false, shells: [] };
      });
    void cached.then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);
  return status;
}
