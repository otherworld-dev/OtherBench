import { describe, expect, it } from 'vitest';
import type { ToolPolicy } from '../src/types/config.js';
import {
  describeRule,
  formatInZone,
  isValidTimeZone,
  nextRunAt,
  parseRule,
  runChatTitle,
  scheduledPromptText,
  unattendedWarnings,
  wallToInstant,
  type ScheduleRule,
} from '../src/domain/schedule.js';

const iso = (n: number): string => new Date(n).toISOString();
const at = (s: string): number => Date.parse(s);
const LONDON = 'Europe/London';

describe('wallToInstant', () => {
  it('turns a London wall-clock time into its instant, in summer time', () => {
    expect(iso(wallToInstant({ year: 2026, month: 10, day: 12 }, '09:00', LONDON))).toBe('2026-10-12T08:00:00.000Z');
  });

  it('moves a time in the spring gap forward by the gap (01:30 becomes 02:30 BST)', () => {
    expect(iso(wallToInstant({ year: 2026, month: 3, day: 29 }, '01:30', LONDON))).toBe('2026-03-29T01:30:00.000Z');
    expect(iso(wallToInstant({ year: 2026, month: 3, day: 8 }, '02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z');
  });

  it('takes the first of a time that happens twice in the autumn fold', () => {
    expect(iso(wallToInstant({ year: 2026, month: 10, day: 25 }, '01:30', LONDON))).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(wallToInstant({ year: 2026, month: 11, day: 1 }, '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
  });

  it("handles Lord Howe's 30-minute gap", () => {
    expect(iso(wallToInstant({ year: 2026, month: 10, day: 4 }, '02:15', 'Australia/Lord_Howe'))).toBe('2026-10-03T15:45:00.000Z');
  });
});

describe('nextRunAt', () => {
  const thursdays: ScheduleRule = { cadence: 'weekly', time: '09:00', weekdays: [4] };

  it('keeps 09:00 local across the October clock change', () => {
    const first = nextRunAt(thursdays, LONDON, at('2026-10-16T00:00:00Z'));
    expect(iso(first)).toBe('2026-10-22T08:00:00.000Z');
    expect(iso(nextRunAt(thursdays, LONDON, first))).toBe('2026-10-29T09:00:00.000Z');
  });

  it('runs a daily 01:30 once on the day the clocks go back', () => {
    const daily: ScheduleRule = { cadence: 'daily', time: '01:30' };
    const first = nextRunAt(daily, LONDON, at('2026-10-24T12:00:00Z'));
    expect(iso(first)).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(nextRunAt(daily, LONDON, first))).toBe('2026-10-26T01:30:00.000Z');
  });

  it("runs monthly on the 31st on each shorter month's last day", () => {
    const rule: ScheduleRule = { cadence: 'monthly', time: '09:00', monthDay: 31 };
    const feb = nextRunAt(rule, LONDON, at('2026-02-01T00:00:00Z'));
    const mar = nextRunAt(rule, LONDON, feb);
    const apr = nextRunAt(rule, LONDON, mar);
    expect([iso(feb), iso(mar), iso(apr)]).toEqual(['2026-02-28T09:00:00.000Z', '2026-03-31T08:00:00.000Z', '2026-04-30T08:00:00.000Z']);
  });

  it('lands a Monday, Wednesday and Friday schedule on those days', () => {
    const rule: ScheduleRule = { cadence: 'weekly', time: '09:00', weekdays: [1, 3, 5] };
    const days: string[] = [];
    let t = at('2026-10-12T09:00:00Z'); // Monday 10:00 in London, after that day's slot
    for (let i = 0; i < 4; i++) {
      t = nextRunAt(rule, LONDON, t);
      days.push(formatInZone(t, LONDON, 'long'));
    }
    expect(days).toEqual(['Wednesday 14 October 2026, 09:00', 'Friday 16 October 2026, 09:00', 'Monday 19 October 2026, 09:00', 'Wednesday 21 October 2026, 09:00']);
  });

  it('is strictly after `after`, also when `after` is exactly a slot', () => {
    const daily: ScheduleRule = { cadence: 'daily', time: '09:00' };
    const slot = at('2026-10-12T08:00:00Z');
    expect(iso(nextRunAt(daily, LONDON, slot - 1))).toBe('2026-10-12T08:00:00.000Z');
    expect(iso(nextRunAt(daily, LONDON, slot))).toBe('2026-10-13T08:00:00.000Z');
    expect(iso(nextRunAt({ cadence: 'daily', time: '00:00' }, 'UTC', at('2026-10-12T00:00:00Z')))).toBe('2026-10-13T00:00:00.000Z');
  });

  it("doesn't skip a slot the clock change moved past midnight", () => {
    // Nuuk springs from -02 to -01 at 2026-03-29 01:00 UTC, so local 23:00 on
    // the 28th becomes 00:00 on the 29th: the 28th's 23:30 runs at 00:30 on the 29th.
    const daily: ScheduleRule = { cadence: 'daily', time: '23:30' };
    const after = Date.UTC(2026, 2, 29, 1, 10); // 29 Mar 00:10 in Nuuk
    expect(iso(nextRunAt(daily, 'America/Nuuk', after))).toBe(iso(Date.UTC(2026, 2, 29, 1, 30)));
    expect(iso(nextRunAt(daily, 'America/Godthab', after))).toBe(iso(Date.UTC(2026, 2, 29, 1, 30)));
  });
});

describe('parseRule', () => {
  it('accepts each cadence and sorts and deduplicates weekdays', () => {
    expect(parseRule({ cadence: 'daily', time: '00:00' })).toEqual({ cadence: 'daily', time: '00:00' });
    expect(parseRule({ cadence: 'weekly', time: '09:00', weekdays: [5, 1, 1, 3] })).toEqual({ cadence: 'weekly', time: '09:00', weekdays: [1, 3, 5] });
    expect(parseRule({ cadence: 'monthly', time: '23:59', monthDay: 31 })).toEqual({ cadence: 'monthly', time: '23:59', monthDay: 31 });
  });

  it('names the bad field', () => {
    expect(parseRule(null)).toBe('"rule" must be an object.');
    expect(parseRule({ cadence: 'daily', time: '24:00' })).toBe('"rule.time" must be HH:MM, from 00:00 to 23:59.');
    expect(parseRule({ cadence: 'daily', time: '9:00' })).toBe('"rule.time" must be HH:MM, from 00:00 to 23:59.');
    expect(parseRule({ cadence: 'hourly', time: '09:00' })).toBe('"rule.cadence" must be "daily", "weekly" or "monthly".');
    expect(parseRule({ cadence: 'weekly', time: '09:00', weekdays: [] })).toBe('"rule.weekdays" must be a non-empty list of days, 0 (Sunday) to 6 (Saturday).');
    expect(parseRule({ cadence: 'weekly', time: '09:00', weekdays: [7] })).toBe('"rule.weekdays" must be a non-empty list of days, 0 (Sunday) to 6 (Saturday).');
    expect(parseRule({ cadence: 'monthly', time: '09:00', monthDay: 0 })).toBe('"rule.monthDay" must be a whole number from 1 to 31.');
    expect(parseRule({ cadence: 'monthly', time: '09:00', monthDay: 1.5 })).toBe('"rule.monthDay" must be a whole number from 1 to 31.');
  });
});

describe('isValidTimeZone', () => {
  it('knows IANA zones and refuses made-up ones', () => {
    expect(isValidTimeZone(LONDON)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('describeRule', () => {
  it('words each rule', () => {
    expect(describeRule({ cadence: 'daily', time: '09:00' })).toBe('Every day at 09:00');
    expect(describeRule({ cadence: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5] })).toBe('Weekdays at 09:00');
    expect(describeRule({ cadence: 'weekly', time: '09:00', weekdays: [1] })).toBe('Mondays at 09:00');
    expect(describeRule({ cadence: 'weekly', time: '09:00', weekdays: [1, 3, 5] })).toBe('Mon, Wed and Fri at 09:00');
    expect(describeRule({ cadence: 'weekly', time: '09:00', weekdays: [0, 6] })).toBe('Sat and Sun at 09:00');
    expect(describeRule({ cadence: 'weekly', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day at 09:00');
    expect(describeRule({ cadence: 'monthly', time: '09:00', monthDay: 1 })).toBe('Monthly on the 1st at 09:00');
    expect(describeRule({ cadence: 'monthly', time: '09:00', monthDay: 22 })).toBe('Monthly on the 22nd at 09:00');
    expect(describeRule({ cadence: 'monthly', time: '09:00', monthDay: 31 })).toBe("Monthly on the 31st (or the month's last day) at 09:00");
  });
});

describe('texts', () => {
  const slot = at('2026-10-12T08:00:00Z');
  const base = { name: 'Weekly report', prompt: 'hello', timezone: LONDON };

  it('formats an instant in its zone', () => {
    expect(formatInZone(slot, LONDON, 'long')).toBe('Monday 12 October 2026, 09:00');
    expect(formatInZone(slot, LONDON, 'date')).toBe('Monday 12 October 2026');
    expect(formatInZone(slot, LONDON, 'short')).toBe('12 Oct 2026');
    expect(formatInZone(slot, LONDON, 'time')).toBe('09:00');
    expect(formatInZone(at('2026-09-01T12:00:00Z'), 'UTC', 'short')).toBe('1 Sep 2026');
  });

  it('opens a run with the schedule, the date and time, the previous run and the refusal warning', () => {
    expect(scheduledPromptText({ ...base, trigger: 'scheduled', at: slot, dueAt: slot, previousAt: at('2026-10-05T08:00:00Z') })).toBe(
      '[Scheduled run "Weekly report": Monday 12 October 2026, 09:00 (Europe/London). The previous run was Monday 5 October 2026. Nobody is watching this run, so tool calls that need approval will be refused.]\n\nhello'
    );
  });

  it('says a first run is the first, a late run when it was due, and a Run now that it was run by hand', () => {
    expect(scheduledPromptText({ ...base, trigger: 'late', at: slot + 3 * 3_600_000, dueAt: slot, previousAt: null })).toBe(
      '[Scheduled run "Weekly report": Monday 12 October 2026, 12:00 (Europe/London). It was due Monday 12 October 2026, 09:00. This is the first run. Nobody is watching this run, so tool calls that need approval will be refused.]\n\nhello'
    );
    expect(scheduledPromptText({ ...base, trigger: 'manual', at: slot, dueAt: null, previousAt: null })).toBe(
      '[Run by hand from schedule "Weekly report": Monday 12 October 2026, 09:00 (Europe/London). This is the first run. Nobody is watching this run, so tool calls that need approval will be refused.]\n\nhello'
    );
  });

  it('titles a run chat with the name and the short date, uncut', () => {
    expect(runChatTitle('Weekly report', slot, LONDON)).toBe('Weekly report · 12 Oct 2026');
    expect(runChatTitle('x'.repeat(80), slot, LONDON)).toBe(`${'x'.repeat(80)} · 12 Oct 2026`);
  });
});

describe('unattendedWarnings', () => {
  const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', recall: false, ...over });

  it('says everything is refused under "Ask before every call", and nothing when nothing asks', () => {
    expect(unattendedWarnings(policy({ approvalMode: 'always_ask' }), 'anthropic', true)).toEqual(['This profile asks before every tool call, so every tool call will be refused.']);
    expect(unattendedWarnings(policy({ fs: 'read' }), 'anthropic', true)).toEqual([]);
  });

  it('names a host shell, file changes, MCP tools and recall on an API profile', () => {
    expect(unattendedWarnings(policy({ shell: true, fs: 'readwrite', mcpServerIds: ['s'], recall: true }), 'openai', true)).toEqual([
      'Shell commands on this machine need approval. Run the shell in the sandbox to use it unattended.',
      'File changes need approval unless an Always grant covers them.',
      'MCP tools not marked read-only need approval.',
      'Searching past chats asks first in each chat, so it will be refused.',
    ]);
  });

  it("names Claude Code's file changes and shell only when it has a folder", () => {
    expect(unattendedWarnings(policy({ shell: true, fs: 'readwrite' }), 'claude_code', true)).toEqual([
      'File changes need approval unless an Always grant covers them.',
      "Claude Code's shell commands need approval.",
    ]);
    expect(unattendedWarnings(policy({ shell: true, fs: 'readwrite' }), 'claude_code', false)).toEqual([]);
  });

  it('gives a sandboxed shell no "needs approval" line, only the refused hosts, on either engine; a host shell keeps its line', () => {
    const hosts = "Sandboxed commands' requests for hosts that aren't on the profile's list are refused, unless a grant already covers the host (an Always grant, or one for the schedule's own chat).";
    expect(unattendedWarnings(policy({ shell: true, shellRuns: 'sandbox' }), 'anthropic', true)).toEqual([hosts]);
    expect(unattendedWarnings(policy({ shell: true, shellRuns: 'sandbox' }), 'claude_code', true)).toEqual([hosts]);
    // Claude Code with no folder gets no run_command at all.
    expect(unattendedWarnings(policy({ shell: true, shellRuns: 'sandbox' }), 'claude_code', false)).toEqual([]);
    expect(unattendedWarnings(policy({ shell: true, shellRuns: 'host' }), 'anthropic', true)).toEqual([
      'Shell commands on this machine need approval. Run the shell in the sandbox to use it unattended.',
    ]);
    expect(unattendedWarnings(policy({ shell: true, shellRuns: 'host' }), 'claude_code', true)).toEqual(["Claude Code's shell commands need approval."]);
    // shellRuns without the shell on is no shell at all.
    expect(unattendedWarnings(policy({ shell: false, shellRuns: 'sandbox' }), 'anthropic', true)).toEqual([]);
  });

  // Integration with sub-agents: one run as another profile is held to both policies, the stricter approval mode included.
  it('says a sub-agent run as an always-ask profile gets nothing done, for an API profile with sub-agents on', () => {
    const line = 'A sub-agent run as a profile that asks before every tool call will have every tool call refused.';
    expect(unattendedWarnings(policy({ fs: 'read', subagents: true }), 'anthropic', true)).toEqual([line]);
    expect(unattendedWarnings(policy({ fs: 'read', subagents: false }), 'anthropic', true)).toEqual([]);
    expect(unattendedWarnings(policy({ fs: 'read' }), 'anthropic', true)).toEqual([]);
    // Claude Code never gets Grunt's subagent tool, and an always-ask profile already says everything is refused.
    expect(unattendedWarnings(policy({ fs: 'read', subagents: true }), 'claude_code', true)).toEqual([]);
    expect(unattendedWarnings(policy({ approvalMode: 'always_ask', subagents: true }), 'anthropic', true)).toEqual(['This profile asks before every tool call, so every tool call will be refused.']);
  });

  // Integration with the model's browser: it asks once per website, on both engines, with or without a folder.
  it('says a new website is refused for a profile with the browser on, on either engine and in a clean chat', () => {
    const line = "The browser asks before each new website, so using a site is refused unless a grant already covers it (an Always grant, or one for the schedule's own chat).";
    expect(unattendedWarnings(policy({ browser: true }), 'anthropic', true)).toEqual([line]);
    expect(unattendedWarnings(policy({ browser: true }), 'claude_code', true)).toEqual([line]);
    expect(unattendedWarnings(policy({ browser: true }), 'claude_code', false)).toEqual([line]);
    expect(unattendedWarnings(policy({ browser: false }), 'anthropic', true)).toEqual([]);
    expect(unattendedWarnings(policy(), 'anthropic', true)).toEqual([]);
    expect(unattendedWarnings(policy({ approvalMode: 'always_ask', browser: true }), 'anthropic', true)).toEqual(['This profile asks before every tool call, so every tool call will be refused.']);
  });
});
