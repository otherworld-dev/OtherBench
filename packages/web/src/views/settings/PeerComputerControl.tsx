import { useEffect, useState, type JSX } from 'react';
import { ApiError, api } from '../../state/api.js';

/**
 * "Let paired machines start and approve computer use" (`peerComputerControl`, on by default; this machine only).
 * On: a paired machine can start computer use here (this machine's own start dialog still asks), send messages and
 * answer its cards while it is in control, so it can drive this computer's desktop. Off: it can still see a session
 * here and Stop it. Neither switches computer use itself on; the server checks the setting on every call.
 */
export function PeerComputerControl(): JSX.Element {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.settings
      .get()
      .then((s) => live && setOn(s.peerComputerControl !== false))
      .catch((err: unknown) => console.error('[otherbench-web] failed to load the settings:', err));
    return () => {
      live = false;
    };
  }, []);

  async function change(value: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      setOn((await api.settings.patch({ peerComputerControl: value })).peerComputerControl !== false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-testid="peer-computer-control"
          checked={on === true}
          disabled={on === null || saving}
          onChange={(e) => void change(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">Let paired machines start and approve computer use</span>
          <span className="block text-xs text-[var(--text-muted)]">
            A paired machine can then start computer use on this computer, message the chat and answer its cards while it is in control, so it can
            click and type in apps here. This computer still asks before each session starts. Off, a paired machine can only see a session here and
            stop it. Computer use itself stays on or off as it is.
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
