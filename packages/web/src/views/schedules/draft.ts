import { parseCron } from '@otherbench/core/domain/cron.js';
import {
  DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES,
  SCHEDULE_NAME_MAX,
  SCHEDULE_PROMPT_MAX,
  SCHEDULE_TIME_LIMIT_CHOICES,
  formatInZone,
  nextRuns,
  parseRule,
  timeLimitText,
  type ScheduleRule,
  type ScheduleTarget,
} from '@otherbench/core/domain/schedule.js';
import type { Chat, Project, Schedule } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import type { CreateScheduleBody, PatchScheduleBody } from '../../state/api.js';

/**
 * The schedule editor's form state (spec 2026-10-12-scheduled-tasks-design §5)
 * and the API bodies it turns into. Pure: the editor holds a draft and only
 * Save sends anything. Every field of every cadence is kept, so switching
 * Repeats back and forth loses nothing.
 */
export interface ScheduleDraft {
  name: string;
  prompt: string;
  /** '' until one is chosen. */
  profileId: string;
  cadence: ScheduleRule['cadence'];
  /** HH:MM, from `<input type="time">`. */
  time: string;
  /** 0-6, 0 = Sunday. */
  weekdays: number[];
  /** As typed. */
  monthDay: string;
  /** Every how many hours, as typed. */
  everyHours: string;
  /** The days an every-N-hours schedule runs on, 0 = Sunday; all seven means every day. Kept apart from the weekly days, whose default differs. */
  hourlyWeekdays: number[];
  /** The cron rule, as typed. */
  cron: string;
  targetKind: 'chat' | 'project';
  chatId: string;
  projectId: string;
  /** Runs use Claude Code's auto mode (`Schedule.autoMode`); offered only for a Claude Code profile. */
  autoMode: boolean;
  /** How long a run may go, in minutes (`Schedule.timeLimitMinutes`); null for no limit. */
  timeLimitMinutes: number | null;
}

/** The day checkboxes, Monday first. */
export const WEEKDAYS_MONDAY_FIRST: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' },
];

/** The Repeats choices, in the order the editor lists them. */
export const CADENCE_OPTIONS: { value: ScheduleRule['cadence']; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'hourly', label: 'Every few hours' },
  { value: 'cron', label: 'Cron rule' },
];

/** The Time limit choice that means no limit; every other value is minutes. */
export const NO_TIME_LIMIT = 'none';

/**
 * The Time limit choices: the usual ones and "No limit", plus the schedule's
 * own limit when it is none of those (one set through the API), so opening
 * the editor never changes it.
 */
