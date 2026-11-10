import { useState, type JSX } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { ComputerStartOutcome } from '@otherbench/core/types/events.js';
import { ApiError, api } from '../state/api.js';
import { computerSessionElsewhere } from '../state/peerActivity.js';
import { useOtherBenchStore } from '../state/store.js';
import { oneLine } from '../viewer/browser.js';

/**
 * Above the composer while this chat controls the computer (spec
 * 2026-10-12-computer-use-design section 7), from the `computer-session`
 * events and the events stream's hello. Stop ends control and the reply; the
 * shell's own bar and Ctrl+Alt+Backspace do the same on the machine itself.
 * A session a paired machine started here says which one.
 *
 * Also while the chat controls a paired machine, as that machine last said
 * (its `activity`, read through `GET /api/peers`): the banner names it, and
 * Stop goes to this machine's server, which sends it there.
 *
 * And for a chat that runs on a reachable paired machine with a profile that
 * uses the computer and no session: "Start on PC", which asks that machine to
 * start one (it decides whether it lets paired machines, and its own start
 * dialog asks the person there). When that start doesn't happen, that machine
 * says how it ended (`peer-computer-start`: declined, nobody answered, or
 * neither) and the line says so until Start is asked again.
 *
 * The last action is the server's `actionSummary` of what was carried out,
 * which never holds typed text; it is still shown as one clean line in a
 * `<bdi>`. The session carries no app, so the banner names none.
 */
/** How a start asked of `machine` ended without a session, as the Start line says it. */
function endedText(outcome: ComputerStartOutcome, machine: string): string {
  if (outcome === 'declined') return `${machine} declined: nobody there said OK, so computer use didn't start.`;
  if (outcome === 'unanswered') return `Nobody answered on ${machine} in time, so computer use didn't start.`;
  return `Computer use didn't start on ${machine}.`;
}

export function ComputerBanner({ chat }: { chat: Chat }): JSX.Element | null {
  const local = useOtherBenchStore((s) => s.computerSessions[chat.id]);
  const machines = useOtherBenchStore((s) => s.machines);
  const usesComputer = useOtherBenchStore((s) => s.profiles.find((p) => p.id === chat.profileId)?.toolPolicy.computer === true);
  const startEnded = useOtherBenchStore((s) => s.peerComputerStarts[chat.id]);
  const clearStartEnded = useOtherBenchStore((s) => s.clearPeerComputerStart);
  const elsewhere = local ? null : computerSessionElsewhere(machines, chat.id);
  const [busy, setBusy] = useState(false);
  const [startNote, setStartNote] = useState<{ chatId: string; text: string; failed: boolean } | null>(null);
  const session = local ?? elsewhere;

  if (!session) {
    const runsOn = machines && chat.runsOn !== machines.self.id ? machines.peers.find((p) => p.nodeId === chat.runsOn && p.status === 'reachable') : undefined;
    if (!runsOn || !usesComputer) return null;
    const machine = oneLine(runsOn.name);
    // How that machine said the last start ended wins over "Asked PC": it came after.
    const ended = startEnded?.nodeId === runsOn.nodeId ? { text: endedText(startEnded.outcome, machine), failed: true } : null;
    const note = ended ?? (startNote?.chatId === chat.id ? startNote : null);

    async function start(): Promise<void> {
      setBusy(true);
      setStartNote(null);
      clearStartEnded(chat.id);
      try {
        await api.chats.startComputer(chat.id);
        setStartNote({ chatId: chat.id, text: `Asked ${machine}. Someone there has to say OK in its dialog before it starts.`, failed: false });
      } catch (err) {
        setStartNote({ chatId: chat.id, text: err instanceof ApiError ? err.message : `Couldn't ask ${machine} to start computer use.`, failed: true });
      } finally {
        setBusy(false);
      }
    }

    return (
      <div data-testid="computer-start-remote" className="mx-4 mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className="min-w-0 flex-1">
          Computer use for this chat runs on <bdi>{machine}</bdi>.
          {note && (
            <span role={note.failed ? 'alert' : 'status'} className={`ml-2 ${note.failed ? 'text-[var(--danger)]' : ''}`}>
              {note.text}
            </span>
          )}
        </span>
        <button type="button" disabled={busy} onClick={() => void start()} className="btn px-2 py-0.5">
          Start on <bdi>{machine}</bdi>
        </button>
      </div>
    );
  }

  const lastAction = oneLine(session.lastAction);
  const startedFrom = local?.startedFrom ? oneLine(local.startedFrom) : '';

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
      {...(elsewhere ? { 'data-machine': elsewhere.nodeId } : {})}
      className="mx-4 mb-2 flex items-center gap-2 rounded border border-[var(--warn)] bg-[var(--bg-raised)] p-3 text-sm"
    >
      <span aria-hidden="true">{'\u{1F5B1}'}</span>
      <span className="min-w-0 flex-1">
        {elsewhere ? (
          <>
            OtherBench is controlling <bdi>{oneLine(elsewhere.machine)}</bdi>.
          </>
        ) : (
          'OtherBench is controlling this computer.'
        )}
        {startedFrom !== '' && (
          <span data-testid="computer-banner-from" className="ml-2">
            Started from <bdi>{startedFrom}</bdi>.
          </span>
        )}
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
