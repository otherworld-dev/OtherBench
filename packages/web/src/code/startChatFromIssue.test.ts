import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import type { IssueDetail } from '@otherbench/core/types/code.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: { ...actual.api, chats: { ...actual.api.chats, create: vi.fn() }, turns: { ...actual.api.turns, create: vi.fn() }, notes: { ...actual.api.notes, send: vi.fn() } },
  };
});

import { api } from '../state/api.js';
import { useFeatures } from '../state/features.js';
import { useOtherBenchStore } from '../state/store.js';
import { startChatFromIssue } from './startChatFromIssue.js';

const app: App = { id: 'a1', name: 'OtherBench', workspace: null, githubRepo: 'otherworld-dev/OtherBench', linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, open: true, sortOrder: 0, createdAt: 1, updatedAt: 1 };
const issue: IssueDetail = {
  number: 48, title: 'MCP tools vanish on reconnect', state: 'open', author: 'adam', labels: [], comments: 0, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z',
  url: 'https://github.com/otherworld-dev/OtherBench/issues/48', body: 'After a reconnect the tools are gone.', commentList: [],
};
const created: Chat = {
  id: 'c9', title: '#48 MCP tools vanish on reconnect', profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId: 'a1', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ apps: [app], appsLoaded: true });
  vi.mocked(api.chats.create).mockResolvedValue(created);
  useFeatures.setState({ deckStartCommand: '', issueStartCommand: '' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('startChatFromIssue', () => {
  it('creates a chat in the app titled after the issue, opens it, and fills its box without sending', async () => {
    await startChatFromIssue(app, issue);
    expect(api.chats.create).toHaveBeenCalledWith({ appId: 'a1', title: '#48 MCP tools vanish on reconnect' });
    const state = useOtherBenchStore.getState();
    expect(state.chats.map((c) => c.id)).toEqual(['c9']);
    expect(state.activeChatId).toBe('c9');
    expect(state.mode).toBe('code');
    const draft = state.composerPrefills['c9'];
    expect(draft).toBe('#48 MCP tools vanish on reconnect\nhttps://github.com/otherworld-dev/OtherBench/issues/48\n\nAfter a reconnect the tools are gone.');
    expect(draft).toContain('#48 MCP tools vanish');
    expect(api.turns.create).not.toHaveBeenCalled();
    expect(api.notes.send).not.toHaveBeenCalled();
  });

  it("opens the new chat's Issues view on the issue, already loaded", async () => {
    await startChatFromIssue(app, issue);
    const state = useOtherBenchStore.getState();
    expect(state.issueViews['c9']).toEqual({ state: 'open', selected: 48 });
    expect(state.issueDetails['a1#48']).toEqual(issue);
  });

  it("with onList, opens the new chat's Issues view on the list", async () => {
    await startChatFromIssue(app, issue, { onList: true });
    const state = useOtherBenchStore.getState();
    expect(state.activeChatId).toBe('c9');
    expect(state.issueViews['c9']).toEqual({ state: 'open', selected: null });
  });

  it('an issue with no body leaves just the number, title and URL', async () => {
    await startChatFromIssue(app, { ...issue, body: '   ' });
    expect(useOtherBenchStore.getState().composerPrefills['c9']).toBe('#48 MCP tools vanish on reconnect\nhttps://github.com/otherworld-dev/OtherBench/issues/48');
  });

  it('with an issue start command set, sends it at once with the issue ref and leaves the box empty', async () => {
    useFeatures.setState({ issueStartCommand: '/start {issue}' });
    vi.mocked(api.turns.create).mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: [] });
    await startChatFromIssue(app, issue);
    expect(api.turns.create).toHaveBeenCalledWith('c9', { parentId: null, parts: [{ type: 'text', text: '/start #48' }], profileIds: ['prof'] });
    const state = useOtherBenchStore.getState();
    expect(state.activeChatId).toBe('c9');
    expect(state.composerPrefills['c9']).toBeUndefined();
    expect(state.issueViews['c9']).toEqual({ state: 'open', selected: 48 });
  });

  it("a Deck start command doesn't send for an issue", async () => {
    useFeatures.setState({ deckStartCommand: '/start {card}' });
    await startChatFromIssue(app, issue);
    expect(api.turns.create).not.toHaveBeenCalled();
    expect(useOtherBenchStore.getState().composerPrefills['c9']).toContain('#48 MCP tools vanish');
  });

  it('a failed create opens nothing and rejects', async () => {
    vi.mocked(api.chats.create).mockRejectedValue(new Error('nope'));
    await expect(startChatFromIssue(app, issue)).rejects.toThrow('nope');
    expect(useOtherBenchStore.getState().chats).toEqual([]);
    expect(useOtherBenchStore.getState().composerPrefills).toEqual({});
    expect(useOtherBenchStore.getState().issueViews).toEqual({});
  });
});
