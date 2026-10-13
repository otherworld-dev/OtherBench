import { describe, expect, it } from 'vitest';
import type { Chat, Project, Schedule } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';
import { createBody, defaultProfileFor, draftFromSchedule, draftProblem, emptyDraft, patchBody, targetHasFolder, type ScheduleDraft } from './draft.js';

function chat(over: Partial<Chat> = {}): Chat {
  return { id: 'c1', title: 'Trip plans', profileId: 'p-chat', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, unread: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}
function project(over: Partial<Project> = {}): Project {
  return { id: 'pr1', name: 'Alpha', description: '', instructions: '', workspace: null, defaultProfileId: 'p-project', sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}
function profile(id: string, over: Partial<Profile> = {}): Profile {
  return { id, name: id, description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null, ...over };
}
function schedule(over: Partial<Schedule> = {}): Schedule {
  return { id: 's1', name: 'Weekly report', prompt: 'hello', profileId: 'p1', target: { kind: 'chat', chatId: 'c1' }, rule: { cadence: 'weekly', time: '07:30', weekdays: [1, 3] }, timezone: 'Europe/London', enabled: true, nextRunAt: 5, createdAt: 1, updatedAt: 1, ...over };
}
const valid = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({ ...emptyDraft({ kind: 'chat', chatId: 'c1' }, 'p1'), name: 'Report', prompt: 'hello', ...over });

describe('drafts', () => {
  it('starts a new schedule daily at 09:00 on its prefilled target', () => {
    expect(emptyDraft({ kind: 'project', projectId: 'pr1' }, 'p1')).toEqual({
      name: '', prompt: '', profileId: 'p1', cadence: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5], monthDay: '1', targetKind: 'project', chatId: '', projectId: 'pr1',
    });
    expect(emptyDraft(null, '')).toMatchObject({ targetKind: 'chat', chatId: '', projectId: '' });
  });

  it('fills a draft from a schedule', () => {
    expect(draftFromSchedule(schedule())).toMatchObject({ cadence: 'weekly', time: '07:30', weekdays: [1, 3], targetKind: 'chat', chatId: 'c1' });
    expect(draftFromSchedule(schedule({ rule: { cadence: 'monthly', time: '09:00', monthDay: 31 } }))).toMatchObject({ cadence: 'monthly', monthDay: '31' });
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
      name: 'Report', prompt: 'hello', profileId: 'p1', target: { chatId: 'c1' }, rule: { cadence: 'weekly', time: '09:00', weekdays: [1, 5] },
    });
    expect(createBody(valid({ targetKind: 'project', projectId: 'pr1', cadence: 'monthly', monthDay: '15' }))).toMatchObject({
      target: { projectId: 'pr1' }, rule: { cadence: 'monthly', time: '09:00', monthDay: 15 },
    });
  });

  it('sends only what changed in a patch', () => {
    const initial = draftFromSchedule(schedule());
    expect(patchBody(initial, initial)).toEqual({});
    expect(patchBody(initial, { ...initial, name: 'Daily', time: '08:00' })).toEqual({ name: 'Daily', rule: { cadence: 'weekly', time: '08:00', weekdays: [1, 3] } });
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
