import { useEffect, useState } from 'react';
import { api } from '../state/api.js';

/**
 * Whether this server can offer computer use (`GET /api/computer/status`'s
 * `computerUse`, behind the auth gate): the desktop app on Windows with the
 * shell's driver on. False until it loads, and false for anything but an
 * answer of exactly `true` (a 401, a 404 from an older server, a network
 * error, a missing api in a test).
 */
export function useComputerUseAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.computer.status())
      .then((status) => {
        if (!cancelled) setAvailable(status?.computerUse === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
