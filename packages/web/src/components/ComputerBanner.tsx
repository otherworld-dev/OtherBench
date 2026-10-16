import { useState, type JSX } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { oneLine } from '../viewer/browser.js';

/**
 * Above the composer while this chat controls the computer (spec
 * 2026-10-12-computer-use-design section 7), from the `computer-session`
 * events and the events stream's hello. Stop ends control and the reply; the
 * shell's own bar and Ctrl+Alt+Backspace do the same on the machine itself.
 *
 * The last action is the server's `actionSummary` of what was carried out,
 * which never holds typed text; it is still shown as one clean line in a
 * `<bdi>`. The session carries no app, so the banner names none.
 */
export function ComputerBanner({ chat }: { chat: Chat }): JSX.Element | null {
  const session = useOtherBenchStore((s) => s.computerSessions[chat.id]);
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  const lastAction = oneLine(session.lastAction);

  async function stop(): Promise<void> {
    setBusy(true);
    try {
      await api.chats.stopComputer(chat.id);
    } catch (err) {
      console.error('[otherbench-web] failed to stop computer use:', err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="computer-banner"
      role="status"
      className="mx-4 mb-2 flex items-center gap-2 rounded border border-[var(--warn)] bg-[var(--bg-raised)] p-3 text-sm"
    >
      <span aria-hidden="true">{'\u{1F5B1}'}</span>
      <span className="min-w-0 flex-1">
        OtherBench is controlling this computer.
        {lastAction !== '' && (
          <span data-testid="computer-banner-last" className="ml-2 text-xs break-words text-[var(--text-muted)]">
            Last: <bdi>{lastAction}</bdi>
          </span>
        )}
      </span>
      <button type="button" disabled={busy} onClick={() => void stop()} className="btn btn-danger px-2 py-1">
        Stop
      </button>
    </div>
  );
}
