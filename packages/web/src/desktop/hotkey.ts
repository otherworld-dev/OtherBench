/** The quick-chat hotkey when none has been set (v2 plan, Task 37). */
export const DEFAULT_HOTKEY = 'Ctrl+Alt+G';

/** localStorage key for the hotkey. Per device: a global shortcut belongs to the machine. */
export const HOTKEY_STORAGE_KEY = 'otherbench.hotkey';

export function loadHotkey(): string {
  try {
    const stored = window.localStorage.getItem(HOTKEY_STORAGE_KEY);
    return stored && stored.trim().length > 0 ? stored : DEFAULT_HOTKEY;
  } catch {
    return DEFAULT_HOTKEY;
  }
}

export function saveHotkey(accelerator: string): void {
  try {
    window.localStorage.setItem(HOTKEY_STORAGE_KEY, accelerator);
  } catch {
    // storage blocked or full -- the hotkey still works until the app restarts.
  }
}
