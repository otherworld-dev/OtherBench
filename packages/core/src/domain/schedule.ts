/**
 * Scheduled tasks (spec 2026-10-12-scheduled-tasks-design §1): the rules,
 * limits, time-zone arithmetic and texts a schedule needs. Pure, with no Node
 * imports, so the web UI uses it too. Every date and time a schedule shows is
 * in its own IANA zone. Month and weekday names are this file's own English,
 * fed by Intl's numeric parts, so no text here moves with the ICU version.
 */
import { runsShellInSandbox, type ConnectionKind, type ToolPolicy } from '../types/config.js';
import { cronMatchesDate, cronMinutesOfDay, normaliseCron, parseCron } from './cron.js';

export const SCHEDULE_NAME_MAX = 80;
export const SCHEDULE_PROMPT_MAX = 20_000;
export const MAX_SCHEDULES = 100;
export const SCHEDULE_RUNS_KEPT = 50;
export const MAX_CONCURRENT_SCHEDULED_RUNS = 2;
export const SCHEDULE_LATE_AFTER_MS = 5 * 60_000;
export const SCHEDULE_CHECK_MAX_MS = 30_000;
/** The most files a schedule sends with its prompt (`ScheduleAttachment`); each is up to 25MB, as a chat attachment is. */
export const MAX_SCHEDULE_ATTACHMENTS = 10;

/**
 * A run's time limit (`Schedule.timeLimitMinutes`) when none is chosen, and
 * every schedule's from before the limit could be set (migration 038): the
 * fixed limit all runs had until then. Long enough for a report or a triage
 * run, Claude Code's included; short enough that a run stuck in auto mode
 * doesn't spend all night, and one of the two run slots with it.
 */
export const DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES = 30;
/** The longest limit short of none at all: a day. */
export const MAX_SCHEDULE_TIME_LIMIT_MINUTES = 24 * 60;
/** The editor's choices, in minutes; it also offers "No limit" (null). */
export const SCHEDULE_TIME_LIMIT_CHOICES: readonly number[] = [10, 30, 60, 120, 240, 480];

/** The limit in minutes, null for none, or a message saying what's wrong. */
export function parseTimeLimit(value: unknown): number | null | string {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_SCHEDULE_TIME_LIMIT_MINUTES) {
    return `"timeLimitMinutes" must be a whole number of minutes from 1 to ${MAX_SCHEDULE_TIME_LIMIT_MINUTES}, or null for no limit.`;
  }
  return value;
}

/** "45 minutes", "1 hour", "1 hour 30 minutes", "8 hours". */
export function timeLimitText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours === 1 ? '1 hour' : `${hours} hours`;
  const m = rest === 1 ? '1 minute' : `${rest} minutes`;
  if (hours === 0) return m;
  return rest === 0 ? h : `${h} ${m}`;
}

/** What a run stopped at its limit records as its detail, and its chat shows. */
export function timedOutText(minutes: number): string {
  return `Stopped at the schedule's time limit of ${timeLimitText(minutes)}.`;
}

/**
 * `time` is `HH:MM`, 00:00-23:59. `weekdays` are 0-6 with 0 = Sunday (as
 * `getUTCDay`), sorted, no repeats. `monthDay` 1-31; past the month's end
 * means its last day. `hourly` runs at `time` and every `everyHours` (1-23)
 * after it until midnight, starting again from `time` each day, on every day
 * or only on `weekdays`. `cron` is a five-field rule (`cron.ts`), stored
 * normalised.
 */
export type ScheduleRule =
  | { cadence: 'daily'; time: string }
  | { cadence: 'weekly'; time: string; weekdays: number[] }
  | { cadence: 'monthly'; time: string; monthDay: number }
  | { cadence: 'hourly'; time: string; everyHours: number; weekdays?: number[] }
  | { cadence: 'cron'; cron: string };

/** Where a run's reply goes. Fixed once the schedule is made. */
export type ScheduleTarget = { kind: 'chat'; chatId: string } | { kind: 'project'; projectId: string };

export type ScheduleRunStatus = 'running' | 'complete' | 'error' | 'cancelled' | 'timed_out' | 'not_started';

/** `scheduled` within 5 minutes of due, `late` after that, `manual` for Run now. */
export type ScheduleTrigger = 'scheduled' | 'late' | 'manual';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const WEEKDAYS_PROBLEM = '"rule.weekdays" must be a non-empty list of days, 0 (Sunday) to 6 (Saturday).';

/** Sorted with no repeats, or null when it isn't a non-empty list of 0-6. */
function parseWeekdays(days: unknown): number[] | null {
  if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return [...new Set(days as number[])].sort((a, b) => a - b);
}

