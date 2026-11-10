import { useEffect, useState, type JSX } from 'react';
import type { ScheduleView } from '@otherbench/core/ports/store.js';
import type { PeerScheduleRow, PeerSchedules } from '@otherbench/core/types/peer.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { formatRelativeTime } from '../../lib/relativeTime.js';
import { api } from '../../state/api.js';
import { useOtherBenchStore } from '../../state/store.js';
import { nextRunText, STATUS_LABEL, timeLimitSuffix } from './rowText.js';
import { ScheduleEditor, type ScheduleMachine } from './ScheduleEditor.js';
import { ScheduleHistory } from './ScheduleHistory.js';

function targetText(s: PeerScheduleRow): string {
  if (s.target.kind === 'chat') return `Chat: ${s.targetName ?? 'a chat not on this machine yet'}`;
  return `New chat each run in ${s.targetName ?? 'a project not on this machine yet'}`;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface ItemProps {
  s: PeerScheduleRow;
  machine: PeerSchedules;
  now: number;
  /** The run history is open under this row. */
  history: boolean;
  onHistory(): void;
  onOpen(chatId: string): void;
  /** Present only while the machine lets this one manage its schedules. */
  manage?: { onRun(): void; onTogglePaused(): void; onEdit(): void; onDelete(): void; error: string | undefined };
}

function PeerScheduleItem({ s, machine, now, history, onHistory, onOpen, manage }: ItemProps): JSX.Element {
  const chats = useOtherBenchStore((st) => st.chats);
  const { name } = machine;
  return (
    <li data-testid={`peer-schedule-row-${s.id}`} className="rounded border border-[var(--border)] p-3">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{s.name}</span>
        {!s.enabled && <span className="label-caps text-[var(--text-muted)]">Paused</span>}
        {s.running && <span className="label-caps text-[var(--text-muted)]">Running</span>}
      </div>
      {s.invalid && (
        <p className="text-[var(--danger)]">
          This schedule&rsquo;s rule couldn&rsquo;t be read on {name}. Edit it {manage ? 'to set a new one' : 'there to set a new one'}.
        </p>
      )}
      <p>{s.describe}</p>
      <p className="text-[var(--text-muted)]">
        {targetText(s)} · {s.profileName ?? 'a profile not on this machine yet'}
        {s.autoMode && ' · Auto mode'}
        {timeLimitSuffix(s.timeLimitMinutes)}
      </p>
      <p data-testid="schedule-next">Next run: {nextRunText(s, now)}</p>
      {s.lastRun && (
        <p data-testid="schedule-last" className="flex flex-wrap items-center gap-x-2">
          <span>
            Last run: {STATUS_LABEL[s.lastRun.status]}, {formatRelativeTime(s.lastRun.startedAt, now)}
          </span>
          {s.lastRun.chatId && (
            <button type="button" onClick={() => onOpen(s.lastRun!.chatId!)} className="btn px-1.5 py-0.5 text-xs">
              Open
            </button>
          )}
        </p>
      )}
      {manage?.error && (
        <p role="alert" className="text-[var(--danger)]">
          {manage.error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {manage && (
          <>
            {/* A run going there is stopped from its chat, which shows here live. */}
            <button type="button" onClick={manage.onRun} disabled={s.running} className="btn px-2 py-1 text-xs">
              Run now
            </button>
            <button type="button" onClick={manage.onTogglePaused} className="btn px-2 py-1 text-xs">
              {s.enabled ? 'Pause' : 'Resume'}
            </button>
            <button type="button" onClick={manage.onEdit} className="btn px-2 py-1 text-xs">
              Edit
            </button>
          </>
        )}
        <button type="button" aria-expanded={history} onClick={onHistory} className="btn px-2 py-1 text-xs">
          History
        </button>
        {manage && (
          <button type="button" onClick={manage.onDelete} className="btn btn-danger px-2 py-1 text-xs">
            Delete…
          </button>
        )}
      </div>
      {history && (
        <ScheduleHistory
          schedule={s}
          load={(id) => api.peers.machineSchedules.runs(machine.nodeId, id)}
          refreshKey={`${s.lastRun?.startedAt ?? 0}:${s.lastRun?.status ?? ''}:${now}`}
          onOpen={onOpen}
          // A run's chat opens once it has synced here.
          canOpen={(chatId) => chats.some((c) => c.id === chatId)}
        />
      )}
    </li>
  );
}

function MachineSchedules({ machine, now, onOpen }: { machine: PeerSchedules; now: number; onOpen(chatId: string): void }): JSX.Element {
  const { name } = machine;
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ schedule?: ScheduleView } | null>(null);
  const [deleting, setDeleting] = useState<PeerScheduleRow | null>(null);
  const there = api.peers.machineSchedules;
  const editorMachine: ScheduleMachine = { nodeId: machine.nodeId, name, timezone: machine.timezone };
  // The machine re-announces its list after every change, which re-reads this section: nothing to reload here.
  const attempt = (id: string, work: () => Promise<unknown>): void => {
    work().then(
      () =>
        setErrors((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        }),
      (err: unknown) => setErrors((prev) => ({ ...prev, [id]: messageOf(err) }))
    );
  };
  const edit = (s: PeerScheduleRow): void =>
    // The prompt only crosses for this: read from that machine when Edit is pressed.
    attempt(s.id, async () => {
      const full = (await there.list(machine.nodeId)).find((v) => v.id === s.id);
      if (!full) throw new Error(`That schedule is no longer on ${name}.`);
      setEditing({ schedule: full });
    });

  let body: JSX.Element;
  if (machine.status === 'unreachable') {
    body = (
      <p data-testid="peer-schedules-unreachable" className="text-[var(--text-muted)]">
        {name} isn&rsquo;t reachable, so its schedules can&rsquo;t be shown. They still run there.
      </p>
    );
  } else if (machine.status !== 'reachable') {
    body = <p className="text-[var(--text-faint)]">Checking {name}…</p>;
  } else if (!machine.shared) {
    body = <p className="text-[var(--text-muted)]">{name} doesn&rsquo;t share its schedules. Update OtherBench there to see them here.</p>;
  } else if (machine.schedules.length === 0) {
    body = <p className="text-[var(--text-muted)]">{name} has no schedules.</p>;
  } else {
    body = (
      <>
        <p data-testid="peer-schedules-note" className="text-[var(--text-muted)]">
          {machine.manage
            ? `These run on ${name}, which lets this machine run, pause, edit and delete them. ${name} records each change made from here.`
            : `These run on ${name} and can only be changed there. To run, edit, pause or delete one, do it in OtherBench on ${name}.`}
        </p>
        <ul className="mt-2 space-y-3">
          {machine.schedules.map((s) => (
            <PeerScheduleItem
              key={s.id}
              s={s}
              machine={machine}
              now={now}
              history={historyFor === s.id}
              onHistory={() => setHistoryFor(historyFor === s.id ? null : s.id)}
              onOpen={onOpen}
              {...(machine.manage
                ? {
                    manage: {
                      onRun: () => attempt(s.id, () => there.run(machine.nodeId, s.id)),
                      onTogglePaused: () => attempt(s.id, () => there.patch(machine.nodeId, s.id, { enabled: !s.enabled })),
                      onEdit: () => edit(s),
                      onDelete: () => setDeleting(s),
                      error: errors[s.id],
                    },
                  }
                : {})}
            />
          ))}
        </ul>
      </>
    );
  }
  return (
    <section data-testid={`peer-schedules-${machine.nodeId}`} className="mt-6">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="label-caps">On {name} · runs there</h3>
        {machine.status === 'reachable' && machine.manage && (
          <button type="button" onClick={() => setEditing({})} className="btn px-2 py-1 text-xs">
            New schedule on {name}
          </button>
        )}
      </div>
      {body}
      {editing && (
        <ScheduleEditor {...(editing.schedule ? { schedule: editing.schedule } : {})} machine={editorMachine} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete schedule '${deleting.name}' on ${name}?`}
          message={`Its history on ${name} goes too. Chats it made are kept.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await there.delete(machine.nodeId, deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

/**
 * The Schedules overlay's section for each paired machine: the schedules it holds, as it last said on its peer stream
 * (`GET /api/peers/schedules`). Every row has History, read from that machine. Run now, Pause/Resume, Edit, Delete
 * and New schedule show only while that machine says it lets this one manage its schedules (`manage`), and go to it
 * (`api.peers.machineSchedules`), which checks its own setting on every call; otherwise the rows say they can only
 * be changed there. Re-read whenever a machine says its schedules changed, becomes reachable or unreachable, or sync
 * brings rows they are named from. Nothing when no machine is paired.
 */
export function PeerSchedulesSection({ now, onOpen }: { now: number; onOpen(chatId: string): void }): JSX.Element | null {
  const version = useOtherBenchStore((s) => s.peerSchedulesVersion);
  const syncRevision = useOtherBenchStore((s) => s.syncRevision);
  const [machines, setMachines] = useState<PeerSchedules[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.peers
      .schedules()
      .then((list) => {
        if (!cancelled) setMachines(list);
      })
      .catch((err: unknown) => {
        // No pairing on this server, or it couldn't answer: show no machines rather than a stale list.
        console.error("[otherbench-web] failed to load paired machines' schedules:", err);
        if (!cancelled) setMachines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [version, syncRevision, now]);

  if (machines.length === 0) return null;
  return (
    <div data-testid="peer-schedules">
      {machines.map((m) => (
        <MachineSchedules key={m.nodeId} machine={m} now={now} onOpen={onOpen} />
      ))}
    </div>
  );
}
