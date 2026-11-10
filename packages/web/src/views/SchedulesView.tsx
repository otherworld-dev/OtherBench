import { useCallback, useEffect, useState, type JSX } from 'react';
import type { ScheduleTarget } from '@otherbench/core/domain/schedule.js';
import { SCHEDULE_PEER_CHANGE_TEXT } from '@otherbench/core/domain/schedule-peers.js';
import type { ScheduleView } from '@otherbench/core/ports/store.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { api, ApiError } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { PeerSchedulesSection } from './schedules/PeerSchedules.js';
import { ScheduleEditor } from './schedules/ScheduleEditor.js';
import { ScheduleHistory } from './schedules/ScheduleHistory.js';
import { filesSuffix, nextRunText, STATUS_LABEL, timeLimitSuffix } from './schedules/rowText.js';

/** How often the open overlay re-reads the list, on top of every schedule event. */
export const SCHEDULES_POLL_MS = 30_000;

interface SchedulesViewProps {
  /** Opens the editor for a new schedule on this chat or project straight away. */
  prefill?: ScheduleTarget;
  onClose(): void;
}

/**
 * The Scheduled overlay (spec 2026-10-12-scheduled-tasks-design §5): every
 * schedule on this machine, with Run now, Pause/Resume, Edit, History and
 * Delete. Re-reads the list on open, on every schedule event and every 30 s.
 * Below them, each paired machine's schedules, read-only (`PeerSchedulesSection`).
 */
