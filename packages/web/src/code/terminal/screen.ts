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
  const text = token('--text', '#e6e6e6');
  return {
    background: token('--bg', '#101114'),
    foreground: text,
    cursor: text,
    selectionBackground: 'rgba(120, 160, 255, 0.35)',
  };
}

/** Calls `onChange` when the OS switches between light and dark. Returns the unsubscribe. A no-op where there's no matchMedia. */
export function onColorSchemeChange(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
