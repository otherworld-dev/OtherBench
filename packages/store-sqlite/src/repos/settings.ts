import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_APP_SETTINGS } from '@otherbench/core/domain/settings.js';
import type { AppSettings, SettingsRepo } from '@otherbench/core/ports/store.js';

/** App-wide settings as key/value rows (`app_setting`, migration 008); each value is JSON. Unknown keys are ignored. Also holds machine-local values (`getValue`/`setValue`) under keys that aren't settings. */
export class SqliteSettingsRepo implements SettingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(): AppSettings {
    const settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM app_setting').all() as { key: string; value: string }[];
    for (const row of rows) {
      if (!Object.hasOwn(DEFAULT_APP_SETTINGS, row.key)) continue;
      try {
        (settings as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
      } catch (err) {
        // A damaged row must not take every settings read down; this key keeps its default.
        console.warn(`[otherbench] ignoring unreadable app setting "${row.key}":`, err);
      }
    }
    return settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const upsert = this.db.prepare('INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && Object.hasOwn(DEFAULT_APP_SETTINGS, key)) upsert.run(key, JSON.stringify(value));
    }
    return this.get();
  }

  getValue(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch (err) {
      console.warn(`[otherbench] ignoring unreadable app value "${key}":`, err);
      return null;
    }
  }

  setValue(key: string, value: unknown): void {
    if (Object.hasOwn(DEFAULT_APP_SETTINGS, key)) throw new Error(`"${key}" is a settings key: change it with update().`);
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM app_setting WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare('INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}
