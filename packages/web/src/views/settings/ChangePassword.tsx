import { useState, type FormEvent, type JSX } from 'react';
import { ApiError } from '../../state/api.js';
import { useAuthStore } from '../../state/auth.js';

/** Same rule as the server's `passwordProblem`: 12 to 1,024 characters. */
function problem(next: string): string | null {
  const n = [...next].length;
  if (n < 12) return 'The password must be at least 12 characters.';
  if (n > 1024) return 'The password can be at most 1,024 characters.';
  return null;
}

/**
 * Settings → Remote access → Change password (spec 2026-10-12-remote-access
 * §5). Needs the current password; every other device is signed out and
 * this one gets a new session. `grunt password` on the box does the same.
 */
export function ChangePassword(): JSX.Element {
  const changePassword = useAuthStore((s) => s.changePassword);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== again) return setError("The new passwords don't match.");
    const why = problem(next);
    if (why) return setError(why);
    setBusy(true);
    try {
      await changePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't change the password: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const field = 'mt-1 block w-full max-w-sm rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5';
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2" aria-label="Change password">
      <input type="text" name="username" autoComplete="username" value="grunt" readOnly hidden />
      <label className="block">
        Current password
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
      </label>
      <label className="block">
        New password
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
      </label>
      <label className="block">
        New password again
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={field} />
      </label>
      <button type="submit" disabled={busy || current === '' || next === ''} className="btn px-3 py-1.5">
        Change password
      </button>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
      {done && <p role="status">Password changed. Every other device is signed out.</p>}
    </form>
  );
}