/** The rule, or a message naming the field that's wrong. Weekdays come back sorted with no repeats, a cron rule normalised. */
export function parseRule(value: unknown): ScheduleRule | string {
  if (!isRecord(value)) return '"rule" must be an object.';
  if (value['cadence'] === 'cron') {
    const text = value['cron'];
    if (typeof text !== 'string') return '"rule.cron" must be a cron rule, such as "0 9 * * 1-5".';
    const spec = parseCron(text);
    return typeof spec === 'string' ? `"rule.cron": ${spec}` : { cadence: 'cron', cron: normaliseCron(text) };
  }
  const time = value['time'];
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return '"rule.time" must be HH:MM, from 00:00 to 23:59.';
  switch (value['cadence']) {
    case 'daily':
      return { cadence: 'daily', time };
    case 'weekly': {
      const weekdays = parseWeekdays(value['weekdays']);
      return weekdays ? { cadence: 'weekly', time, weekdays } : WEEKDAYS_PROBLEM;
    }
    case 'monthly': {
      const day = value['monthDay'];
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) return '"rule.monthDay" must be a whole number from 1 to 31.';
      return { cadence: 'monthly', time, monthDay: day };
    }
    case 'hourly': {
      const every = value['everyHours'];
      if (typeof every !== 'number' || !Number.isInteger(every) || every < 1 || every > 23) return '"rule.everyHours" must be a whole number from 1 to 23.';
      if (value['weekdays'] === undefined) return { cadence: 'hourly', time, everyHours: every };
      const weekdays = parseWeekdays(value['weekdays']);
      return weekdays ? { cadence: 'hourly', time, everyHours: every, weekdays } : WEEKDAYS_PROBLEM;
    }
    default:
      return '"rule.cadence" must be "daily", "weekly", "monthly", "hourly" or "cron".';
  }
}

/** A calendar date with no zone; month 1-12. */
export interface WallDate {
  year: number;
  month: number;
  day: number;
}

