import { useEffect, useState, type JSX } from 'react';
import { ApiError, api } from '../../state/api.js';

/**
 * "Let chats on paired machines send work to chats here" (`peerChatSends`, off by default; this machine only, never
 * synced, and the peer listener has no settings route, so a paired machine can't turn it on). On: a chat on a paired
 * machine can hand `message_chats` work to a chat or app here, which starts on it by itself (spec
 * 2026-11-13-chat-sends-across-machines-design). Off: those sends are refused, and the paired machine's list says so.
 */
export function PeerChatSends(): JSX.Element {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.settings
      .get()
      .then((s) => live && setOn(s.peerChatSends === true))
      .catch((err: unknown) => console.error('[otherbench-web] failed to load the settings:', err));
    return () => {
      live = false;
    };
  }, []);

  async function change(value: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      setOn((await api.settings.patch({ peerChatSends: value })).peerChatSends === true);
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
          data-testid="peer-chat-sends"
          checked={on === true}
          disabled={on === null || saving}
          onChange={(e) => void change(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">Let chats on paired machines send work to chats here</span>
          <span className="block text-xs text-[var(--text-muted)]">
            A chat on a paired machine can then send work to chats and apps here, which start on it by themselves. Off (the default), they
            can&rsquo;t.
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
