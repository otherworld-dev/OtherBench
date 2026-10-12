import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/store.js';
import { freshDb, seedChatChain } from '../helpers.js';

describe('SqliteScheduleRepo', () => {
  it('lists a row whose rule cannot be read as disabled, with the reason, and never as due', () => {
    const db = freshDb();
    const store = new SqliteStore(db);
    try {
      seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat1' });
      for (const [id, rule] of [['bad-json', 'not json'], ['bad-rule', '{"cadence":"hourly","time":"09:00"}']] as const) {
        db.prepare(
          `INSERT INTO schedule (id, name, prompt, profile_id, chat_id, project_id, rule, timezone, enabled, next_run_at, created_at, updated_at)
           VALUES (?, 'S', 'p', 'p1', 'chat1', NULL, ?, 'UTC', 1, 5, 1, 1)`
        ).run(id, rule);
      }

      expect(store.schedules.get('bad-json')).toMatchObject({ enabled: false, nextRunAt: null, invalid: 'Its rule is not valid JSON.' });
      expect(store.schedules.get('bad-rule')).toMatchObject({ enabled: false, nextRunAt: null, invalid: '"rule.cadence" must be "daily", "weekly" or "monthly".' });
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
});
