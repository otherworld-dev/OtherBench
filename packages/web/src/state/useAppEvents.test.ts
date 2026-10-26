import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { AppEvent, AppEventsHello } from '@otherbench/core/types/events.js';
import { api } from './api.js';
import { onAppEvent } from './appEventListeners.js';
import { useOtherBenchStore } from './store.js';
import { refreshAfterSync, useAppEvents } from './useAppEvents.js';

/** The SSE client's options, captured so a test can deliver a hello as a (re)connect would. */
const sse = vi.hoisted(() => ({ onHello: null as ((hello: AppEventsHello) => void) | null }));
vi.mock('./sse.js', () => ({
  SseClient: class {
    constructor(opts: { onHello: (hello: AppEventsHello) => void }) {
      sse.onHello = opts.onHello;
    }
    connect(): void {}
    close(): void {}
  },
}));
vi.mock('./machines.js', () => ({ refreshMachines: vi.fn() }));

const app: App = { id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };

describe('refreshAfterSync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useOtherBenchStore.getState().setApps([]);
  });

  it('reloads the apps too, so an app made or renamed on another machine shows up (I2)', async () => {
    vi.spyOn(api.chats, 'list').mockResolvedValue([]);
    vi.spyOn(api.projects, 'list').mockResolvedValue([]);
    vi.spyOn(api.profiles, 'list').mockResolvedValue([]);
    vi.spyOn(api.connections, 'list').mockResolvedValue([]);
    vi.spyOn(api.appFolders, 'list').mockResolvedValue([]);
    const apps = vi.spyOn(api.apps, 'list').mockResolvedValue([app]);

    refreshAfterSync();

    await vi.waitFor(() => expect(useOtherBenchStore.getState().apps).toEqual([app]));
    expect(apps).toHaveBeenCalledTimes(1);
  });

  it('reloads the app folders too', async () => {
    const folder = { id: 'f1', name: 'Work', sortOrder: 0, createdAt: 1, updatedAt: 1 };
    vi.spyOn(api.chats, 'list').mockResolvedValue([]);
    vi.spyOn(api.projects, 'list').mockResolvedValue([]);
    vi.spyOn(api.profiles, 'list').mockResolvedValue([]);
    vi.spyOn(api.connections, 'list').mockResolvedValue([]);
    vi.spyOn(api.apps, 'list').mockResolvedValue([]);
    const folders = vi.spyOn(api.appFolders, 'list').mockResolvedValue([folder]);

    refreshAfterSync();

    await vi.waitFor(() => expect(useOtherBenchStore.getState().appFolders).toEqual([folder]));
    expect(folders).toHaveBeenCalledTimes(1);
    useOtherBenchStore.getState().setAppFolders([]);
  });
});

describe('useAppEvents', () => {
  afterEach(cleanup);

  it('a hello (a connect or a reconnect) tells the Overview to refetch, as events may have been missed', () => {
    const seen: AppEvent[] = [];
    const off = onAppEvent((event) => seen.push(event));
    renderHook(() => useAppEvents());
    sse.onHello!({ pendingApprovals: [{ requestId: 'r1' } as never], runningTurns: [] });
    expect(seen).toEqual([{ type: 'overview-changed' }]);
    expect(Object.keys(useOtherBenchStore.getState().appPendingApprovals)).toEqual(['r1']);
    off();
  });
});
