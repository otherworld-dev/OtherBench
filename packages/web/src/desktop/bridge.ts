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

/** This window's label in the shell (main, quick, code, overview...), if it says. */
function windowLabel(): string | undefined {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label;
}

/**
 * Subscribes to an event the shell emits (e.g. `tray-new-chat` from the
 * tray menu). Resolves to the unsubscribe function; in a browser that is a
 * no-op and nothing is ever delivered.
 *
 * Only events for this window arrive: ones sent to it and ones sent to every
 * window. Tauri's `listen` hears an event sent to any window by default, so
 * with more than one app window (an undocked Code or Overview) a request meant
 * for one would be acted on by all of them.
 */
export async function onDesktopEvent<T = unknown>(name: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const label = windowLabel();
  return listen<T>(name, (event) => cb(event.payload), label === undefined ? undefined : { target: label });
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

/** Whether this window has focus. Always true in a browser, where OtherBench never notifies. */
export async function isMainWindowFocused(): Promise<boolean> {
  if (!isDesktop()) return true;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().isFocused();
}

/**
 * Shows a desktop notification through the shell (desktop/src-tauri/src/notify.rs).
 * On Windows clicking it opens `chatId` in `window` (the main one unless the chat's
 * mode is undocked), or, with `revealPath` (a file in Downloads), shows that file
 * in Explorer. No-op in a browser.
 */
export async function showNotification(title: string, body: string, chatId: string | null = null, revealPath: string | null = null, window: 'main' | 'code' = 'main'): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_notification', { title, body, chatId, revealPath, window });
}

/**
 * Saves `blob` in the user's Downloads folder through the shell (desktop/src-tauri/src/download.rs)
 * and returns its full path; the shell picks `name (1).ext` and so on when the name is taken, and
 * refuses names Windows would run. Null in a browser, which saves downloads itself.
 */
export async function saveDownload(blob: Blob, name: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return invoke<string>('save_download', bytes, { headers: { 'x-otherbench-name': encodeURIComponent(name) } });
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
  return windowLabel() === 'quick';
}

/**
 * True in the computer-use indicator bar (desktop/src-tauri/src/computer/desktop.rs).
 * It loads the app with `?view=indicator`; its window label is checked too.
 */
export function isIndicatorView(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('view') === 'indicator') return true;
  return windowLabel() === 'computer-indicator';
}

/** The indicator bar's Stop: the shell ends computer-use control and tells the server. */
export async function stopComputerControl(): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('computer_stop');
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

/** Opens a website in the default browser (desktop), or a new tab with no link back to OtherBench in a browser. */
export async function openInBrowser(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** Shows a file selected in Explorer, never opening it. False in a browser, which can't. */
export async function revealPath(path: string): Promise<boolean> {
  if (!isDesktop()) return false;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
  return true;
}

/** Opens a folder in Explorer (desktop/src-tauri/src/folder.rs refuses anything but a folder). False in a browser, which can't. */
export async function openFolder(path: string): Promise<boolean> {
  if (!isDesktop()) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_folder', { path });
  return true;
}

/** Opens `view` in its own window (desktop/src-tauri/src/docks.rs), or brings that window forward. */
export async function undock(view: 'code' | 'overview'): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('undock', { view });
}

/** Puts `view` back in the main window: its own window closes. */
export async function dock(view: 'code' | 'overview'): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('dock', { view });
}

/** The views in windows of their own, as the shell has them; none in a browser. */
export async function undockedViews(): Promise<unknown> {
  if (!isDesktop()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<unknown>('undocked');
}

/** Brings one of the app's windows (main, code or overview) forward. */
export async function showWindow(label: 'main' | 'code' | 'overview'): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_window', { window: label });
}

/** Hands `request` to the window `label` and brings it forward; it opens there (desktop/windows.ts `OpenRequest`). */
export async function openIn(label: 'main' | 'code', request: unknown): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_in', { window: label, request });
}

/** Which of the app's windows has focus: main, code, overview, or null for none. Always main in a browser. */
export async function focusedWindow(): Promise<string | null> {
  if (!isDesktop()) return 'main';
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('focused_window');
}
