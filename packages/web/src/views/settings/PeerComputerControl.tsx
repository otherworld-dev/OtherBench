import { useEffect, useState, type JSX } from 'react';
import { isDesktop } from '../../desktop/bridge.js';
import { ApiError, api } from '../../state/api.js';

/**
 * "Let paired machines start and approve computer use" (`peerComputerControl`, off by default; this machine only,
 * never synced). On: a paired machine can ask to start computer use here (this machine's own start dialog asks the
 * person here, naming that machine), send messages and answer its cards while it is in control, so it can drive this
 * computer's mouse and keyboard. Off: it can still see a session here and Stop it. Only this machine's desktop app
 * may turn it on, and only once the person presses OK in the native question the desktop app then shows (the server
 * asks the shell; this page can't answer it); anywhere that reaches Settings may turn it off, so outside the
 * desktop app the box is only enabled while it is on. Neither switches computer use itself on.
 */
export function PeerComputerControl(): JSX.Element {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  /** Turning it on waits for the person to answer OtherBench's own question on this computer. */
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = isDesktop();

  useEffect(() => {
    let live = true;
    api.settings
      .get()
      .then((s) => live && setOn(s.peerComputerControl === true))
      .catch((err: unknown) => console.error('[otherbench-web] failed to load the settings:', err));
    return () => {
      live = false;
    };
  }, []);

  async function change(value: boolean): Promise<void> {
    setSaving(true);
    setAsking(value);
    setError(null);
    try {
      setOn((await api.settings.patch({ peerComputerControl: value })).peerComputerControl === true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
      setAsking(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-testid="peer-computer-control"
          checked={on === true}
          disabled={on === null || saving || (!here && on !== true)}
          onChange={(e) => void change(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">Let paired machines start and approve computer use</span>
          <span className="block text-xs text-[var(--text-muted)]">
            A paired machine can then ask to start computer use on this computer, and someone here has to accept it in the dialog that comes up.
            While the session runs, that machine can message the chat and answer its approval cards, so it controls this computer's mouse and
            keyboard in the apps those cards let through, with nobody here having to approve each step. Off (the default), a paired machine can
            only see a session here and stop it. Computer use itself stays on or off as it is.
          </span>
        </span>
      </label>
      {asking && (
        <p data-testid="peer-computer-control-asking" className="text-xs text-[var(--warn)]">
          OtherBench is asking you to confirm this in a window on this computer. It only turns on if you press OK there.
        </p>
      )}
      {!here && (
        <p data-testid="peer-computer-control-desktop-only" className="text-xs text-[var(--warn)]">
          {on === true
            ? 'This can only be turned on in the OtherBench desktop app on this computer. From here you can turn it off.'
            : 'This can only be turned on in the OtherBench desktop app on this computer, not from a browser, another device or a paired machine.'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
