import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ desktop: true, main: true, showNotification: vi.fn(async () => {}) }));
vi.mock('../desktop/bridge.js', () => ({ isDesktop: () => bridge.desktop, isMainAppWindow: () => bridge.main, showNotification: bridge.showNotification }));
vi.mock('./api.js', () => ({
  api: {
    addons: {
      list: vi.fn(async () => [
        { id: 'glow', name: 'Glow', version: '1', status: 'loaded', error: null, settingsPage: true },
        { id: 'bad', name: 'Bad', version: '1', status: 'failed', error: 'It failed to start: boom', settingsPage: false },
      ]),
    },
  },
}));

import { useAddonLoadNotice, useAddons } from './addons.js';

afterEach(() => {
  cleanup();
  bridge.showNotification.mockClear();
  bridge.desktop = true;
  bridge.main = true;
});

describe('add-ons in the web app', () => {
  it('useAddons gives the list the server found', async () => {
    const { result } = renderHook(() => useAddons());
    await waitFor(() => expect(result.current.map((a) => a.id)).toEqual(['glow', 'bad']));
  });

  it("notifies once for each add-on that didn't load, in the desktop app's main window", async () => {
    renderHook(() => useAddonLoadNotice());
    await waitFor(() => expect(bridge.showNotification).toHaveBeenCalledTimes(1));
    expect(bridge.showNotification).toHaveBeenCalledWith("Bad didn't load", expect.stringContaining('boom'));
  });

  it('says nothing in another window or a browser', async () => {
    bridge.main = false;
    renderHook(() => useAddonLoadNotice());
    bridge.main = true;
    bridge.desktop = false;
    renderHook(() => useAddonLoadNotice());
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.showNotification).not.toHaveBeenCalled();
  });
});
