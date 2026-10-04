import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const listen = vi.fn();
const isEnabled = vi.fn();
const enable = vi.fn();
const disable = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ isEnabled, enable, disable }));
const isFocused = vi.fn();
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ isFocused }) }));
const openDialog = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openDialog }));

import {
  autostart,
  desktopBootstrap,
  hideQuick,
  isDesktop,
  isMainWindowFocused,
  isQuickView,
  launchArgs,
  onDesktopEvent,
  openChatInMain,
  pickFolder,
  setHotkey,
  setTrayStatus,
  showNotification,
} from './bridge.js';

function enterDesktop() {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  vi.resetAllMocks();
});

describe('desktop bridge', () => {
  it('is not desktop in a plain browser, and bootstrap resolves to null without touching Tauri', async () => {
    expect(isDesktop()).toBe(false);
    await expect(desktopBootstrap()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('inside the Tauri webview, asks the shell for the server address and token', async () => {
    enterDesktop();
    invoke.mockResolvedValue({ baseUrl: 'http://127.0.0.1:51234', token: 'tok' });

    expect(isDesktop()).toBe(true);
    await expect(desktopBootstrap()).resolves.toEqual({ baseUrl: 'http://127.0.0.1:51234', token: 'tok' });
    expect(invoke).toHaveBeenCalledWith('bootstrap');
  });

  it('quick-chat commands go to the shell in the desktop app and do nothing in a browser', async () => {
    await setHotkey('Ctrl+Alt+G');
    await hideQuick();
    await openChatInMain('c1');
    expect(invoke).not.toHaveBeenCalled();

    enterDesktop();
    invoke.mockResolvedValue(undefined);
    await setHotkey('Ctrl+Alt+G');
    await hideQuick();
    await openChatInMain('c1');
    expect(invoke.mock.calls).toEqual([['set_hotkey', { accelerator: 'Ctrl+Alt+G' }], ['hide_quick'], ['open_chat', { chatId: 'c1' }]]);
  });

  it('isQuickView reads view=quick from the URL, or the quick window\'s label', () => {
    expect(isQuickView()).toBe(false);
    window.history.replaceState({}, '', '/?view=quick');
    expect(isQuickView()).toBe(true);
    window.history.replaceState({}, '', '/');

    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = { metadata: { currentWindow: { label: 'main' } } };
    expect(isQuickView()).toBe(false);
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = { metadata: { currentWindow: { label: 'quick' } } };
    expect(isQuickView()).toBe(true);
  });

  it('pickFolder and launchArgs do nothing in a browser', async () => {
    await expect(pickFolder()).resolves.toBeNull();
    await expect(launchArgs()).resolves.toEqual([]);
    expect(openDialog).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('pickFolder opens the native folder dialog and returns the path, or null when cancelled', async () => {
    enterDesktop();
    openDialog.mockResolvedValueOnce('E:\\Work');
    await expect(pickFolder()).resolves.toBe('E:\\Work');
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
    openDialog.mockResolvedValueOnce(null);
    await expect(pickFolder()).resolves.toBeNull();
  });

  it("launchArgs asks the shell for this launch's arguments", async () => {
    enterDesktop();
    invoke.mockResolvedValue(['grunt.exe', '--send', 'a.png']);
    await expect(launchArgs()).resolves.toEqual(['grunt.exe', '--send', 'a.png']);
    expect(invoke).toHaveBeenCalledWith('launch_args');
  });

  it('in a browser the window counts as focused and notifications do nothing', async () => {
    await expect(isMainWindowFocused()).resolves.toBe(true);
    await showNotification('t', 'b');
    expect(isFocused).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('in the desktop app asks the window for focus, and shows a notification through the shell with its chat', async () => {
    enterDesktop();
    isFocused.mockResolvedValue(false);
    await expect(isMainWindowFocused()).resolves.toBe(false);

    invoke.mockResolvedValue(undefined);
    await showNotification('Trip', 'Reply finished', 'c1');
    expect(invoke).toHaveBeenCalledWith('show_notification', { title: 'Trip', body: 'Reply finished', chatId: 'c1' });
  });

  it('setTrayStatus sends the pending-approval count to the shell, and does nothing in a browser', async () => {
    await setTrayStatus(2);
    expect(invoke).not.toHaveBeenCalled();

    enterDesktop();
    invoke.mockResolvedValue(undefined);
    await setTrayStatus(2);
    expect(invoke).toHaveBeenCalledWith('set_tray_status', { pendingApprovals: 2 });
  });

  it('onDesktopEvent is a no-op subscription in a browser', async () => {
    const off = await onDesktopEvent('tray-new-chat', vi.fn());

    expect(listen).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it('onDesktopEvent subscribes through Tauri and hands back its unlisten', async () => {
    enterDesktop();
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const cb = vi.fn();

    const off = await onDesktopEvent('open-args', cb);
    const handler = listen.mock.calls[0]![1] as (event: { payload: unknown }) => void;
    handler({ payload: ['grunt.exe', '--send', 'a.png'] });
    off();

    expect(listen.mock.calls[0]![0]).toBe('open-args');
    expect(cb).toHaveBeenCalledWith(['grunt.exe', '--send', 'a.png']);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('autostart wraps the plugin', async () => {
    enterDesktop();
    isEnabled.mockResolvedValue(true);

    await expect(autostart.isEnabled()).resolves.toBe(true);
    await autostart.set(false);
    await autostart.set(true);

    expect(disable).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledTimes(1);
  });
});
