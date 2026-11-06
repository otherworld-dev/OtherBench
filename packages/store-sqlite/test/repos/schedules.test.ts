import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/store.js';
import { freshDb, seedChatChain } from '../helpers.js';

describe('SqliteScheduleRepo', () => {
  it('lists a row whose rule cannot be read as disabled, with the reason, and never as due', () => {
    const db = freshDb();
    const store = new SqliteStore(db);
    try {
      seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat1' });
      for (const [id, rule] of [['bad-json', 'not json'], ['bad-rule', '{"cadence":"cron","cron":"0 0 30 2 *"}']] as const) {
        db.prepare(
          `INSERT INTO schedule (id, name, prompt, profile_id, chat_id, project_id, rule, timezone, enabled, next_run_at, created_at, updated_at)
           VALUES (?, 'S', 'p', 'p1', 'chat1', NULL, ?, 'UTC', 1, 5, 1, 1)`
        ).run(id, rule);
      }

      expect(store.schedules.get('bad-json')).toMatchObject({ enabled: false, nextRunAt: null, invalid: 'Its rule is not valid JSON.' });
      expect(store.schedules.get('bad-rule')).toMatchObject({ enabled: false, nextRunAt: null, invalid: '"rule.cron": It never runs: none of those months has any of those days.' });
      expect(store.schedules.due(10)).toEqual([]);

      // Renaming keeps the stored rule as it was; a new rule mends it.
      store.schedules.update('bad-rule', { name: 'Renamed' });
      expect(store.schedules.get('bad-rule')).toMatchObject({ name: 'Renamed', invalid: expect.any(String) });
      const mended = store.schedules.update('bad-rule', { rule: { cadence: 'daily', time: '08:00' }, enabled: true, nextRunAt: 7 });
      expect(mended).toMatchObject({ enabled: true, nextRunAt: 7, rule: { cadence: 'daily', time: '08:00' } });
      expect(mended).not.toHaveProperty('invalid');
    } finally {
      store.close();
    }
  });

  it('keeps every-N-hours and cron rules in the rule column as they are, so they need no migration', () => {
    const db = freshDb();
    const store = new SqliteStore(db);
    try {
      seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat1' });
      const base = { name: 'S', prompt: 'p', profileId: 'p1', target: { kind: 'chat', chatId: 'chat1' }, timezone: 'Europe/London', enabled: true, nextRunAt: 5 } as const;
      const hourly = { cadence: 'hourly', time: '08:00', everyHours: 3, weekdays: [1, 5] } as const;
      store.schedules.create({ ...base, id: 'h', rule: { ...hourly, weekdays: [...hourly.weekdays] } });
      store.schedules.create({ ...base, id: 'c', rule: { cadence: 'cron', cron: '*/15 9-17 * * 1-5' } });
      expect(store.schedules.get('h')).toMatchObject({ enabled: true, nextRunAt: 5, rule: hourly });
      expect(store.schedules.get('h')).not.toHaveProperty('invalid');
      expect(store.schedules.get('c')).toMatchObject({ enabled: true, rule: { cadence: 'cron', cron: '*/15 9-17 * * 1-5' } });
      expect((db.prepare("SELECT rule FROM schedule WHERE id = 'c'").get() as { rule: string }).rule).toBe('{"cadence":"cron","cron":"*/15 9-17 * * 1-5"}');
      expect(store.schedules.due(10).map((s) => s.id).sort()).toEqual(['c', 'h']);
      store.schedules.update('c', { rule: { cadence: 'hourly', time: '00:00', everyHours: 1 } });
      expect(store.schedules.get('c')!.rule).toEqual({ cadence: 'hourly', time: '00:00', everyHours: 1 });
    } finally {
      store.close();
    }
  });
  it('points a chat schedule at another chat, and refuses a project schedule', () => {
    const db = freshDb();
    const store = new SqliteStore(db);
    try {
      seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat1' });
      db.prepare(`INSERT INTO chat (id, title, profile_id, pinned, created_at, updated_at) VALUES ('chat2', 'Next', 'p1', 0, 1000, 1000)`).run();
      db.prepare(`INSERT INTO project (id, name, created_at, updated_at) VALUES ('proj1', 'P', 1, 1)`).run();
      const base = { name: 'S', prompt: 'p', profileId: 'p1', timezone: 'UTC', enabled: true, nextRunAt: 5, rule: { cadence: 'daily', time: '08:00' } } as const;
      store.schedules.create({ ...base, id: 's1', target: { kind: 'chat', chatId: 'chat1' } });
      store.schedules.create({ ...base, id: 's2', target: { kind: 'project', projectId: 'proj1' } });
      store.schedules.retarget('s1', 'chat2');
      expect(store.schedules.get('s1')!.target).toEqual({ kind: 'chat', chatId: 'chat2' });
      expect(() => store.schedules.retarget('s2', 'chat2')).toThrow();
      expect(store.schedules.get('s2')!.target).toEqual({ kind: 'project', projectId: 'proj1' });
    } finally {
      store.close();
    }
  });
});
