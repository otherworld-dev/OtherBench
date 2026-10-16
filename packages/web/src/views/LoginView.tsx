import { useState, type FormEvent, type JSX } from 'react';
import { ApiError } from '../state/api.js';
import { useAuthStore } from '../state/auth.js';
import { serverUrl } from '../state/transport.js';

/**
 * Sign in to an OtherBench reached from another device (spec
 * 2026-10-12-remote-access §5). Full page when signed out at load; over the
 * app (`overlay`) when a session ends while it's open, so an unsent message
 * survives. Works at 390 px wide.
 */
export function LoginView({ overlay = false }: { overlay?: boolean }): JSX.Element {
  const caDownload = useAuthStore((s) => s.info?.caDownload === true);
  const signIn = useAuthStore((s) => s.signIn);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(password, remember);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach OtherBench. Check the connection and try again.");
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="login-view"
      className={`${overlay ? 'fixed inset-0 z-50' : 'min-h-screen'} flex items-center justify-center bg-[var(--bg)] px-4 font-sans text-[var(--text)]`}
    >
      <form onSubmit={(e) => void submit(e)} aria-label="Sign in to OtherBench" className="w-full max-w-sm space-y-4">
        <h1 className="label-caps text-lg">OtherBench</h1>
        {overlay && <p className="text-sm text-[var(--text-muted)]">You've been signed out. Sign in again to carry on; nothing you typed is lost.</p>}
        {/* Password managers save a password against a user name; there's only ever this one. */}
        <input type="text" name="username" autoComplete="username" value="otherbench" readOnly hidden />
        <label className="block text-sm">
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Keep me signed in on this device
        </label>
        {error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || password === ''} className="btn btn-primary w-full py-2">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {caDownload && (
          <p className="text-xs text-[var(--text-muted)]">
            <a href={serverUrl('/otherbench-ca.crt')} download className="underline">
              Download OtherBench's certificate
            </a>
            . Check its fingerprint against the one the server printed when it started.
          </p>
        )}
      </form>
    </div>
  );
}
