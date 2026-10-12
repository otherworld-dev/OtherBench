import { useEffect, useRef, useState, type JSX } from 'react';
import type { McpServer } from '@grunt/core/ports/store.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { openInBrowser } from '../../desktop/bridge.js';
import { ApiError, api } from '../../state/api.js';

const SIGN_OUT_CONFIRM = 'Grunt will forget this sign-in. The provider still lists Grunt as allowed until you remove it there.';

/** "12 Oct 2026". */
export function formatSignInDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Settings > MCP servers, one saved http server's Sign-in section (spec
 * 2026-10-12-mcp-oauth-design §6). Shows the server's sign-in state from
 * the panel's health poll; while a sign-in is pending it also checks every
 * second and asks the panel to re-poll once it has ended. Tokens never
 * reach the browser: only the state, account and date do.
 */
export function McpSignIn({ server, health, onChanged }: { server: McpServer; health: McpServerHealth | null; onChanged: () => void }): JSX.Element {
  const auth = health?.auth ?? null;
  const fixedHeader = Object.keys(server.headerRefs).some((name) => name.toLowerCase() === 'authorization');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  // Set when a start succeeds, until the next health poll says so itself.
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => setOptimisticPending(false), [auth]);
  const pending = (auth?.pending ?? false) || optimisticPending;

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      api.mcpServers
        .list()
        .then((all) => {
          const mine = all.find((s) => s.id === server.id);
          if (mine && !mine.auth?.pending) onChangedRef.current();
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [pending, server.id]);

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      console.error(`[grunt-web] MCP sign-in action failed for ${server.id}:`, err);
      setActionError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const signIn = () =>
    run(async () => {
      const { authorizationUrl } = await api.mcpServers.signIn(server.id);
      setAuthUrl(authorizationUrl);
      setOptimisticPending(true);
      await openInBrowser(authorizationUrl);
    }, "Couldn't start the sign-in -- please try again.");

  const cancel = () =>
    run(async () => {
      await api.mcpServers.cancelSignIn(server.id);
      setAuthUrl(null);
      setOptimisticPending(false);
      onChanged();
    }, "Couldn't cancel the sign-in -- please try again.");

  const finish = () =>
    run(async () => {
      await api.mcpServers.completeSignIn(server.id, pasted.trim());
      setPasted('');
      setAuthUrl(null);
      setOptimisticPending(false);
      onChanged();
    }, "Couldn't finish the sign-in -- please try again.");

  const signOut = () => {
    if (!window.confirm(SIGN_OUT_CONFIRM)) return;
    void run(async () => {
      await api.mcpServers.signOut(server.id);
      onChanged();
    }, "Couldn't sign out -- please try again.");
  };

  let statusText: string;
  if (fixedHeader) statusText = 'Signs in with a fixed Authorization header. Remove the header to sign in with a browser instead.';
  else if (health === null) statusText = 'Checking sign-in…';
  else if (pending) statusText = "Finish signing in in your browser. This page updates when you're done.";
  else if (auth?.state === 'signed_in' && auth.signedInAt !== null)
    statusText = auth.account ? `Signed in as ${auth.account} since ${formatSignInDate(auth.signedInAt)}.` : `Signed in since ${formatSignInDate(auth.signedInAt)}.`;
  else if (auth?.state === 'needs_sign_in') statusText = 'This server needs you to sign in.';
  else statusText = "This server hasn't asked for a sign-in.";

  const signedIn = auth?.state === 'signed_in';

  return (
    <div data-testid="mcp-sign-in" className="space-y-1.5">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Sign-in</span>
      <p data-testid="mcp-sign-in-status" className="text-xs text-[var(--text-muted)]">
        {statusText}
      </p>
      {!fixedHeader && health !== null && (
        <>
          {auth?.error && <p className="text-xs text-[var(--danger)]">{auth.error}</p>}
          {actionError && <p className="text-xs text-[var(--danger)]">{actionError}</p>}
          {pending ? (
            <>
              <p className="text-xs text-[var(--text-muted)]">
                Signing in on another device? When its browser ends on a page that won&rsquo;t load, copy that page&rsquo;s address and paste it here.
              </p>
              <input
                aria-label="Address the sign-in ended on"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="http://127.0.0.1:…/oauth/callback?…"
                className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                {authUrl && (
                  <button type="button" onClick={() => void openInBrowser(authUrl)} className="btn px-2 py-1">
                    Open the sign-in page
                  </button>
                )}
                <button type="button" aria-label="Cancel sign-in" disabled={busy} onClick={() => void cancel()} className="btn px-2 py-1">
                  Cancel
                </button>
                <button type="button" disabled={busy || pasted.trim().length === 0} onClick={() => void finish()} className="btn btn-primary px-2 py-1">
                  Finish sign-in
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void signIn()} className="btn px-2 py-1">
                {signedIn ? 'Sign in again' : 'Sign in…'}
              </button>
              {signedIn && (
                <button type="button" disabled={busy} onClick={signOut} className="btn px-2 py-1">
                  Sign out
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
