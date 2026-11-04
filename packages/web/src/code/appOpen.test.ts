import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, apps: { ...actual.api.apps, patch: vi.fn() } } };
});

import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { setAppOpen } from './appOpen.js';

const app = (over: Partial<App> = {}): App => ({
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, open: true, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.mocked(api.apps.patch).mockReset();
});

describe('setAppOpen', () => {
  it("PATCHes open and keeps the server's copy of the app, a rename from elsewhere included", async () => {
    useOtherBenchStore.setState({ apps: [app()] });
    vi.mocked(api.apps.patch).mockResolvedValue(app({ name: 'Renamed', open: false }));
    await setAppOpen('a1', false);
    expect(api.apps.patch).toHaveBeenCalledWith('a1', { open: false });
    expect(useOtherBenchStore.getState().apps).toEqual([app({ name: 'Renamed', open: false })]);
  });

  it('rejects when the PATCH fails, changing nothing', async () => {
    useOtherBenchStore.setState({ apps: [app()] });
    vi.mocked(api.apps.patch).mockRejectedValue(new Error('offline'));
    await expect(setAppOpen('a1', false)).rejects.toThrow('offline');
    expect(useOtherBenchStore.getState().apps).toEqual([app()]);
  });
});
