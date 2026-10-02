import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { desktopBootstrap, isDesktop } from './bridge.js';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  invoke.mockReset();
});

describe('desktop bridge', () => {
  it('is not desktop in a plain browser, and bootstrap resolves to null without touching Tauri', async () => {
    expect(isDesktop()).toBe(false);
    await expect(desktopBootstrap()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('inside the Tauri webview, asks the shell for the server address and token', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invoke.mockResolvedValue({ baseUrl: 'http://127.0.0.1:51234', token: 'tok' });

    expect(isDesktop()).toBe(true);
    await expect(desktopBootstrap()).resolves.toEqual({ baseUrl: 'http://127.0.0.1:51234', token: 'tok' });
    expect(invoke).toHaveBeenCalledWith('bootstrap');
  });
});
