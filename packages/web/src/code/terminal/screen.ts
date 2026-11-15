import { openInBrowser } from '../../desktop/bridge.js';

/**
 * A link in a terminal opens only if it's http or https. A program can write any
 * URL as an OSC 8 hyperlink, so `file:`, `javascript:` and app schemes are dropped
 * rather than handed to the OS.
 */
export function isOpenableLink(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Opens a terminal link in the user's browser through `openInBrowser`, never in a webview window. */
export function openTerminalLink(uri: string): void {
  if (isOpenableLink(uri)) void openInBrowser(uri).catch(() => undefined);
}

/** The xterm colours for the app's theme as it stands now (index.css's tokens, which follow `prefers-color-scheme`). */
export function terminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  const text = token('--text', '#f4f0e8');
  return {
    background: token('--bg', '#23262b'),
    foreground: text,
    cursor: text,
    selectionBackground: 'rgba(216, 155, 62, 0.35)',
  };
}

/** Calls `onChange` when the OS switches between light and dark. Returns the unsubscribe. A no-op where there's no matchMedia. */
export function onColorSchemeChange(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
