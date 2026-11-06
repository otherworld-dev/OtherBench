import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, ApiError, type SignedInDevice } from '../../state/api.js';
import { useAuthStore } from '../../state/auth.js';

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Settings → Remote access → Signed-in devices: every browser signed in to
 * this server, with a Sign out for each. Signing this browser out is the
 * ordinary Sign out.
 */
export function SignedInDevices(): JSX.Element {
  const signOut = useAuthStore((s) => s.signOut);
  const [devices, setDevices] = useState<SignedInDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Its state is set in the callbacks, after the read: none of it synchronously in the effect that loads on open.
  const load = useCallback(
    (): Promise<void> =>
      api.auth.sessions().then(
        (r) => setDevices(r.sessions),
        (err: unknown) => setError(`Couldn't list the signed-in devices: ${err instanceof Error ? err.message : String(err)}`)
      ),
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function end(device: SignedInDevice): Promise<void> {
    setBusy(device.id);
    setError(null);
    if (device.current) {
      await signOut();
      return;
    }
    try {
      await api.auth.endSession(device.id);
    } catch (err) {
      // 404: it was already signed out, which is what was asked for.
      if (!(err instanceof ApiError && err.status === 404)) setError(`Couldn't sign that device out: ${err instanceof Error ? err.message : String(err)}`);
    }
    await load();
    setBusy(null);
  }

  return (
    <div className="space-y-2">
      {devices === null && !error && <p className="text-[var(--text-muted)]">Loading…</p>}
      {devices !== null && devices.length === 0 && <p className="text-[var(--text-muted)]">No browser is signed in.</p>}
      {devices !== null && devices.length > 0 && (
        <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)]" aria-label="Signed-in devices">
          {devices.map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {d.deviceLabel}
                  {d.current && <span className="ml-2 rounded bg-[var(--bg-raised)] px-1.5 py-0.5 text-xs font-normal text-[var(--text-muted)]">This device</span>}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {d.address ?? 'Unknown address'} · Signed in {when(d.createdAt)} · Last seen {when(d.lastSeenAt)}
                </p>
              </div>
              <button type="button" disabled={busy !== null} onClick={() => void end(d)} className="btn shrink-0 px-2.5 py-1 text-xs" aria-label={`Sign out ${d.deviceLabel}${d.current ? ' (this device)' : ''}`}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