interface WallClock extends WallDate {
  hour: number;
  minute: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** One cached numeric formatter per zone; `hourCycle: 'h23'` so midnight is 00, never 24. Throws a RangeError for an unknown zone. */
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Whether `timezone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timezone: string): boolean {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

/** What the API answers for a zone `canonicalTimeZone` refuses. */
export const TIME_ZONE_PROBLEM = '"timezone" must be an IANA time zone, such as "Europe/London".';
const TIME_ZONE_NAME_MAX = 64;

/**
 * A schedule's zone as given to the API: an IANA name this runtime knows, in
 * its canonical spelling (`america/new_york` is `America/New_York`, `GMT` is
 * `UTC`), or null. An offset such as `+05:00`, which Intl also takes, is
 * refused: a schedule's zone is a place, whose clock changes it follows.
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > TIME_ZONE_NAME_MAX || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value) || !isValidTimeZone(value)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
}

function wallClockWithSeconds(instant: number, timezone: string): WallClock & { second: number } {
  const out: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { year: out['year']!, month: out['month']!, day: out['day']!, hour: out['hour']!, minute: out['minute']!, second: out['second']! };
}

/** The wall clock in `timezone` at `instant`. */
function wallClock(instant: number, timezone: string): WallClock {
  const { year, month, day, hour, minute } = wallClockWithSeconds(instant, timezone);
  return { year, month, day, hour, minute };
}

/** How far `timezone`'s wall clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timezone: string): number {
  const w = wallClockWithSeconds(instant, timezone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':');
  return { hour: Number(h), minute: Number(m) };
}

/**
 * The instant the wall clock in `timezone` reads `time` on `date`, with
 * JavaScript's "compatible" disambiguation: a time that happens twice (clocks
 * go back) is the earlier instant; a time that doesn't exist (clocks go
 * forward) is shifted forward by the gap, so 01:30 in London's spring gap is
 * 02:30 BST. Candidates come from the zone's offsets a day before and a day
 * after; only those whose wall clock really is the time asked for are kept.
 */
export function wallToInstant(date: WallDate, time: string, timezone: string): number {
  const { hour, minute } = parseTime(time);
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsetBefore = offsetAt(asUtc - DAY_MS, timezone);
  const offsetAfter = offsetAt(asUtc + DAY_MS, timezone);
  const matches = [...new Set([asUtc - offsetBefore, asUtc - offsetAfter])]
    .filter((candidate) => {
      const w = wallClock(candidate, timezone);
      return w.year === date.year && w.month === date.month && w.day === date.day && w.hour === hour && w.minute === minute;
    })
    .sort((a, b) => a - b);
  return matches[0] ?? asUtc - offsetBefore;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday. */
function weekdayOf(date: WallDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addDays(date: WallDate, days: number): WallDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function minutesOf(time: string): number {
  const { hour, minute } = parseTime(time);
  return hour * 60 + minute;
}

const timeOf = (minutes: number): string => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

/** An hourly rule's times of day: `time`, then every `everyHours` until midnight. */
export function hourlyTimes(rule: { time: string; everyHours: number }): string[] {
  const out: string[] = [];
  for (let m = minutesOf(rule.time); m < 24 * 60; m += rule.everyHours * 60) out.push(timeOf(m));
  return out;
}

/** Which dates a rule runs on, and at which times of day (minutes from midnight, ascending). */
interface RulePlan {
  matches(date: WallDate): boolean;
  minutes: number[];
}

function planFor(rule: ScheduleRule): RulePlan {
  switch (rule.cadence) {
    case 'daily':
      return { matches: () => true, minutes: [minutesOf(rule.time)] };
    case 'weekly':
      return { matches: (date) => rule.weekdays.includes(weekdayOf(date)), minutes: [minutesOf(rule.time)] };
    case 'monthly':
      return { matches: (date) => date.day === Math.min(rule.monthDay, daysInMonth(date.year, date.month)), minutes: [minutesOf(rule.time)] };
    case 'hourly': {
      const days = rule.weekdays;
      return { matches: (date) => days === undefined || days.includes(weekdayOf(date)), minutes: hourlyTimes(rule).map(minutesOf) };
    }
    case 'cron': {
      const spec = parseCron(rule.cron);
      if (typeof spec === 'string') throw new Error(`Bad cron rule "${rule.cron}": ${spec}`);
      return {
        matches: (date) => cronMatchesDate(spec, date.month, date.day, weekdayOf(date), daysInMonth(date.year, date.month)),
        minutes: cronMinutesOfDay(spec),
      };
    }
  }
}

/**
 * The earliest of `date`'s slots strictly after `after`, or null. Each slot
 * is what `wallToInstant` makes of it. On a day with no clock change within a
 * day either side, the zone's offset is the same throughout, so a slot is its
 * wall time less that offset (just what `wallToInstant` gives) and the first
 * one after `after` is the answer; that keeps a minute-by-minute cron rule
 * cheap. Near a change a slot moved forward out of a gap can land after a
 * later one, so every slot goes through `wallToInstant` and the earliest wins.
 */
function firstSlotAfter(date: WallDate, minutes: number[], timezone: string, after: number): number | null {
  const dayStart = Date.UTC(date.year, date.month - 1, date.day);
  const offset = offsetAt(dayStart - DAY_MS, timezone);
  if (offset === offsetAt(dayStart + 2 * DAY_MS, timezone)) {
    for (const m of minutes) {
      const instant = dayStart + m * 60_000 - offset;
      if (instant > after) return instant;
    }
    return null;
  }
  let best: number | null = null;
  for (const m of minutes) {
    const instant = wallToInstant(date, timeOf(m), timezone);
    if (instant > after && (best === null || instant < best)) best = instant;
  }
  return best;
}

/**
 * How far `nextRunAt` looks. The fixed kinds need 400 days at most. A cron
 * rule for 29 February can be 8 years off across 2100, and one that needs a
 * date to fall on a given weekday too (Vixie's both-fields case) can be 11;
 * for 29 February on a weekday, about 40 across 2100 (`5#5` in February is the same: 29 February on a Friday).
 * 50 years covers every rule `parseCron` accepts, and
 * the walk only gets that far for such a rule.
 */
const WALK_DAYS = 50 * 366;

/**
 * The first instant strictly after `after` whose wall-clock date in
 * `timezone` matches `rule` and whose wall-clock time is one of its times,
 * through `wallToInstant`: a slot in a fold runs once, at the first time; one
 * in a gap moves forward by the gap; two slots that land on the same instant
 * run once. Every kind of rule takes the same walk, so hourly and cron rules
 * meet a clock change just as a daily one does. The walk starts the day
 * before `after`'s date: a clock change can push that day's slot past
 * midnight (23:30 in a gap at 23:00 runs at 00:30), still ahead of `after`.
 */
export function nextRunAt(rule: ScheduleRule, timezone: string, after: number): number {
  const plan = planFor(rule);
  const start = wallClock(after, timezone);
  for (let i = -1; i <= WALK_DAYS; i++) {
    const date = addDays(start, i);
    if (!plan.matches(date)) continue;
    const instant = firstSlotAfter(date, plan.minutes, timezone, after);
    if (instant !== null) return instant;
  }
  throw new Error(`No run within ${WALK_DAYS} days for rule ${JSON.stringify(rule)}.`);
}

/** The next `count` runs after `after`, for the editor's preview. */
export function nextRuns(rule: ScheduleRule, timezone: string, after: number, count: number): number[] {
  const out: number[] = [];
  let t = after;
  for (let i = 0; i < count; i++) {
    t = nextRunAt(rule, timezone, t);
    out.push(t);
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * `instant` in `timezone`: 'long' is "Monday 12 October 2026, 09:00", 'date'
 * is "Monday 12 October 2026", 'short' is "12 Oct 2026", 'time' is "09:00".
 */
export function formatInZone(instant: number, timezone: string, style: 'long' | 'date' | 'short' | 'time'): string {
  const w = wallClock(instant, timezone);
  const time = `${pad2(w.hour)}:${pad2(w.minute)}`;
  if (style === 'time') return time;
  if (style === 'short') return `${w.day} ${MONTHS_SHORT[w.month - 1]} ${w.year}`;
  const date = `${WEEKDAYS[weekdayOf(w)]} ${w.day} ${MONTHS[w.month - 1]} ${w.year}`;
  return style === 'date' ? date : `${date}, ${time}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "Every day", "Weekdays", "Mondays", "Mon, Wed and Fri". */
function daysPhrase(weekdays: number[]): string {
  const days = [...weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
  if (days.length === 7) return 'Every day';
  if (days.join(',') === '1,2,3,4,5') return 'Weekdays';
  if (days.length === 1) return `${WEEKDAYS[days[0]!]}s`;
  return joinAnd(days.map((d) => WEEKDAYS_SHORT[d]!));
}

/**
 * "Every day at 09:00", "Weekdays at 09:00", "Mondays at 09:00", "Mon, Wed and Fri at 09:00", "Monthly on the 1st at 09:00",
 * "Monthly on the 31st (or the month's last day) at 09:00", "Every 3 hours from 08:00 to 23:00", "Every hour from 09:00 to 23:00 on weekdays",
 * "Every 5 hours from 22:00, once a day", "Cron rule 0 9 * * 1-5".
 */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.cadence) {
    case 'daily':
      return `Every day at ${rule.time}`;
    case 'weekly':
      return `${daysPhrase(rule.weekdays)} at ${rule.time}`;
    case 'monthly':
      return rule.monthDay >= 29
        ? `Monthly on the ${ordinal(rule.monthDay)} (or the month's last day) at ${rule.time}`
        : `Monthly on the ${ordinal(rule.monthDay)} at ${rule.time}`;
    case 'hourly': {
      const times = hourlyTimes(rule);
      const every = rule.everyHours === 1 ? 'Every hour' : `Every ${rule.everyHours} hours`;
      const span = times.length === 1 ? `${every} from ${rule.time}, once a day` : `${every} from ${rule.time} to ${times.at(-1)}`;
      const days = rule.weekdays === undefined ? 'Every day' : daysPhrase(rule.weekdays);
      if (days === 'Every day') return span;
      return `${span} on ${days === 'Weekdays' ? 'weekdays' : days}`;
    }
    case 'cron':
      return `Cron rule ${rule.cron}`;
  }
}

export interface ScheduledPromptInput {
  name: string;
  /** The schedule's own prompt, as the user wrote it. */
  prompt: string;
  timezone: string;
  trigger: ScheduleTrigger;
  /** When this run started. */
  at: number;
  /** The slot it was due at, for a late run's "It was due …". Null for Run now. */
  dueAt: number | null;
  /** When the last completed run started, or null for the first. */
  previousAt: number | null;
  /** The run uses Claude Code's auto mode (`Schedule.autoMode` on a Claude Code profile). */
  autoMode?: boolean;
  /** The schedule's time limit in minutes (`Schedule.timeLimitMinutes`); null or left out for none. */
  timeLimitMinutes?: number | null;
}

/**
 * What a scheduled run sends: one bracketed paragraph naming the schedule, the
 * date and time, the previous completed run's date, that approvals will be
 * refused and the run's time limit; a blank line; then the prompt. Stored in the chat as the user
 * message, so the model and a later reader see the same thing.
 */
export function scheduledPromptText(input: ScheduledPromptInput): string {
  const { name, timezone, trigger, at, dueAt, previousAt } = input;
  const head = trigger === 'manual' ? `Run by hand from schedule "${name}"` : `Scheduled run "${name}"`;
  const sentences = [`${head}: ${formatInZone(at, timezone, 'long')} (${timezone}).`];
  if (trigger === 'late' && dueAt !== null) sentences.push(`It was due ${formatInZone(dueAt, timezone, 'long')}.`);
  sentences.push(previousAt === null ? 'This is the first run.' : `The previous run was ${formatInZone(previousAt, timezone, 'date')}.`);
  sentences.push(
    input.autoMode === true
      ? 'Nobody is watching this run: auto mode decides tool calls, and any that would still need approval will be refused.'
      : 'Nobody is watching this run, so tool calls that need approval will be refused.'
  );
  const limit = input.timeLimitMinutes ?? null;
  if (limit !== null) sentences.push(`It is stopped if it is still going after ${timeLimitText(limit)}.`);
  return `[${sentences.join(' ')}]\n\n${input.prompt}`;
}

/** A project target's new chat: "Weekly report · 12 Oct 2026". Not cut: chat titles have no length limit on create. */
export function runChatTitle(name: string, instant: number, timezone: string): string {
  return `${name} · ${formatInZone(instant, timezone, 'short')}`;
}

/** Whether the profile's shell runs on this machine rather than in the sandbox (spec 2026-10-12-sandbox-design). */
function hostShell(policy: ToolPolicy): boolean {
  return policy.shell && !runsShellInSandbox(policy);
}

/**
 * One short line per kind of tool call a scheduled run on this profile will
 * have refused, because it would need a card nobody can answer. For the
 * editor, under the profile. Says what is refused, not what runs.
 * File changes count on an API profile with read & write files, or on Claude
 * Code with read & write files and a folder (with no folder, or files off or
 * read-only, Claude Code's edits are denied by policy, not by a card).
 * With the schedule's Auto on a Claude Code profile, Claude Code's classifier
 * decides its calls and OtherBench's own tools are approved, as in a chat with
 * Auto on, whatever the approval mode; what is left is a call the classifier
 * blocks or Claude Code would still ask about, a sandbox host off the list,
 * and computer use.
 */
export function unattendedWarnings(policy: ToolPolicy, connectionKind: ConnectionKind, hasFolder: boolean, autoMode = false): string[] {
  const claudeCode = connectionKind === 'claude_code';
  if (claudeCode && autoMode) {
    const lines = ["Auto mode decides Claude Code's tool calls. One it blocks is refused, and so is one it would still ask you about."];
    if (runsShellInSandbox(policy) && hasFolder) lines.push(SANDBOX_HOSTS_WARNING);
    if (policy.computer === true) lines.push(COMPUTER_WARNING);
    return lines;
  }
  if (policy.approvalMode === 'always_ask') return ['This profile asks before every tool call, so every tool call will be refused.'];
  const lines: string[] = [];
  if (!claudeCode && hostShell(policy)) lines.push('Shell commands on this machine need approval. Run the shell in the sandbox to use it unattended.');
  if (policy.fs === 'readwrite' && (!claudeCode || hasFolder)) lines.push('File changes need approval unless an Always grant covers them.');
  if (claudeCode && hasFolder && hostShell(policy)) lines.push("Claude Code's shell commands need approval.");
  // A sandboxed command needs no card under "Ask on changes", but a host off its list is a card (never automatic).
  // Claude Code with no folder gets no sandboxed run_command at all.
  if (runsShellInSandbox(policy) && (!claudeCode || hasFolder)) lines.push(SANDBOX_HOSTS_WARNING);
  if (policy.mcpServerIds.length > 0) lines.push('MCP tools not marked read-only need approval.');
  if (policy.recall !== false) lines.push('Searching past chats asks first in each chat, so it will be refused.');
  // The browser asks once per website (never automatic), for both engines, with or without a folder.
  if (policy.browser === true) lines.push("The browser asks before each new website, so using a site is refused unless the profile's site list or a grant already covers it (an Always grant, or one for the schedule's own chat).");
  // Sub-agents are for API profiles. One run as another profile is held to both policies, the stricter approval mode included.
  if (!claudeCode && policy.subagents === true) lines.push('A sub-agent run as a profile that asks before every tool call will have every tool call refused.');
  // Computer use (spec 2026-10-12-computer-use-design) never runs unattended, whatever grants there are, for both
  // engines: every action is refused, a screenshot included, before the desktop app is asked anything.
  if (policy.computer === true) lines.push(COMPUTER_WARNING);
  return lines;
}

const SANDBOX_HOSTS_WARNING =
  "Sandboxed commands' requests for hosts that aren't on the profile's list are refused, unless a grant already covers the host (an Always grant, or one for the schedule's own chat).";

const COMPUTER_WARNING = 'Computer use needs someone at the machine, so every computer action is refused, a screenshot included.';
