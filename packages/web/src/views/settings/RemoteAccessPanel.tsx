import { useState, type JSX } from 'react';
import type { AuthStatus } from '../../state/api.js';
import { useAuthStore } from '../../state/auth.js';
import { serverUrl } from '../../state/transport.js';

const date = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

type Remote = NonNullable<AuthStatus['remote']>;

function HttpsDetails({ remote }: { remote: Remote }): JSX.Element {
  const { tls, trustProxies } = remote;
  return (
    <div className="space-y-2">
      {tls.mode === 'auto' && (
        <>
          <p>
            Grunt's own certificate, valid until {tls.notAfter !== undefined ? date(tls.notAfter) : 'unknown'}, for {(tls.names ?? []).join(', ')}.
          </p>
          <p>
            Its certificate authority's fingerprint (SHA-256): <code className="break-all font-mono text-xs">{tls.caFingerprint}</code>
          </p>
          <p>
            <a href={serverUrl('/grunt-ca.crt')} download className="underline">
              Download Grunt's certificate
            </a>{' '}
            to trust it on another device, and check its fingerprint against the one the server printed when it started.
          </p>
        </>
      )}
      {tls.mode === 'files' && <p>Your own certificate, valid until {tls.notAfter !== undefined ? date(tls.notAfter) : 'unknown'}.</p>}
      {tls.mode === 'proxy' && <p>An HTTPS proxy in front of Grunt.</p>}
      {trustProxies.length > 0 && (
        <p>
          Trusted proxy addresses:{' '}
          {trustProxies.map((p, i) => (
            <span key={p}>
              {i > 0 && ', '}
              <code className="font-mono text-xs">{p}</code>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * Settings → Remote access (spec 2026-10-12-remote-access §5): only offered
 * in sign-in mode. How this device is signed in, the addresses Grunt answers
 * on, how HTTPS works, and Sign out everywhere.
 */
export function RemoteAccessPanel(): JSX.Element {
  const info = useAuthStore((s) => s.info);
  const signOutEverywhere = useAuthStore((s) => s.signOutEverywhere);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = info?.remote;
  const session = info?.session;

  async function everywhere(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await signOutEverywhere();
    } catch (err) {
      setError(`Couldn't sign out everywhere: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <section className="space-y-1">
        <h3 className="label-caps">This device</h3>
        <p>{session ? `Signed in until ${new Date(session.expiresAt).toLocaleString()}.` : 'Signed in with the server token.'}</p>
      </section>
      {remote && (
        <section className="space-y-1">
          <h3 className="label-caps">Addresses</h3>
          <ul className="space-y-0.5">
            {remote.publicUrls.map((u) => (
              <li key={u}>
                <code className="font-mono text-xs">{u}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {remote && (
        <section className="space-y-1">
          <h3 className="label-caps">HTTPS</h3>
          <HttpsDetails remote={remote} />
        </section>
      )}
      <section className="space-y-2">
        <h3 className="label-caps">Sign out everywhere</h3>
        <p className="text-[var(--text-muted)]">Ends every session, this one included. Each device has to sign in again.</p>
        <button type="button" disabled={busy} onClick={() => void everywhere()} className="btn btn-danger px-3 py-1.5">
          Sign out everywhere
        </button>
        {error && (
          <p role="alert" className="text-[var(--danger)]">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
