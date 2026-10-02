import type { TransportConfig } from '../state/transport.js';

/**
 * The web app's only contact point with the Tauri shell. Everything here
 * is a no-op in a plain browser, and `@tauri-apps/api` is imported lazily
 * so browser mode never loads it at all.
 */

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Asks the shell where its sidecar server is listening and which per-launch
 * token it was started with (desktop/src-tauri `bootstrap` command). `null`
 * outside the desktop app, meaning: keep the same-origin defaults.
 */
export async function desktopBootstrap(): Promise<TransportConfig | null> {
  if (!isDesktop()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<TransportConfig>('bootstrap');
}

/**
 * Subscribes to an event the shell emits (e.g. `tray-new-chat` from the
 * tray menu). Resolves to the unsubscribe function; in a browser that is a
 * no-op and nothing is ever delivered.
 */
export async function onDesktopEvent(name: string, cb: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen(name, () => cb());
}

/** Start-at-login, via the shell's autostart plugin. Only meaningful when `isDesktop()`. */
export const autostart = {
  async isEnabled(): Promise<boolean> {
    const plugin = await import('@tauri-apps/plugin-autostart');
    return plugin.isEnabled();
  },
  async set(enabled: boolean): Promise<void> {
    const plugin = await import('@tauri-apps/plugin-autostart');
    await (enabled ? plugin.enable() : plugin.disable());
  },
};