export function timeLimitOptions(current: number | null): { value: string; label: string }[] {
  const minutes = current === null || SCHEDULE_TIME_LIMIT_CHOICES.includes(current) ? [...SCHEDULE_TIME_LIMIT_CHOICES] : [...SCHEDULE_TIME_LIMIT_CHOICES, current].sort((a, b) => a - b);
  return [...minutes.map((m) => ({ value: String(m), label: timeLimitText(m) })), { value: NO_TIME_LIMIT, label: 'No limit' }];
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_CRON = '0 9 * * 1-5';

export function emptyDraft(prefill: ScheduleTarget | null, profileId: string): ScheduleDraft {
  return {
    name: '',
    prompt: '',
    profileId,
    cadence: 'daily',
    time: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    monthDay: '1',
    everyHours: '3',
    hourlyWeekdays: [...EVERY_DAY],
    cron: DEFAULT_CRON,
    targetKind: prefill?.kind ?? 'chat',
    chatId: prefill?.kind === 'chat' ? prefill.chatId : '',
    projectId: prefill?.kind === 'project' ? prefill.projectId : '',
    autoMode: false,
    timeLimitMinutes: DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES,
  };
}

export function draftFromSchedule(s: Schedule): ScheduleDraft {
  const rule = s.rule;
  return {
    name: s.name,
    prompt: s.prompt,
    profileId: s.profileId,
    cadence: rule.cadence,
    time: rule.cadence === 'cron' ? '09:00' : rule.time,
    weekdays: rule.cadence === 'weekly' ? [...rule.weekdays] : [1, 2, 3, 4, 5],
    monthDay: rule.cadence === 'monthly' ? String(rule.monthDay) : '1',
    everyHours: rule.cadence === 'hourly' ? String(rule.everyHours) : '3',
    hourlyWeekdays: rule.cadence === 'hourly' && rule.weekdays ? [...rule.weekdays] : [...EVERY_DAY],
    cron: rule.cadence === 'cron' ? rule.cron : DEFAULT_CRON,
    targetKind: s.target.kind,
    chatId: s.target.kind === 'chat' ? s.target.chatId : '',
    projectId: s.target.kind === 'project' ? s.target.projectId : '',
    autoMode: s.autoMode,
    timeLimitMinutes: s.timeLimitMinutes,
  };
}

/** The draft's rule, checked by core's `parseRule`, or its message. */
export function draftRule(d: ScheduleDraft): ScheduleRule | string {
  switch (d.cadence) {
    case 'daily':
      return parseRule({ cadence: 'daily', time: d.time });
    case 'weekly':
      return parseRule({ cadence: 'weekly', time: d.time, weekdays: d.weekdays });
    case 'monthly':
      return parseRule({ cadence: 'monthly', time: d.time, monthDay: wholeNumber(d.monthDay) });
    case 'hourly':
      return parseRule({
        cadence: 'hourly',
        time: d.time,
        everyHours: wholeNumber(d.everyHours),
        // Every day is stored as no days at all.
        ...(EVERY_DAY.every((day) => d.hourlyWeekdays.includes(day)) ? {} : { weekdays: d.hourlyWeekdays }),
      });
    case 'cron':
      return parseRule({ cadence: 'cron', cron: d.cron });
  }
}

function wholeNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/** What's wrong with the draft's repeat settings, in the editor's words, or null. */
function ruleProblem(d: ScheduleDraft): string | null {
  if (d.cadence === 'cron') {
    const spec = parseCron(d.cron);
    return typeof spec === 'string' ? spec : null;
  }
  if (!TIME_PATTERN.test(d.time)) return 'Set the time it runs.';
  if (d.cadence === 'weekly' && d.weekdays.length === 0) return 'Pick at least one day.';
  if (d.cadence === 'hourly' && d.hourlyWeekdays.length === 0) return 'Pick at least one day.';
  const rule = draftRule(d);
  if (typeof rule !== 'string') return null;
  if (d.cadence === 'monthly') return 'The day of the month must be a whole number from 1 to 31.';
  if (d.cadence === 'hourly') return 'Run every 1 to 23 hours, in whole hours.';
  return rule;
}

/**
 * The next `count` runs as the editor shows them ("Monday 12 October 2026,
 * 09:00"), in the schedule's zone, or what's wrong with the repeat settings.
 * A typo in a cron rule shows up here as it is typed.
 */
export function previewRuns(d: ScheduleDraft, timezone: string, now: number, count = 3): string[] | string {
  const problem = ruleProblem(d);
  if (problem) return problem;
  const rule = draftRule(d);
  if (typeof rule === 'string') return rule;
  return nextRuns(rule, timezone, now, count).map((t) => formatInZone(t, timezone, 'long'));
}

/** The first thing to fix before saving, or null. The server is the hard gate; this is the early, friendlier check. */
export function draftProblem(d: ScheduleDraft): string | null {
  const name = d.name.trim();
  if (name.length === 0) return 'Give the schedule a name.';
  if (name.length > SCHEDULE_NAME_MAX) return `The name can be at most ${SCHEDULE_NAME_MAX} characters.`;
  if (d.prompt.trim().length === 0) return 'Write the prompt the schedule sends.';
  if (d.prompt.length > SCHEDULE_PROMPT_MAX) return `The prompt can be at most ${SCHEDULE_PROMPT_MAX.toLocaleString('en-US')} characters.`;
  if (d.profileId === '') return 'Choose a profile.';
  if (d.targetKind === 'chat' && d.chatId === '') return 'Choose the chat to add to.';
  if (d.targetKind === 'project' && d.projectId === '') return 'Choose the project to make chats in.';
  return ruleProblem(d);
}

function ruleOrThrow(d: ScheduleDraft): ScheduleRule {
  const rule = draftRule(d);
  if (typeof rule === 'string') throw new Error(rule);
  return rule;
}

/** Call only once `draftProblem` is null. */
export function createBody(d: ScheduleDraft): CreateScheduleBody {
  return {
    name: d.name.trim(),
    prompt: d.prompt,
    profileId: d.profileId,
    target: d.targetKind === 'chat' ? { chatId: d.chatId } : { projectId: d.projectId },
    rule: ruleOrThrow(d),
    autoMode: d.autoMode,
    timeLimitMinutes: d.timeLimitMinutes,
  };
}

/** Only what changed. Call only once `draftProblem` is null. */
export function patchBody(initial: ScheduleDraft, d: ScheduleDraft): PatchScheduleBody {
  const body: PatchScheduleBody = {};
  if (d.name.trim() !== initial.name.trim()) body.name = d.name.trim();
  if (d.prompt !== initial.prompt) body.prompt = d.prompt;
  if (d.profileId !== initial.profileId) body.profileId = d.profileId;
  const rule = ruleOrThrow(d);
  if (JSON.stringify(rule) !== JSON.stringify(draftRule(initial))) body.rule = rule;
  if (d.autoMode !== initial.autoMode) body.autoMode = d.autoMode;
  if (d.timeLimitMinutes !== initial.timeLimitMinutes) body.timeLimitMinutes = d.timeLimitMinutes;
  return body;
}

/** A new schedule's profile: the chat's, else the project's default, else the app default; archived ones are skipped. '' when there's none. */
export function defaultProfileFor(target: ScheduleTarget | null, chats: Chat[], projects: Project[], profiles: Profile[]): string {
  const live = (id: string | null | undefined): string | null => (id && profiles.some((p) => p.id === id && p.archivedAt === null) ? id : null);
  const fromTarget =
    target?.kind === 'chat'
      ? live(chats.find((c) => c.id === target.chatId)?.profileId)
      : target?.kind === 'project'
        ? live(projects.find((p) => p.id === target.projectId)?.defaultProfileId)
        : null;
  if (fromTarget) return fromTarget;
  const unarchived = profiles.filter((p) => p.archivedAt === null);
  return (unarchived.find((p) => p.isDefault) ?? unarchived[0])?.id ?? '';
}

/** Whether the draft's chat or project has a folder, for `unattendedWarnings`. */
export function targetHasFolder(d: Pick<ScheduleDraft, 'targetKind' | 'chatId' | 'projectId'>, chats: Chat[], projects: Project[]): boolean {
  const workspace = d.targetKind === 'chat' ? chats.find((c) => c.id === d.chatId)?.workspace : projects.find((p) => p.id === d.projectId)?.workspace;
  return (workspace ?? null) !== null;
}

/** The zone a new schedule will be made in. The server sets the real one; in phase 1 it runs on this machine, so they match. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
