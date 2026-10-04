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

/** Tells the shell how many tool calls are waiting for approval; its tray tooltip shows it. No-op in a browser. */
export async function setTrayStatus(pendingApprovals: number): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_tray_status', { pendingApprovals });
}

/** Whether the main window has focus. Always true in a browser, where Grunt never notifies. */
export async function isMainWindowFocused(): Promise<boolean> {
  if (!isDesktop()) return true;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().isFocused();
}

/** Shows a desktop notification, asking for permission the first time if the OS wants that. No-op in a browser. */
export async function showNotification(title: string, body: string): Promise<void> {
  if (!isDesktop()) return;
  const plugin = await import('@tauri-apps/plugin-notification');
  let granted = await plugin.isPermissionGranted();
  if (!granted) granted = (await plugin.requestPermission()) === 'granted';
  if (granted) plugin.sendNotification({ title, body });
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
