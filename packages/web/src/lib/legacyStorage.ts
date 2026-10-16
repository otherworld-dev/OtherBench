/**
 * OtherBench was called Grunt until October 2026, and kept this browser's
 * preferences (text size, panes, sidebar width and so on) under `grunt.*`
 * keys. Copies each to its `otherbench.*` key, unless that key is already set,
 * and drops the old one. Imported first by main.tsx, so it runs before any
 * module reads a preference.
 */
export function adoptLegacyStorage(storage: Storage): void {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith('grunt.')) old.push(key);
  }
  for (const key of old) {
    const value = storage.getItem(key);
    const next = `otherbench.${key.slice('grunt.'.length)}`;
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    storage.removeItem(key);
  }
}

try {
  adoptLegacyStorage(window.localStorage);
} catch {
  // No storage (a private window, or blocked): there is nothing to move.
}
