import { useEffect, useState, type JSX } from 'react';
import type { PeerScheduleRow, PeerSchedules } from '@otherbench/core/types/peer.js';
import { formatRelativeTime } from '../../lib/relativeTime.js';
import { api } from '../../state/api.js';
import { useOtherBenchStore } from '../../state/store.js';
import { nextRunText, STATUS_LABEL, timeLimitSuffix } from './rowText.js';

function targetText(s: PeerScheduleRow): string {
  if (s.target.kind === 'chat') return `Chat: ${s.targetName ?? 'a chat not on this machine yet'}`;
  return `New chat each run in ${s.targetName ?? 'a project not on this machine yet'}`;
}

function PeerScheduleItem({ s, machine, now, onOpen }: { s: PeerScheduleRow; machine: string; now: number; onOpen(chatId: string): void }): JSX.Element {
  return (
    <li data-testid={`peer-schedule-row-${s.id}`} className="rounded border border-[var(--border)] p-3">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{s.name}</span>
        {!s.enabled && <span className="label-caps text-[var(--text-muted)]">Paused</span>}
        {s.running && <span className="label-caps text-[var(--text-muted)]">Running</span>}
      </div>
      {s.invalid && <p className="text-[var(--danger)]">This schedule&rsquo;s rule couldn&rsquo;t be read on {machine}. Edit it there to set a new one.</p>}
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
    </li>
  );
}

function MachineSchedules({ machine, now, onOpen }: { machine: PeerSchedules; now: number; onOpen(chatId: string): void }): JSX.Element {
  const { name } = machine;
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
        <p className="text-[var(--text-muted)]">
          These run on {name} and can only be changed there. To run, edit, pause or delete one, do it in OtherBench on {name}.
        </p>
        <ul className="mt-2 space-y-3">
          {machine.schedules.map((s) => (
            <PeerScheduleItem key={s.id} s={s} machine={name} now={now} onOpen={onOpen} />
          ))}
        </ul>
      </>
    );
  }
  return (
    <section data-testid={`peer-schedules-${machine.nodeId}`} className="mt-6">
      <h3 className="label-caps mb-2">
        On {name} · runs there
      </h3>
      {body}
    </section>
  );
}

/**
 * The Schedules overlay's read-only section for each paired machine: the schedules it holds, as it last said on its
 * peer stream (`GET /api/peers/schedules`). They run there and can only be changed there, so these rows have no
 * buttons but Open, which opens the run's chat here when it has synced. Re-read whenever a machine says its
 * schedules changed, becomes reachable or unreachable, or sync brings rows they are named from. Nothing when no
 * machine is paired.
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
