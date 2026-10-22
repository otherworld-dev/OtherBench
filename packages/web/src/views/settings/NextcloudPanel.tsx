import { useEffect, useState, type JSX } from 'react';
import type { NextcloudTestResult } from '@otherbench/core/types/nextcloud.js';
import { ApiError, api } from '../../state/api.js';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const INPUT = 'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm';
const LABEL = 'mb-1 block text-xs font-medium text-[var(--text-muted)]';

/**
 * Settings > Nextcloud: the server address, user and app password the Deck, Wiki and Links tabs use.
 * The password is write-only: the server never returns it, so the field is never pre-filled; it is sent
 * only when typed, or as `null` when "Clear password" is ticked.
 */
export function NextcloudPanel(): JSX.Element {
  const [baseUrl, setBaseUrl] = useState('');
  const [user, setUser] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordSet, setPasswordSet] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NextcloudTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.nextcloud
      .get()
      .then((s) => {
        if (cancelled) return;
        // Anything typed before the load answered stays.
        setBaseUrl((typed) => typed || (s.baseUrl ?? ''));
        setUser((typed) => typed || (s.user ?? ''));
        setPasswordSet(s.passwordSet);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Could not load the Nextcloud settings.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: { baseUrl: string; user: string; password?: string | null } = { baseUrl: baseUrl.trim(), user: user.trim() };
      if (clearPassword) body.password = null;
      else if (passwordDraft.length > 0) body.password = passwordDraft;
      const view = await api.nextcloud.put(body);
      setPasswordSet(view.passwordSet);
      setPasswordDraft('');
      setClearPassword(false);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await api.nextcloud.test());
    } catch (err) {
      setTestError(errorMessage(err, 'Test failed -- please try again.'));
    } finally {
      setTesting(false);
    }
  }

  const mark = (on: boolean): string => (on ? '✓' : '✗');

  return (
    <div data-testid="nextcloud-panel" className="max-w-xl space-y-4">
      <div>
        <label className={LABEL} htmlFor="nextcloud-url">
          Server URL
        </label>
        <input id="nextcloud-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://cloud.example.com" className={INPUT} />
      </div>

      <div>
        <label className={LABEL} htmlFor="nextcloud-user">
          User name
        </label>
        <input id="nextcloud-user" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" className={INPUT} />
      </div>

      <div>
        <label className={LABEL} htmlFor="nextcloud-password">
          App password
        </label>
        <p data-testid="nextcloud-password-status" className="mb-1 text-xs text-[var(--text-muted)]">
          {passwordSet ? 'A password is currently set.' : 'No password is currently set.'}
        </p>
        <input
          id="nextcloud-password"
          type="password"
          value={passwordDraft}
          disabled={clearPassword}
          onChange={(e) => setPasswordDraft(e.target.value)}
          placeholder={passwordSet ? 'Leave blank to keep the current password' : ''}
          autoComplete="new-password"
          className={`${INPUT} disabled:opacity-50`}
        />
        {passwordSet && (
          <label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={clearPassword}
              onChange={(e) => {
                setClearPassword(e.target.checked);
                if (e.target.checked) setPasswordDraft('');
              }}
            />
            Clear password
          </label>
        )}
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Create an app password in Nextcloud under Settings → Security → Devices &amp; sessions. It stays on this machine.
        </p>
      </div>

      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {saved && <p className="text-xs text-[var(--success)]">Saved.</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <button type="button" onClick={() => void handleSave()} disabled={saving} className="btn btn-primary px-3 py-1.5">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => void handleTest()} disabled={testing} className="btn px-3 py-1.5">
          {testing ? 'Testing…' : 'Test'}
        </button>
      </div>

      {testResult && (
        <div data-testid="nextcloud-test-result" className={`text-sm ${testResult.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
          <p>{testResult.message}</p>
          <p data-testid="nextcloud-apps" className="text-[var(--text-muted)]">
            {`Deck ${mark(testResult.apps.deck)} / Collectives ${mark(testResult.apps.collectives)} / Bookmarks ${mark(testResult.apps.bookmarks)}`}
          </p>
        </div>
      )}
      {testError && <p className="text-sm text-[var(--danger)]">{testError}</p>}
    </div>
  );
}
