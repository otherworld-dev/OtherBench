import { useEffect, type JSX, type ReactNode } from 'react';
import { useAuthStore } from '../state/auth.js';
import { onUnauthorized } from '../state/transport.js';
import { LoginView } from '../views/LoginView.js';

/**
 * The browser build's sign-in gate (spec 2026-10-12-remote-access §5); the
 * desktop app never mounts it. Asks the server how it signs people in once:
 * open or signed in shows the app; signed out at load shows only the login
 * page, so the app doesn't fire a burst of 401s; signed out later puts the
 * login over the app, which stays mounted (its streams reconnect on their
 * own backoff once signed in again); token mode says so. If the server
 * can't be reached the app shows as before, with its own unreachable state.
 */
export function AuthGate({ children }: { children: ReactNode }): JSX.Element | null {
  const status = useAuthStore((s) => s.status);
  const mode = useAuthStore((s) => s.mode);
  const overlay = useAuthStore((s) => s.overlay);

  useEffect(() => {
    void useAuthStore.getState().loadStatus();
  }, []);

  useEffect(() => {
    if (mode !== 'login') return undefined;
    return onUnauthorized(() => useAuthStore.getState().expire());
  }, [mode]);

  if (status === 'checking') return null;
  if (status === 'token-needed') return <TokenNeeded />;
  const showApp = status === 'ready' || overlay;
  // The app is always the first child, so it stays mounted while the login comes and goes over it.
  return (
    <>
      {showApp ? children : null}
      {status === 'signed-out' ? <LoginView overlay={overlay} /> : null}
    </>
  );
}

function TokenNeeded(): JSX.Element {
  return (
    <div className="mx-auto mt-16 max-w-md px-4 font-sans text-sm">
      <h1 className="label-caps mb-2 text-lg">Grunt</h1>
      <p role="alert">This server needs a token. Use the desktop app, or turn on sign-in (--public-url).</p>
    </div>
  );
}