export function SchedulesView({ prefill, onClose }: SchedulesViewProps): JSX.Element {
  const version = useOtherBenchStore((s) => s.schedulesVersion);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const connections = useOtherBenchStore((s) => s.connections);
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState<{ schedule?: ScheduleView; prefill?: ScheduleTarget } | null>(prefill ? { prefill } : null);
  const [deleting, setDeleting] = useState<ScheduleView | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});

  const reload = useCallback(() => {
    api.schedules
      .list()
      .then((list) => {
        setSchedules(list);
        setFailed(false);
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        console.error('[otherbench-web] failed to load schedules:', err);
        setFailed(true);
      });
  }, []);

  useEffect(() => reload(), [reload, version]);
  useEffect(() => {
    const timer = setInterval(reload, SCHEDULES_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !e.defaultPrevented && editing === null && deleting === null) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, deleting, onClose]);

  const profileName = (id: string): string => profiles.find((p) => p.id === id)?.name ?? 'Unknown profile';
  // As the run decides it: the schedule's Auto counts only on a Claude Code profile.
  const runsInAuto = (s: ScheduleView): boolean => {
    const connectionId = profiles.find((p) => p.id === s.profileId)?.connectionId;
    return s.autoMode && connections.find((c) => c.id === connectionId)?.kind === 'claude_code';
  };
  const clearRunError = (id: string): void =>
    setRunErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  function open(chatId: string): void {
    setActiveChatId(chatId);
    onClose();
  }

  async function runNow(s: ScheduleView): Promise<void> {
    try {
      await api.schedules.run(s.id);
      clearRunError(s.id);
      reload();
    } catch (err) {
      setRunErrors((prev) => ({ ...prev, [s.id]: err instanceof ApiError || err instanceof Error ? err.message : String(err) }));
    }
  }

  async function stop(s: ScheduleView): Promise<void> {
    // The active run, not the last: a slot it overran is recorded after it.
    const messageId = s.activeRun?.messageId;
    if (!messageId) return;
    await api.turns.cancel(messageId).catch((err: unknown) => console.error('[otherbench-web] failed to stop a scheduled run:', err));
  }

  async function togglePaused(s: ScheduleView): Promise<void> {
    try {
      await api.schedules.patch(s.id, { enabled: !s.enabled });
      clearRunError(s.id);
      reload();
    } catch (err) {
      setRunErrors((prev) => ({ ...prev, [s.id]: err instanceof Error ? err.message : String(err) }));
    }
  }

  return (
    <div data-testid="schedules-view" className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <h2 className="label-caps text-base">Scheduled</h2>
        <div className="flex gap-2">
          <button type="button" onClick={() => setEditing({})} className="btn px-2.5 py-1 text-xs">
            New schedule
          </button>
          <button type="button" aria-label="Close schedules" onClick={onClose} className="rounded border border-[var(--border)] px-2 py-1 text-xs">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl text-sm">
          {failed ? (
            <p className="text-[var(--danger)]">Couldn&rsquo;t load schedules.</p>
          ) : !schedules ? (
            <p className="text-[var(--text-faint)]">Loading…</p>
          ) : schedules.length === 0 ? (
            <p className="text-[var(--text-muted)]">
              No schedules yet. A schedule runs a prompt on a profile every day, on chosen weekdays or monthly, with nobody there. Make one here, or with
              Schedule… in a chat&rsquo;s or a project&rsquo;s menu.
            </p>
          ) : (
            <ul className="space-y-3">
              {schedules.map((s) => (
                <li key={s.id} data-testid={`schedule-row-${s.id}`} className="rounded border border-[var(--border)] p-3">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{s.name}</span>
                    {!s.enabled && <span className="label-caps text-[var(--text-muted)]">Paused</span>}
                  </div>
                  {s.invalid && (
                    <p className="text-[var(--danger)]">This schedule&rsquo;s rule couldn&rsquo;t be read ({s.invalid}). Edit it to set a new one.</p>
                  )}
                  <p>{s.describe}</p>
                  <p className="text-[var(--text-muted)]">
                    {s.target.kind === 'chat' ? `Chat: ${s.targetName}` : `New chat each run in ${s.targetName}`} · {profileName(s.profileId)}
                    {runsInAuto(s) && ' · Auto mode'}
                    {timeLimitSuffix(s.timeLimitMinutes)}
                    {filesSuffix(s.attachments.length)}
                  </p>
                  <p data-testid="schedule-next">Next run: {nextRunText(s, now)}</p>
                  {s.lastRun && (
                    <p data-testid="schedule-last" className="flex flex-wrap items-center gap-x-2">
                      <span>
                        Last run: {STATUS_LABEL[s.lastRun.status]}, {formatRelativeTime(s.lastRun.startedAt, now)}
                      </span>
                      {s.lastRun.chatId && (
                        <button type="button" onClick={() => open(s.lastRun!.chatId!)} className="btn px-1.5 py-0.5 text-xs">
                          Open
                        </button>
                      )}
                    </p>
                  )}
                  {s.changedFrom && (
                    <p data-testid="schedule-changed-from" className="text-[var(--text-muted)]">
                      {SCHEDULE_PEER_CHANGE_TEXT[s.changedFrom.action]} from {s.changedFrom.machine}, {formatRelativeTime(s.changedFrom.at, now)}
                    </p>
                  )}
                  {runErrors[s.id] && (
                    <p role="alert" className="text-[var(--danger)]">
                      {runErrors[s.id]}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.running && s.activeRun ? (
                      <button type="button" onClick={() => void stop(s)} className="btn px-2 py-1 text-xs">
                        Stop
                      </button>
                    ) : (
                      <button type="button" onClick={() => void runNow(s)} className="btn px-2 py-1 text-xs">
                        Run now
                      </button>
                    )}
                    <button type="button" onClick={() => void togglePaused(s)} className="btn px-2 py-1 text-xs">
                      {s.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button type="button" onClick={() => setEditing({ schedule: s })} className="btn px-2 py-1 text-xs">
                      Edit
                    </button>
                    <button type="button" aria-expanded={historyFor === s.id} onClick={() => setHistoryFor(historyFor === s.id ? null : s.id)} className="btn px-2 py-1 text-xs">
                      History
                    </button>
                    <button type="button" onClick={() => setDeleting(s)} className="btn btn-danger px-2 py-1 text-xs">
                      Delete…
                    </button>
                  </div>
                  {historyFor === s.id && <ScheduleHistory schedule={s} load={api.schedules.runs} refreshKey={`${version}:${now}`} onOpen={open} />}
                </li>
              ))}
            </ul>
          )}
          <PeerSchedulesSection now={now} onOpen={open} />
        </div>
      </div>

      {editing && (
        <ScheduleEditor
          {...(editing.schedule ? { schedule: editing.schedule } : {})}
          {...(editing.prefill ? { prefill: editing.prefill } : {})}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete schedule '${deleting.name}'?`}
          message="Its history goes too. Chats it made are kept."
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.schedules.delete(deleting.id);
            setDeleting(null);
            reload();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
