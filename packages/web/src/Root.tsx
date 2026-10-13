import type { JSX } from 'react';
import { App } from './App.js';
import { AuthGate } from './components/AuthGate.js';

/**
 * The desktop app renders `<App/>` exactly as before and never asks the
 * sign-in status route; a browser wraps it in the sign-in gate (spec
 * 2026-10-12-remote-access §5-6).
 */
export function Root({ desktop }: { desktop: boolean }): JSX.Element {
  return desktop ? <App /> : <AuthGate><App /></AuthGate>;
}
