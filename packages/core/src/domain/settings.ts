import type { AppSettings } from '../ports/store.js';

/** What `SettingsRepo.get()` returns for a key that was never set. */
export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = { memoryProfileId: null };
