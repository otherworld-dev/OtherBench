import { useEffect, useState, type JSX } from 'react';
import { api, type PushPrefs, type PushStatus } from '../../state/api.js';
import { DEFAULT_PUSH_PREFS, disablePush, enablePush, PushDeniedError, pushSupport } from '../../lib/push.js';

const PREF_LABELS: [keyof PushPrefs, string][] = [
  ['approvals', 'Approvals, questions and plans'],
  ['replies', 'Replies finished'],
  ['scheduled', 'Scheduled runs'],
];

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Settings → Notifications in sign-in mode: "Notify this device", Web Push to
 * this phone or browser even while OtherBench isn't open on it (lib/push.ts).
 * Per device: each signed-in device has its own, kept on the server with its
 * sign-in, and signing the device out turns it off.
 */
export function PushSection(): JSX.Element {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const support = pushSupport();

  useEffect(() => {
    let cancelled = false;
    api.push
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(`Couldn't read this device's notifications: ${errorText(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const on = status?.subscribed === true;
  const prefs = status?.prefs ?? DEFAULT_PUSH_PREFS;

  async function toggle(next: boolean): Promise<void> {
    if (!status) return;
    setProblem(null);
    setNote(null);
    setBusy(true);
    try {
      if (next) {
        if (!status.publicKey) throw new Error('The server gave no key to subscribe with.');
        const saved = await enablePush(status.publicKey, prefs);
        setStatus({ ...status, subscribed: true, prefs: saved });
      } else {
        await disablePush();
        setStatus({ ...status, subscribed: false, prefs: null });
      }
    } catch (err) {
      if (err instanceof PushDeniedError) {
        setProblem(err.message === 'denied' ? 'Your browser blocks notifications from OtherBench. Allow them in its site settings, then turn this on again.' : "Your browser didn't allow notifications, so this stays off.");
      } else {
        setProblem(`Couldn't turn notifications ${next ? 'on' : 'off'}: ${errorText(err)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function setPref(key: keyof PushPrefs, value: boolean): Promise<void> {
    if (!status) return;
    setProblem(null);
    const nextPrefs = { ...prefs, [key]: value };
    setStatus({ ...status, prefs: nextPrefs });
    try {
      const saved = await api.push.setPrefs(nextPrefs);
      setStatus((s) => (s ? { ...s, subscribed: saved.subscribed, prefs: saved.prefs } : s));
    } catch (err) {
      setStatus((s) => (s ? { ...s, prefs } : s));
      setProblem(`Couldn't save that: ${errorText(err)}`);
    }
  }

  async function test(): Promise<void> {
    setProblem(null);
    setNote(null);
    try {
      const { result } = await api.push.test();
      if (result === 'sent') setNote('Sent. It should arrive in a few seconds.');
      else if (result === 'gone') {
        setNote(null);
        setProblem('The browser has dropped this subscription. Turn notifications off and on again.');
        setStatus((s) => (s ? { ...s, subscribed: false, prefs: null } : s));
      } else setProblem("The push service didn't take it. The server's log says why.");
    } catch (err) {
      setProblem(`Couldn't send a test: ${errorText(err)}`);
    }
  }

  let unavailable: string | null = null;
  if (loadError) unavailable = loadError;
  else if (status && !status.available) unavailable = status.reason ?? 'Notifications are not available here.';
  else if (support === 'ios-home-screen') unavailable = 'On iPhone and iPad, add OtherBench to your Home Screen first (Share, then Add to Home Screen), open it from there and turn this on.';
  else if (support === 'insecure') unavailable = 'Notifications need OtherBench over https.';
  else if (support === 'unsupported') unavailable = "This browser can't receive push notifications.";

  return (
    <fieldset className="space-y-2" data-testid="push-section">
      <legend className="mb-1 font-medium">This device</legend>
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          disabled={status === null || unavailable !== null || busy}
          onChange={(e) => void toggle(e.target.checked)}
          className="size-5"
        />
        Notify this device
      </label>
      <p className="text-[var(--text-muted)]">
        {unavailable ??
          'Sends a notification to this device when something needs you, even with OtherBench closed. It holds only the chat title and what is waiting. Signing this device out turns it off.'}
      </p>
      {on && (
        <div className="space-y-1 pl-7">
          {PREF_LABELS.map(([key, label]) => (
            <label key={key} className="flex min-h-11 items-center gap-2">
              <input type="checkbox" checked={prefs[key]} onChange={(e) => void setPref(key, e.target.checked)} className="size-5" />
              {label}
            </label>
          ))}
          <button type="button" className="btn min-h-11 px-3" onClick={() => void test()}>
            Send a test
          </button>
        </div>
      )}
      {note && <p className="text-[var(--text-muted)]">{note}</p>}
      {problem && (
        <p role="alert" className="text-[var(--danger)]">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
