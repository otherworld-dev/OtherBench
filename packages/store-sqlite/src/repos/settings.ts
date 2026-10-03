import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_APP_SETTINGS } from '@grunt/core/domain/settings.js';
import type { AppSettings, SettingsRepo } from '@grunt/core/ports/store.js';

/** App-wide settings as key/value rows (`app_setting`, migration 008); each value is JSON. Unknown keys are ignored. */
export class SqliteSettingsRepo implements SettingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(): AppSettings {
    const settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM app_setting').all() as { key: string; value: string }[];
    for (const row of rows) {
      if (row.key in DEFAULT_APP_SETTINGS) (settings as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    }
    return settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const upsert = this.db.prepare('INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && key in DEFAULT_APP_SETTINGS) upsert.run(key, JSON.stringify(value));
    }
    return this.get();
  }
}
