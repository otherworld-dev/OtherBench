import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const listen = vi.fn();
const isEnabled = vi.fn();
const enable = vi.fn();
const disable = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ isEnabled, enable, disable }));

import { autostart, desktopBootstrap, isDesktop, onDesktopEvent } from './bridge.js';

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

    const off = await onDesktopEvent('tray-new-chat', cb);
    const handler = listen.mock.calls[0]![1] as () => void;
    handler();
    off();

    expect(listen.mock.calls[0]![0]).toBe('tray-new-chat');
    expect(cb).toHaveBeenCalledTimes(1);
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
