import { useState, type JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import { ApiError, api } from '../state/api.js';
import { machineName, remoteUnreachable } from '../state/machines.js';
import { useGruntStore } from '../state/store.js';

/**
 * Shown on a chat that runs on another machine which can't be reached (v2
 * spec §5): offers to run it here instead. That moves the chat; its folder
 * is then resolved on this machine, and the folder prompt takes over if it
 * isn't here. Once moved, it says so until dismissed, since nothing else on
 * screen changes.
 */
export function UnreachableBanner({ chat }: { chat: Chat }): JSX.Element | null {
  const machines = useGruntStore((s) => s.machines);
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The chat this banner moved here, and this machine's name. */
  const [moved, setMoved] = useState<{ chatId: string; name: string } | null>(null);
  if (moved && moved.chatId === chat.id && chat.runsOn === machines?.self.id) {
    return (
      <div data-testid="moved-here" role="status" className="mx-4 mb-2 flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-3 text-sm">
        <span className="flex-1">This chat now runs on {moved.name}. Send a message to carry on.</span>
        <button type="button" onClick={() => setMoved(null)} aria-label="Dismiss" className="rounded px-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]">
          ×
        </button>
      </div>
    );
  }
  if (!machines || !remoteUnreachable(machines, chat)) return null;
  const name = machineName(machines, chat.runsOn);

  async function runHere(): Promise<void> {
    if (!machines) return;
    setBusy(true);
    setError(null);
    try {
      upsertChat(await api.chats.patch(chat.id, { runsOn: machines.self.id }));
      setMoved({ chatId: chat.id, name: machines.self.name });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't move the chat. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="unreachable-banner" role="status" className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded border border-[var(--warn)] bg-[var(--bg-raised)] p-3 text-sm">
      <span className="flex-1">This chat runs on {name}, which isn&apos;t reachable. Run it here instead?</span>
      <button
        type="button"
        onClick={() => void runHere()}
        disabled={busy}
        className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-text)] disabled:opacity-50"
      >
        Run here
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
