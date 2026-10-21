/** localStorage key: the terminal last shown for each app, by app id. Per browser. */
export const TERMINAL_SELECTED_STORAGE_KEY = 'otherbench.terminalSelected';

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TERMINAL_SELECTED_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The terminal last shown for `appId`, if any (it may have closed since). */
export function selectedTerminal(appId: string): string | null {
  const id = readAll()[appId];
  return typeof id === 'string' ? id : null;
}

export function rememberSelectedTerminal(appId: string, terminalId: string): void {
  try {
    window.localStorage.setItem(TERMINAL_SELECTED_STORAGE_KEY, JSON.stringify({ ...readAll(), [appId]: terminalId }));
  } catch {
    // storage blocked or full -- the choice still applies while the tab is open.
  }
}
