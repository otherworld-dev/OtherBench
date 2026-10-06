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
export async function onDesktopEvent<T = unknown>(name: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(name, (event) => cb(event.payload));
}

/** Opens the native folder picker. The chosen absolute path, or null if cancelled or outside the desktop app. */
export async function pickFolder(title = 'Choose a workspace folder'): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === 'string' ? picked : null;
}

/** The arguments the desktop app was launched with, once; empty afterwards and in a browser. */
export async function launchArgs(): Promise<string[]> {
  if (!isDesktop()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[]>('launch_args');
}

/**
 * Tells the shell how many tool calls are waiting for approval (its tray
 * tooltip shows it) and each paired machine's status line (its tray menu
 * shows them). No-op in a browser.
 */
export async function setTrayStatus(pendingApprovals: number, machines: string[] = []): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_tray_status', { pendingApprovals, machines });
}

/** Whether the main window has focus. Always true in a browser, where Grunt never notifies. */
export async function isMainWindowFocused(): Promise<boolean> {
  if (!isDesktop()) return true;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().isFocused();
}

/**
 * Shows a desktop notification through the shell (desktop/src-tauri/src/notify.rs).
 * On Windows clicking it opens `chatId` in the main window. No-op in a browser.
 */
export async function showNotification(title: string, body: string, chatId: string | null = null): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_notification', { title, body, chatId });
}

/** Makes `accelerator` the global quick-chat hotkey. Rejects with the reason (unparsable, or taken by another app). */
export async function setHotkey(accelerator: string): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_hotkey', { accelerator });
}

/** Hides the quick-chat window. */
export async function hideQuick(): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('hide_quick');
}

/** Quick chat's Expand: the main window opens `chatId` and the quick window hides. */
export async function openChatInMain(chatId: string): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_chat', { chatId });
}

/**
 * True in the quick-chat window. It loads the app with `?view=quick`; its
 * window label (`quick`, tauri.conf.json) is checked too, so the full app --
 * with its hotkey registration and notifications -- can never run there a
 * second time even if the shell dropped the query string.
 */
export function isQuickView(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('view') === 'quick') return true;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label === 'quick';
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
