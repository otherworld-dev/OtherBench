/**
 * Scheduled tasks (spec 2026-10-12-scheduled-tasks-design §1): the rules,
 * limits, time-zone arithmetic and texts a schedule needs. Pure, with no Node
 * imports, so the web UI uses it too. Every date and time a schedule shows is
 * in its own IANA zone. Month and weekday names are this file's own English,
 * fed by Intl's numeric parts, so no text here moves with the ICU version.
 */
import { runsShellInSandbox, type ConnectionKind, type ToolPolicy } from '../types/config.js';

export const SCHEDULE_NAME_MAX = 80;
export const SCHEDULE_PROMPT_MAX = 20_000;
export const MAX_SCHEDULES = 100;
export const SCHEDULE_RUNS_KEPT = 50;
export const MAX_CONCURRENT_SCHEDULED_RUNS = 2;
export const SCHEDULE_RUN_TIMEOUT_MS = 30 * 60_000;
export const SCHEDULE_LATE_AFTER_MS = 5 * 60_000;
export const SCHEDULE_CHECK_MAX_MS = 30_000;

/** `time` is `HH:MM`, 00:00-23:59. `weekdays` are 0-6 with 0 = Sunday (as `getUTCDay`), sorted, no repeats. `monthDay` 1-31; past the month's end means its last day. */
export type ScheduleRule =
  | { cadence: 'daily'; time: string }
  | { cadence: 'weekly'; time: string; weekdays: number[] }
  | { cadence: 'monthly'; time: string; monthDay: number };

/** Where a run's reply goes. Fixed once the schedule is made. */
export type ScheduleTarget = { kind: 'chat'; chatId: string } | { kind: 'project'; projectId: string };

export type ScheduleRunStatus = 'running' | 'complete' | 'error' | 'cancelled' | 'timed_out' | 'not_started';

/** `scheduled` within 5 minutes of due, `late` after that, `manual` for Run now. */
export type ScheduleTrigger = 'scheduled' | 'late' | 'manual';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The rule, or a message naming the field that's wrong. Weekdays come back sorted with no repeats. */
export function parseRule(value: unknown): ScheduleRule | string {
  if (!isRecord(value)) return '"rule" must be an object.';
  const time = value['time'];
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return '"rule.time" must be HH:MM, from 00:00 to 23:59.';
  switch (value['cadence']) {
    case 'daily':
      return { cadence: 'daily', time };
    case 'weekly': {
      const days = value['weekdays'];
      if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        return '"rule.weekdays" must be a non-empty list of days, 0 (Sunday) to 6 (Saturday).';
      }
      return { cadence: 'weekly', time, weekdays: [...new Set(days as number[])].sort((a, b) => a - b) };
    }
    case 'monthly': {
      const day = value['monthDay'];
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) return '"rule.monthDay" must be a whole number from 1 to 31.';
      return { cadence: 'monthly', time, monthDay: day };
    }
    default:
      return '"rule.cadence" must be "daily", "weekly" or "monthly".';
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

function matchesRule(rule: ScheduleRule, date: WallDate): boolean {
  switch (rule.cadence) {
    case 'daily':
      return true;
    case 'weekly':
      return rule.weekdays.includes(weekdayOf(date));
    case 'monthly':
      return date.day === Math.min(rule.monthDay, daysInMonth(date.year, date.month));
  }
}

/**
 * The first instant strictly after `after` whose wall-clock date in
 * `timezone` matches `rule` and whose wall-clock time is its `time` (through
 * `wallToInstant`, so a slot in a fold runs once, at the first time). Walks
 * up to 400 days, which every valid rule falls inside. The walk starts the
 * day before `after`'s date: a clock change can push that day's slot past
 * midnight (23:30 in a gap at 23:00 runs at 00:30), still ahead of `after`.
 */
export function nextRunAt(rule: ScheduleRule, timezone: string, after: number): number {
  const start = wallClock(after, timezone);
  for (let i = -1; i <= 400; i++) {
    const date = addDays(start, i);
    if (!matchesRule(rule, date)) continue;
    const instant = wallToInstant(date, rule.time, timezone);
    if (instant > after) return instant;
  }
  throw new Error(`No run within 400 days for rule ${JSON.stringify(rule)}.`);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (n: number): string => String(n).padStart(2, '0');

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

/** "Every day at 09:00", "Weekdays at 09:00", "Mondays at 09:00", "Mon, Wed and Fri at 09:00", "Monthly on the 1st at 09:00", "Monthly on the 31st (or the month's last day) at 09:00". */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.cadence) {
    case 'daily':
      return `Every day at ${rule.time}`;
    case 'weekly': {
      const days = [...rule.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
      if (days.length === 7) return `Every day at ${rule.time}`;
      if (days.join(',') === '1,2,3,4,5') return `Weekdays at ${rule.time}`;
      if (days.length === 1) return `${WEEKDAYS[days[0]!]}s at ${rule.time}`;
      return `${joinAnd(days.map((d) => WEEKDAYS_SHORT[d]!))} at ${rule.time}`;
    }
    case 'monthly':
      return rule.monthDay >= 29
        ? `Monthly on the ${ordinal(rule.monthDay)} (or the month's last day) at ${rule.time}`
        : `Monthly on the ${ordinal(rule.monthDay)} at ${rule.time}`;
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
}

/**
 * What a scheduled run sends: one bracketed paragraph naming the schedule, the
 * date and time, the previous completed run's date and that approvals will be
 * refused; a blank line; then the prompt. Stored in the chat as the user
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
  if (policy.browser === true) lines.push("The browser asks before each new website, so using a site is refused unless a grant already covers it (an Always grant, or one for the schedule's own chat).");
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
