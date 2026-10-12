import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { SCHEDULE_NAME_MAX, SCHEDULE_PROMPT_MAX, unattendedWarnings, type ScheduleTarget } from '@grunt/core/domain/schedule.js';
import type { ScheduleView } from '@grunt/core/ports/store.js';
import { api } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';
import {
  WEEKDAYS_MONDAY_FIRST,
  browserTimeZone,
  createBody,
  defaultProfileFor,
  draftFromSchedule,
  draftProblem,
  emptyDraft,
  patchBody,
  targetHasFolder,
  type ScheduleDraft,
} from './draft.js';

interface ScheduleEditorProps {
  /** Editing this schedule; absent makes a new one. */
  schedule?: ScheduleView;
  /** A new schedule's fixed target, when opened from a chat's or a project's menu. */
  prefill?: ScheduleTarget;
  onSaved(view: ScheduleView): void;
  onCancel(): void;
}

const FIELD = 'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1';

/** New or Edit schedule (spec 2026-10-12-scheduled-tasks-design §5). Esc or Cancel closes it unsaved. */
export function ScheduleEditor({ schedule, prefill, onSaved, onCancel }: ScheduleEditorProps): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const projects = useGruntStore((s) => s.projects);
  const profiles = useGruntStore((s) => s.profiles);
  const connections = useGruntStore((s) => s.connections);
  const [initial] = useState<ScheduleDraft>(() =>
    schedule ? draftFromSchedule(schedule) : emptyDraft(prefill ?? null, defaultProfileFor(prefill ?? null, chats, projects, profiles))
  );
  const [draft, setDraft] = useState<ScheduleDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]): void => setDraft((d) => ({ ...d, [key]: value }));
  const timezone = schedule?.timezone ?? browserTimeZone();
  // The target is immutable once made (patchBody ignores it), so it is read-only when editing or opened with a prefill.
  const targetFixed = schedule !== undefined || prefill !== undefined;
  const profile = profiles.find((p) => p.id === draft.profileId);
  const connection = profile ? connections.find((c) => c.id === profile.connectionId) : undefined;
  const warnings = profile && connection ? unattendedWarnings(profile.toolPolicy, connection.kind, targetHasFolder(draft, chats, projects)) : [];
  const profileChoices = profiles.filter((p) => p.archivedAt === null || p.id === draft.profileId);
  const chatChoices = chats.filter((c) => c.archivedAt === null).sort((a, b) => b.createdAt - a.createdAt);
  const targetText =
    draft.targetKind === 'chat'
      ? `Chat: ${chats.find((c) => c.id === draft.chatId)?.title ?? schedule?.targetName ?? ''}`
      : `New chat each run in ${projects.find((p) => p.id === draft.projectId)?.name ?? schedule?.targetName ?? ''}`;

  async function save(): Promise<void> {
    const problem = draftProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(schedule ? await api.schedules.patch(schedule.id, patchBody(initial, draft)) : await api.schedules.create(createBody(draft)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (!saving) onCancel();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onKeyDown={onKeyDown}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="max-h-[90vh] w-[32rem] max-w-[95vw] space-y-3 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-raised)] p-4 text-sm shadow-lg"
      >
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {schedule ? 'Edit schedule' : 'New schedule'}
        </h2>

        <div>
          <label htmlFor={`${id}-name`} className="block font-medium">
            Name
          </label>
          <input id={`${id}-name`} ref={nameRef} value={draft.name} maxLength={SCHEDULE_NAME_MAX} onChange={(e) => set('name', e.target.value)} className={FIELD} />
        </div>

        <div>
          <label htmlFor={`${id}-profile`} className="block font-medium">
            Profile
          </label>
          <select id={`${id}-profile`} value={draft.profileId} onChange={(e) => set('profileId', e.target.value)} className={FIELD}>
            <option value="">Choose a profile…</option>
            {profileChoices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {warnings.length > 0 && (
            <div data-testid="schedule-warnings" className="mt-1 text-[var(--warn)]">
              <p>Nobody approves anything during a scheduled run:</p>
              <ul className="list-disc pl-5">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div>
          <label htmlFor={`${id}-prompt`} className="block font-medium">
            Prompt
          </label>
          <textarea id={`${id}-prompt`} rows={6} value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} className={FIELD} />
          <p className="text-right text-xs text-[var(--text-muted)]">
            {draft.prompt.length.toLocaleString('en-US')} / {SCHEDULE_PROMPT_MAX.toLocaleString('en-US')}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={`${id}-cadence`} className="block font-medium">
              Repeats
            </label>
            <select id={`${id}-cadence`} value={draft.cadence} onChange={(e) => set('cadence', e.target.value as ScheduleDraft['cadence'])} className={FIELD}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-time`} className="block font-medium">
              Time
            </label>
            <div className="flex items-center gap-1">
              <input id={`${id}-time`} type="time" value={draft.time} onChange={(e) => set('time', e.target.value)} className={FIELD} />
              <span className="text-[var(--text-muted)]">({timezone})</span>
            </div>
          </div>
        </div>

        {draft.cadence === 'weekly' && (
          <fieldset className="flex flex-wrap gap-3">
            <legend className="sr-only">Days</legend>
            {WEEKDAYS_MONDAY_FIRST.map(({ day, label }) => (
              <label key={day} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={draft.weekdays.includes(day)}
                  onChange={(e) => set('weekdays', e.target.checked ? [...draft.weekdays, day] : draft.weekdays.filter((d) => d !== day))}
                />
                {label}
              </label>
            ))}
          </fieldset>
        )}

        {draft.cadence === 'monthly' && (
          <div>
            <label htmlFor={`${id}-day`} className="block font-medium">
              Day of month
            </label>
            <input id={`${id}-day`} type="number" min={1} max={31} value={draft.monthDay} onChange={(e) => set('monthDay', e.target.value)} className={`${FIELD} w-24`} />
            <p className="text-xs text-[var(--text-muted)]">In shorter months, runs on the last day.</p>
          </div>
        )}

        {targetFixed ? (
          <p data-testid="schedule-target">{targetText}</p>
        ) : (
          <fieldset className="space-y-1">
            <legend className="font-medium">Where the reply goes</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name={`${id}-target`} checked={draft.targetKind === 'chat'} onChange={() => set('targetKind', 'chat')} />
              Add to a chat
            </label>
            {draft.targetKind === 'chat' && (
              <select aria-label="Chat" value={draft.chatId} onChange={(e) => set('chatId', e.target.value)} className={FIELD}>
                <option value="">Choose a chat…</option>
                {chatChoices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-2">
              <input type="radio" name={`${id}-target`} checked={draft.targetKind === 'project'} onChange={() => set('targetKind', 'project')} />
              New chat each run in a project
            </label>
            {draft.targetKind === 'project' && (
              <select aria-label="Project" value={draft.projectId} onChange={(e) => set('projectId', e.target.value)} className={FIELD}>
                <option value="">Choose a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
        )}

        {error && (
          <p role="alert" className="text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className="btn px-2.5 py-1">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={saving} className="btn px-2.5 py-1">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
