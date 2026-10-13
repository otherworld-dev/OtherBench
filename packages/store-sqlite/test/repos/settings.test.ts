import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteSettingsRepo } from '../../src/repos/settings.js';
import { freshDb } from '../helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('SqliteSettingsRepo', () => {
  it('returns defaults, stores updates and ignores unknown keys', () => {
    const repo = new SqliteSettingsRepo(freshDb());
    expect(repo.get()).toEqual({ memoryProfileId: null });
    expect(repo.update({ memoryProfileId: 'p1' })).toEqual({ memoryProfileId: 'p1' });
    repo.update({ toString: 'x', constructor: 'y' } as never);
    expect(repo.get()).toEqual({ memoryProfileId: 'p1' });
  });

  it('a corrupt row falls back to the default for that key and is logged, not thrown', () => {
    const db = freshDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.prepare(`INSERT INTO app_setting (key, value) VALUES ('memoryProfileId', '{not json')`).run();
    db.prepare(`INSERT INTO app_setting (key, value) VALUES ('toString', '"x"')`).run();
    const repo = new SqliteSettingsRepo(db);
    expect(repo.get()).toEqual({ memoryProfileId: null });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a damaged machine-local value reads as null and is logged, not thrown', () => {
    const db = freshDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.prepare(`INSERT INTO app_setting (key, value) VALUES ('sandbox', '{not json')`).run();
    expect(new SqliteSettingsRepo(db).getValue('sandbox')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
