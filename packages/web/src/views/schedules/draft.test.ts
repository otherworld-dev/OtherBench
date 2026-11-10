import { describe, expect, it } from 'vitest';
import type { Chat, Project, Schedule } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { NO_TIME_LIMIT, createBody, defaultProfileFor, draftFromSchedule, draftProblem, emptyDraft, patchBody, previewRuns, targetHasFolder, timeLimitOptions, type ScheduleDraft } from './draft.js';

function chat(over: Partial<Chat> = {}): Chat {
  return { id: 'c1', title: 'Trip plans', profileId: 'p-chat', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, unread: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}
function project(over: Partial<Project> = {}): Project {
  return { id: 'pr1', name: 'Alpha', description: '', instructions: '', workspace: null, defaultProfileId: 'p-project', sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}
function profile(id: string, over: Partial<Profile> = {}): Profile {
  return { id, name: id, description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null, ...over };
}
function schedule(over: Partial<Schedule> = {}): Schedule {
  return { id: 's1', name: 'Weekly report', prompt: 'hello', profileId: 'p1', target: { kind: 'chat', chatId: 'c1' }, rule: { cadence: 'weekly', time: '07:30', weekdays: [1, 3] }, timezone: 'Europe/London', enabled: true, nextRunAt: 5, autoMode: false, timeLimitMinutes: 30, createdAt: 1, updatedAt: 1, ...over };
}
const valid = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({ ...emptyDraft({ kind: 'chat', chatId: 'c1' }, 'p1'), name: 'Report', prompt: 'hello', ...over });

describe('drafts', () => {
  it('starts a new schedule daily at 09:00 on its prefilled target', () => {
    expect(emptyDraft({ kind: 'project', projectId: 'pr1' }, 'p1')).toEqual({
      name: '', prompt: '', profileId: 'p1', cadence: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5], monthDay: '1', everyHours: '3', hourlyWeekdays: [0, 1, 2, 3, 4, 5, 6], cron: '0 9 * * 1-5',
      targetKind: 'project', chatId: '', projectId: 'pr1', autoMode: false, timeLimitMinutes: 30,
    });
    expect(emptyDraft(null, '')).toMatchObject({ targetKind: 'chat', chatId: '', projectId: '' });
  });

  it('fills a draft from a schedule', () => {
    expect(draftFromSchedule(schedule())).toMatchObject({ cadence: 'weekly', time: '07:30', weekdays: [1, 3], targetKind: 'chat', chatId: 'c1' });
    expect(draftFromSchedule(schedule({ rule: { cadence: 'monthly', time: '09:00', monthDay: 31 } }))).toMatchObject({ cadence: 'monthly', monthDay: '31' });
    expect(draftFromSchedule(schedule()).autoMode).toBe(false);
    expect(draftFromSchedule(schedule({ autoMode: true })).autoMode).toBe(true);
    expect(draftFromSchedule(schedule()).timeLimitMinutes).toBe(30);
    expect(draftFromSchedule(schedule({ timeLimitMinutes: null })).timeLimitMinutes).toBeNull();
  });

  it('names the first thing to fix', () => {
    expect(draftProblem(valid({ name: '  ' }))).toBe('Give the schedule a name.');
    expect(draftProblem(valid({ name: 'x'.repeat(81) }))).toBe('The name can be at most 80 characters.');
    expect(draftProblem(valid({ prompt: ' ' }))).toBe('Write the prompt the schedule sends.');
    expect(draftProblem(valid({ prompt: 'x'.repeat(20_001) }))).toBe('The prompt can be at most 20,000 characters.');
    expect(draftProblem(valid({ profileId: '' }))).toBe('Choose a profile.');
    expect(draftProblem(valid({ chatId: '' }))).toBe('Choose the chat to add to.');
    expect(draftProblem(valid({ targetKind: 'project', projectId: '' }))).toBe('Choose the project to make chats in.');
    expect(draftProblem(valid({ time: '' }))).toBe('Set the time it runs.');
    expect(draftProblem(valid({ cadence: 'weekly', weekdays: [] }))).toBe('Pick at least one day.');
    expect(draftProblem(valid({ cadence: 'monthly', monthDay: '32' }))).toBe('The day of the month must be a whole number from 1 to 31.');
    expect(draftProblem(valid())).toBeNull();
  });

  it('builds the create body, trimming the name and sorting the days', () => {
    expect(createBody(valid({ name: ' Report ', cadence: 'weekly', weekdays: [5, 1] }))).toEqual({
      name: 'Report', prompt: 'hello', profileId: 'p1', target: { chatId: 'c1' }, rule: { cadence: 'weekly', time: '09:00', weekdays: [1, 5] }, autoMode: false, timeLimitMinutes: 30,
    });
    expect(createBody(valid({ autoMode: true }))).toMatchObject({ autoMode: true });
    expect(createBody(valid({ timeLimitMinutes: null }))).toMatchObject({ timeLimitMinutes: null });
    expect(createBody(valid({ targetKind: 'project', projectId: 'pr1', cadence: 'monthly', monthDay: '15' }))).toMatchObject({
      target: { projectId: 'pr1' }, rule: { cadence: 'monthly', time: '09:00', monthDay: 15 },
    });
  });

  it('sends only what changed in a patch', () => {
    const initial = draftFromSchedule(schedule());
    expect(patchBody(initial, initial)).toEqual({});
    expect(patchBody(initial, { ...initial, name: 'Daily', time: '08:00' })).toEqual({ name: 'Daily', rule: { cadence: 'weekly', time: '08:00', weekdays: [1, 3] } });
    expect(patchBody(initial, { ...initial, autoMode: true })).toEqual({ autoMode: true });
    expect(patchBody(initial, { ...initial, timeLimitMinutes: 120 })).toEqual({ timeLimitMinutes: 120 });
    expect(patchBody(initial, { ...initial, timeLimitMinutes: null })).toEqual({ timeLimitMinutes: null });
  });

  it('offers the usual time limits and No limit, keeping a limit of its own that is none of them', () => {
    const labels = (current: number | null): string[] => timeLimitOptions(current).map((o) => o.label);
    expect(labels(30)).toEqual(['10 minutes', '30 minutes', '1 hour', '2 hours', '4 hours', '8 hours', 'No limit']);
    expect(labels(null)).toEqual(labels(30));
    expect(timeLimitOptions(45).map((o) => o.value)).toEqual(['10', '30', '45', '60', '120', '240', '480', NO_TIME_LIMIT]);
    expect(labels(1440).at(-2)).toBe('24 hours');
  });
});

describe('every-N-hours and cron drafts', () => {
  it('fills a draft from each, keeping the other kinds at their defaults', () => {
    expect(draftFromSchedule(schedule({ rule: { cadence: 'hourly', time: '08:00', everyHours: 4, weekdays: [1, 5] } }))).toMatchObject({
      cadence: 'hourly', time: '08:00', everyHours: '4', hourlyWeekdays: [1, 5], weekdays: [1, 2, 3, 4, 5], cron: '0 9 * * 1-5',
    });
    expect(draftFromSchedule(schedule({ rule: { cadence: 'hourly', time: '08:00', everyHours: 4 } })).hourlyWeekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(draftFromSchedule(schedule({ rule: { cadence: 'cron', cron: '*/15 9-17 * * 1-5' } }))).toMatchObject({ cadence: 'cron', cron: '*/15 9-17 * * 1-5', time: '09:00' });
  });

  it('builds their rules: every day leaves the days out, and a cron rule is tidied', () => {
    expect(createBody(valid({ cadence: 'hourly', everyHours: '3' })).rule).toEqual({ cadence: 'hourly', time: '09:00', everyHours: 3 });
    expect(createBody(valid({ cadence: 'hourly', everyHours: '6', hourlyWeekdays: [5, 1] })).rule).toEqual({ cadence: 'hourly', time: '09:00', everyHours: 6, weekdays: [1, 5] });
    expect(createBody(valid({ cadence: 'cron', cron: '  30  7 * * mon ' })).rule).toEqual({ cadence: 'cron', cron: '30 7 * * mon' });
  });

  it('names what to fix, in plain words, with no field names', () => {
    expect(draftProblem(valid({ cadence: 'hourly', everyHours: '' }))).toBe('Run every 1 to 23 hours, in whole hours.');
    expect(draftProblem(valid({ cadence: 'hourly', everyHours: '24' }))).toBe('Run every 1 to 23 hours, in whole hours.');
    expect(draftProblem(valid({ cadence: 'hourly', hourlyWeekdays: [] }))).toBe('Pick at least one day.');
    expect(draftProblem(valid({ cadence: 'hourly', time: '' }))).toBe('Set the time it runs.');
    expect(draftProblem(valid({ cadence: 'cron', cron: '0 9 * *' }))).toBe('A cron rule has five fields (minute, hour, day of month, month, day of week); this has 4.');
    expect(draftProblem(valid({ cadence: 'cron', cron: '0 25 * * *' }))).toBe('The hour field\'s "25" is out of range: 0 to 23.');
    // A cron rule has no time of its own: an empty time field doesn't matter.
    expect(draftProblem(valid({ cadence: 'cron', time: '' }))).toBeNull();
    expect(draftProblem(valid({ cadence: 'hourly' }))).toBeNull();
  });

  it('patches a cron rule only when it changes, not when its spacing does', () => {
    const initial = draftFromSchedule(schedule({ rule: { cadence: 'cron', cron: '0 9 * * 1-5' } }));
    expect(patchBody(initial, { ...initial, cron: ' 0 9  * * 1-5 ', time: '07:00' })).toEqual({});
    expect(patchBody(initial, { ...initial, cron: '0 10 * * 1-5' })).toEqual({ rule: { cadence: 'cron', cron: '0 10 * * 1-5' } });
    expect(patchBody(initial, { ...initial, cadence: 'hourly' })).toEqual({ rule: { cadence: 'hourly', time: '09:00', everyHours: 3 } });
  });
});

describe('previewRuns', () => {
  const MONDAY_NOON = Date.parse('2026-10-12T11:00:00Z'); // 12:00 in London

  it('lists the next three runs in the zone', () => {
    expect(previewRuns(valid({ cadence: 'cron', cron: '0 9 * * 1-5' }), 'Europe/London', MONDAY_NOON)).toEqual([
      'Tuesday 13 October 2026, 09:00',
      'Wednesday 14 October 2026, 09:00',
      'Thursday 15 October 2026, 09:00',
    ]);
    expect(previewRuns(valid({ cadence: 'hourly', time: '08:00', everyHours: '5' }), 'Europe/London', MONDAY_NOON)).toEqual([
      'Monday 12 October 2026, 13:00',
      'Monday 12 October 2026, 18:00',
      'Monday 12 October 2026, 23:00',
    ]);
    expect(previewRuns(valid({ cadence: 'hourly', time: '08:00', everyHours: '6' }), 'Europe/London', MONDAY_NOON)).toEqual([
      'Monday 12 October 2026, 14:00',
      'Monday 12 October 2026, 20:00',
      'Tuesday 13 October 2026, 08:00',
    ]);
    expect(previewRuns(valid(), 'Europe/London', MONDAY_NOON)).toEqual(['Tuesday 13 October 2026, 09:00', 'Wednesday 14 October 2026, 09:00', 'Thursday 15 October 2026, 09:00']);
  });

  it("previews L, W and # rules, and says what is wrong with them", () => {
    expect(previewRuns(valid({ cadence: 'cron', cron: '0 9 LW * *' }), 'Europe/London', MONDAY_NOON)).toEqual([
      'Friday 30 October 2026, 09:00',
      'Monday 30 November 2026, 09:00',
      'Thursday 31 December 2026, 09:00',
    ]);
    expect(previewRuns(valid({ cadence: 'cron', cron: '30 8 * * 1#1,5L' }), 'Europe/London', MONDAY_NOON)).toEqual([
      'Friday 30 October 2026, 08:30',
      'Monday 2 November 2026, 08:30',
      'Friday 27 November 2026, 08:30',
    ]);
    expect(previewRuns(valid({ cadence: 'cron', cron: '0 9 * * 5#6' }), 'Europe/London', MONDAY_NOON)).toBe('The day of week field\'s "5#6" asks for week 6: "#" takes 1 to 5.');
  });

  it('says what is wrong instead, so a typo shows as it is typed', () => {
    expect(previewRuns(valid({ cadence: 'cron', cron: '0 9 * * 1-' }), 'Europe/London', MONDAY_NOON)).toBe('The day of week field\'s "1-" isn\'t a value, a range or "*".');
    expect(previewRuns(valid({ cadence: 'cron', cron: '0 0 31 2 *' }), 'Europe/London', MONDAY_NOON)).toBe('It never runs: none of those months has any of those days.');
  });
});

describe('defaultProfileFor and targetHasFolder', () => {
  const profiles = [profile('p-app', { isDefault: true }), profile('p-chat'), profile('p-project'), profile('p-old', { archivedAt: 5 })];

  it("picks the chat's profile, else the project's default, else the app default, skipping archived ones", () => {
    expect(defaultProfileFor({ kind: 'chat', chatId: 'c1' }, [chat()], [], profiles)).toBe('p-chat');
    expect(defaultProfileFor({ kind: 'chat', chatId: 'c1' }, [chat({ profileId: 'p-old' })], [], profiles)).toBe('p-app');
    expect(defaultProfileFor({ kind: 'project', projectId: 'pr1' }, [], [project()], profiles)).toBe('p-project');
    expect(defaultProfileFor(null, [], [], profiles)).toBe('p-app');
    expect(defaultProfileFor(null, [], [], [])).toBe('');
  });

  it('says whether the target has a folder', () => {
    const ws = { kind: 'machine' as const, nodeId: 'n', root: '/srv' };
    expect(targetHasFolder({ targetKind: 'chat', chatId: 'c1', projectId: '' }, [chat({ workspace: ws })], [])).toBe(true);
    expect(targetHasFolder({ targetKind: 'project', projectId: 'pr1', chatId: '' }, [], [project()])).toBe(false);
  });
});
