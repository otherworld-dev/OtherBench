import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { AppEvent, AppEventsHello } from '@otherbench/core/types/events.js';
import { api } from './api.js';
import { onAppEvent, onAppEventsHello } from './appEventListeners.js';
import { refreshMachines } from './machines.js';
import { useOtherBenchStore } from './store.js';
import { refreshAfterSync, useAppEvents } from './useAppEvents.js';

/** The SSE client's options, captured so a test can deliver a hello as a (re)connect would, or an event. */
const sse = vi.hoisted(() => ({ onHello: null as ((hello: AppEventsHello) => void) | null, onEvent: null as ((event: AppEvent) => void) | null }));
vi.mock('./sse.js', () => ({
  SseClient: class {
    constructor(opts: { onHello: (hello: AppEventsHello) => void; onEvent: (event: AppEvent) => void }) {
      sse.onHello = opts.onHello;
      sse.onEvent = opts.onEvent;
    }
    connect(): void {}
    close(): void {}
  },
}));
vi.mock('./machines.js', () => ({ refreshMachines: vi.fn() }));

const app: App = { id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, open: true, sortOrder: 0, createdAt: 1, updatedAt: 1 };

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

  it('a hello also tells the hello listeners (the Inspector re-reads MCP, grants and audit)', () => {
    let hellos = 0;
    const off = onAppEventsHello(() => hellos++);
    renderHook(() => useAppEvents());
    sse.onHello!({ pendingApprovals: [], runningTurns: [] });
    sse.onHello!({ pendingApprovals: [], runningTurns: [] });
    expect(hellos).toBe(2);
    off();
  });

  it("a hello re-reads paired machines' activity, as a peer-activity may have been missed while disconnected", () => {
    renderHook(() => useAppEvents());
    vi.mocked(refreshMachines).mockClear();
    sse.onHello!({ pendingApprovals: [], runningTurns: [] });
    expect(refreshMachines).toHaveBeenCalledTimes(1);
    sse.onEvent!({ type: 'peer-activity', nodeId: 'node-pc' });
    expect(refreshMachines).toHaveBeenCalledTimes(2);
  });

  describe('apps-changed', () => {
    const folder = { id: 'f1', name: 'Work', sortOrder: 0, createdAt: 1, updatedAt: 1 };

    afterEach(() => {
      vi.restoreAllMocks();
      useOtherBenchStore.getState().setApps([]);
      useOtherBenchStore.getState().setAppFolders([]);
    });

    it('an app made in another window shows here, with its folders, so Move to app… lists it', async () => {
      vi.spyOn(api.apps, 'list').mockResolvedValue([app]);
      vi.spyOn(api.appFolders, 'list').mockResolvedValue([folder]);
      renderHook(() => useAppEvents());

      sse.onEvent!({ type: 'apps-changed' });

      await vi.waitFor(() => expect(useOtherBenchStore.getState().apps).toEqual([app]));
      expect(useOtherBenchStore.getState().appFolders).toEqual([folder]);
    });

    it('a burst while a read is out sends one more read, which has the last of them', async () => {
      const reads: ((apps: App[]) => void)[] = [];
      const list = vi.spyOn(api.apps, 'list').mockImplementation(() => new Promise((resolve) => reads.push(resolve)));
      vi.spyOn(api.appFolders, 'list').mockResolvedValue([]);
      renderHook(() => useAppEvents());

      sse.onEvent!({ type: 'apps-changed' });
      sse.onEvent!({ type: 'apps-changed' });
      sse.onEvent!({ type: 'apps-changed' });
      expect(list).toHaveBeenCalledTimes(1);

      reads[0]!([]);
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      reads[1]!([app]);
      await vi.waitFor(() => expect(useOtherBenchStore.getState().apps).toEqual([app]));
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('a failed read is logged and the next event reads again', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const list = vi.spyOn(api.apps, 'list').mockRejectedValueOnce(new Error('down')).mockResolvedValue([app]);
      vi.spyOn(api.appFolders, 'list').mockResolvedValue([]);
      renderHook(() => useAppEvents());

      sse.onEvent!({ type: 'apps-changed' });
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));

      await vi.waitFor(() => {
        sse.onEvent!({ type: 'apps-changed' });
        expect(useOtherBenchStore.getState().apps).toEqual([app]);
      });
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
