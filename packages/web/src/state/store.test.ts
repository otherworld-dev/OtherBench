import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { Chat, Project } from '@otherbench/core/ports/store.js';
import type { Connection, ModelInfo, Profile } from '@otherbench/core/types/config.js';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import { CLIENT_ID } from '../lib/clientId.js';
import { INSPECTOR_COLLAPSED_STORAGE_KEY, loadInspectorCollapsed, selectPendingApprovalCount, useOtherBenchStore } from './store.js';

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'Local Ollama',
    kind: 'ollama',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-1',
    connectionId: 'conn-1',
    modelId: 'llama3.2',
    displayName: 'llama3.2',
    source: 'discovered',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: null,
    priceOutPer1m: null,
    priceCachedPer1m: null,
    currency: 'USD',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Default',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'llama3.2',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return { id: 'proj-1', name: 'Alpha', description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Hello',
    profileId: 'p1',
    headMessageId: null,
    workspace: null,
    runsOn: 'node-self',
    workspaceRoot: null,
    pinned: false,
    projectPinned: false,
    unread: false,
    autoMode: false,
    projectId: null,
    memoryCursor: null,
    memoryExcluded: false,
    sortOrder: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function stubAssistant(id: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id,
    chatId: 'chat-1',
    parentId: 'user-1',
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: { profileId: 'p1', profileName: 'Default', connectionId: 'c1', modelId: 'mock-standard' },
    createdAt: 0,
    ...overrides,
  };
}

function reset(): void {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
}

describe('useOtherBenchStore', () => {
  beforeEach(reset);

  it('setChats/upsertChat populate the chat list', () => {
    const chat: Chat = {
      id: 'chat-1',
      title: 'Hello',
      profileId: 'p1',
      headMessageId: null,
      workspace: null,
      runsOn: 'node-self',
      workspaceRoot: null,
      pinned: false,
      projectPinned: false,
      unread: false,
      autoMode: false,
      projectId: null,
      memoryCursor: null,
      memoryExcluded: false,
      sortOrder: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    useOtherBenchStore.getState().setChats([chat]);
    expect(useOtherBenchStore.getState().chats).toEqual([chat]);

    useOtherBenchStore.getState().upsertChat({ ...chat, title: 'Renamed' });
    expect(useOtherBenchStore.getState().chats).toHaveLength(1);
    expect(useOtherBenchStore.getState().chats[0]?.title).toBe('Renamed');
  });

  it('applyTurnEvent on a known message appends streamed text', () => {
    useOtherBenchStore.getState().registerMessage(stubAssistant('m1'));
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Hello' });
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: ' world' });

    expect(useOtherBenchStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  // Load-bearing (task 19 brief): a `text-delta` for a message id the store
  // doesn't know yet must be buffered, not silently dropped. This is a real
  // race in this design -- the SSE connection can already be open and
  // delivering events for a message before the `POST .../turns` response
  // (which is how the client normally learns the id) has even resolved.
  it('buffers a text-delta for an unknown message id instead of dropping it, then flushes it once the message is registered', () => {
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm-unknown', type: 'text-delta', text: 'early bird' });

    // Not dropped: it's sitting in pendingEvents, and no message was
    // fabricated for it.
    expect(useOtherBenchStore.getState().messages['m-unknown']).toBeUndefined();
    expect(useOtherBenchStore.getState().pendingEvents['m-unknown']).toHaveLength(1);

    // Once the message becomes known (e.g. the turn-creation response
    // arrives), the buffered event is folded in immediately.
    useOtherBenchStore.getState().registerMessage(stubAssistant('m-unknown'));

    expect(useOtherBenchStore.getState().messages['m-unknown']?.parts).toEqual([{ type: 'text', text: 'early bird' }]);
    expect(useOtherBenchStore.getState().pendingEvents['m-unknown']).toBeUndefined();
  });

  it('buffers events for several unknown messages independently', () => {
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'a', type: 'text-delta', text: 'A' });
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'b', type: 'text-delta', text: 'B' });
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'a', type: 'text-delta', text: '1' });

    expect(useOtherBenchStore.getState().pendingEvents['a']).toHaveLength(2);
    expect(useOtherBenchStore.getState().pendingEvents['b']).toHaveLength(1);
  });

  // Load-bearing (task 19 brief): reconnecting and replaying the `hello`
  // snapshot must not duplicate text already applied from the live feed
  // before the disconnect. StreamRegistry's buffer is "everything since the
  // turn started", not "everything since you last saw", so naively
  // appending the hello replay on top of current state would double it.
  it('reconnect replay via applyHello does not duplicate text already streamed live', () => {
    useOtherBenchStore.getState().registerMessage(stubAssistant('m1'));
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Hello' });
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: ' world' });
    expect(useOtherBenchStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);

    // Simulate a drop + reconnect: the server's hello snapshot replays the
    // FULL buffer for this message, which happens to be exactly the two
    // deltas already applied above.
    useOtherBenchStore.getState().applyHello([
      {
        messageId: 'm1',
        status: 'streaming',
        events: [
          { messageId: 'm1', type: 'text-delta', text: 'Hello' },
          { messageId: 'm1', type: 'text-delta', text: ' world' },
        ],
      },
    ]);

    expect(useOtherBenchStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('applyHello for a message not yet known replaces (not appends to) its pending buffer', () => {
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm2', type: 'text-delta', text: 'partial-from-live' });

    useOtherBenchStore.getState().applyHello([
      {
        messageId: 'm2',
        status: 'streaming',
        events: [{ messageId: 'm2', type: 'text-delta', text: 'full-from-hello' }],
      },
    ]);
    useOtherBenchStore.getState().registerMessage(stubAssistant('m2'));

    expect(useOtherBenchStore.getState().messages['m2']?.parts).toEqual([{ type: 'text', text: 'full-from-hello' }]);
  });

  it('applyHello on a known message also updates its authoritative status', () => {
    useOtherBenchStore.getState().registerMessage(stubAssistant('m1'));
    useOtherBenchStore.getState().applyHello([{ messageId: 'm1', status: 'complete', events: [] }]);
    expect(useOtherBenchStore.getState().messages['m1']?.status).toBe('complete');
  });

  it('registerMessage does not clobber an already-known message', () => {
    useOtherBenchStore.getState().registerMessage(stubAssistant('m1'));
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'live text' });
    // A redundant registration (e.g. a stale bulk hydrate racing the live
    // stream) must not overwrite the further-along live state.
    useOtherBenchStore.getState().registerMessage(stubAssistant('m1'));
    expect(useOtherBenchStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'live text' }]);
  });

  it('resetMessageForRetry clears parts/error and re-arms status so a retried stream starts clean', () => {
    useOtherBenchStore.getState().registerMessage(
      stubAssistant('m1', {
        status: 'error',
        parts: [{ type: 'text', text: 'partial before failing' }],
        error: { kind: 'rate_limit', message: 'boom', retryable: true },
      })
    );
    useOtherBenchStore.getState().applyTurnEvent({
      messageId: 'm1',
      type: 'finish',
      usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 },
      finishReason: 'stop',
    });
    expect(useOtherBenchStore.getState().extras['m1']?.usage).not.toBeNull();

    useOtherBenchStore.getState().resetMessageForRetry('m1');

    expect(useOtherBenchStore.getState().messages['m1']).toMatchObject({ status: 'streaming', error: null, parts: [] });
    expect(useOtherBenchStore.getState().extras['m1']?.usage).toBeNull();

    // A delta after the reset builds on the clean slate, not the old failed text.
    useOtherBenchStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Second attempt' });
    expect(useOtherBenchStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Second attempt' }]);
  });

  it('resetMessageForRetry is a no-op for a message the store does not know', () => {
    useOtherBenchStore.getState().resetMessageForRetry('unknown');
    expect(useOtherBenchStore.getState().messages['unknown']).toBeUndefined();
  });

  it('setHeadMessageId updates the chat entry in place', () => {
    const chat: Chat = {
      id: 'chat-1',
      title: 'Hello',
      profileId: 'p1',
      headMessageId: null,
      workspace: null,
      runsOn: 'node-self',
      workspaceRoot: null,
      pinned: false,
      projectPinned: false,
      unread: false,
      autoMode: false,
      projectId: null,
      memoryCursor: null,
      memoryExcluded: false,
      sortOrder: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    useOtherBenchStore.getState().setChats([chat]);
    useOtherBenchStore.getState().setHeadMessageId('chat-1', 'm1');
    expect(useOtherBenchStore.getState().chats[0]?.headMessageId).toBe('m1');
  });

  it('upsertConnection inserts a new connection and replaces an existing one by id', () => {
    useOtherBenchStore.getState().setConnections([makeConnection()]);
    useOtherBenchStore.getState().upsertConnection(makeConnection({ name: 'Renamed' }));
    expect(useOtherBenchStore.getState().connections).toHaveLength(1);
    expect(useOtherBenchStore.getState().connections[0]?.name).toBe('Renamed');

    useOtherBenchStore.getState().upsertConnection(makeConnection({ id: 'conn-2', name: 'Second' }));
    expect(useOtherBenchStore.getState().connections).toHaveLength(2);
  });

  // Load-bearing: the database cascades a connection delete onto its models
  // and profiles (ON DELETE CASCADE, migrations/001-initial.ts) -- local
  // state must mirror that or the Settings UI keeps showing rows the server
  // just deleted.
  it('removeConnection also drops every model and profile that referenced it, mirroring the DB cascade', () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'conn-1' }), makeConnection({ id: 'conn-2' })]);
    useOtherBenchStore.getState().setModels([makeModel({ id: 'm1', connectionId: 'conn-1' }), makeModel({ id: 'm2', connectionId: 'conn-2' })]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p1', connectionId: 'conn-1' }), makeProfile({ id: 'p2', connectionId: 'conn-2' })]);

    useOtherBenchStore.getState().removeConnection('conn-1');

    expect(useOtherBenchStore.getState().connections.map((c) => c.id)).toEqual(['conn-2']);
    expect(useOtherBenchStore.getState().models.map((m) => m.id)).toEqual(['m2']);
    expect(useOtherBenchStore.getState().profiles.map((p) => p.id)).toEqual(['p2']);
  });

  // Load-bearing (Finding 5): the DB cascade goes connection -> profile ->
  // chat, but the previous removeConnection only mirrored the first hop.
  // Left as-is, a chat built on a deleted connection's profile stayed in
  // `chats` and, if it was the active one, stayed selected -- a dead
  // composer still offering Send, and the Inspector polling
  // /grants and /audit for an id the server would now 404 on forever.
  it('removeConnection also drops every chat built on one of its profiles, and clears activeChatId if the active chat was one of them', () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'conn-1' }), makeConnection({ id: 'conn-2' })]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p1', connectionId: 'conn-1' }), makeProfile({ id: 'p2', connectionId: 'conn-2' })]);
    useOtherBenchStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useOtherBenchStore.getState().setActiveChatId('chat-1');

    useOtherBenchStore.getState().removeConnection('conn-1');

    expect(useOtherBenchStore.getState().chats.map((c) => c.id)).toEqual(['chat-2']);
    expect(useOtherBenchStore.getState().activeChatId).toBeNull();
  });

  it('removeConnection leaves activeChatId alone when the active chat survives (not built on the deleted connection)', () => {
    useOtherBenchStore.getState().setConnections([makeConnection({ id: 'conn-1' }), makeConnection({ id: 'conn-2' })]);
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p1', connectionId: 'conn-1' }), makeProfile({ id: 'p2', connectionId: 'conn-2' })]);
    useOtherBenchStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useOtherBenchStore.getState().setActiveChatId('chat-2');

    useOtherBenchStore.getState().removeConnection('conn-1');

    expect(useOtherBenchStore.getState().chats.map((c) => c.id)).toEqual(['chat-2']);
    expect(useOtherBenchStore.getState().activeChatId).toBe('chat-2');
  });

  it('upsertModel inserts a new model and replaces an existing one by id', () => {
    useOtherBenchStore.getState().setModels([makeModel()]);
    useOtherBenchStore.getState().upsertModel(makeModel({ supportsTools: true }));
    expect(useOtherBenchStore.getState().models).toHaveLength(1);
    expect(useOtherBenchStore.getState().models[0]?.supportsTools).toBe(true);

    useOtherBenchStore.getState().upsertModel(makeModel({ id: 'model-2' }));
    expect(useOtherBenchStore.getState().models).toHaveLength(2);
  });

  it('upsertModels folds a batch of discovered models in, inserting new ids and replacing known ones', () => {
    useOtherBenchStore.getState().setModels([makeModel({ id: 'm1', displayName: 'Old name' })]);
    useOtherBenchStore.getState().upsertModels([makeModel({ id: 'm1', displayName: 'New name' }), makeModel({ id: 'm2' })]);

    const models = useOtherBenchStore.getState().models;
    expect(models).toHaveLength(2);
    expect(models.find((m) => m.id === 'm1')?.displayName).toBe('New name');
  });

  it('upsertProfile inserts a new profile and replaces an existing one by id', () => {
    useOtherBenchStore.getState().setProfiles([makeProfile()]);
    useOtherBenchStore.getState().upsertProfile(makeProfile({ name: 'Renamed profile' }));
    expect(useOtherBenchStore.getState().profiles).toHaveLength(1);
    expect(useOtherBenchStore.getState().profiles[0]?.name).toBe('Renamed profile');

    useOtherBenchStore.getState().upsertProfile(makeProfile({ id: 'profile-2' }));
    expect(useOtherBenchStore.getState().profiles).toHaveLength(2);
  });

  it('removeProfile drops just that profile', () => {
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p1' }), makeProfile({ id: 'p2' })]);
    useOtherBenchStore.getState().removeProfile('p1');
    expect(useOtherBenchStore.getState().profiles.map((p) => p.id)).toEqual(['p2']);
  });

  // Load-bearing (Finding 5): same gap as removeConnection above, one hop
  // shorter -- deleting a profile directly (not via its connection) must
  // also drop every chat built on it and clear activeChatId if needed.
  it('removeProfile also drops every chat built on it, and clears activeChatId if the active chat was one of them', () => {
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p1' }), makeProfile({ id: 'p2' })]);
    useOtherBenchStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useOtherBenchStore.getState().setActiveChatId('chat-1');

    useOtherBenchStore.getState().removeProfile('p1');

    expect(useOtherBenchStore.getState().chats.map((c) => c.id)).toEqual(['chat-2']);
    expect(useOtherBenchStore.getState().activeChatId).toBeNull();
  });

  it('removeProfile leaves activeChatId alone when the active chat survives', () => {
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p1' }), makeProfile({ id: 'p2' })]);
    useOtherBenchStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useOtherBenchStore.getState().setActiveChatId('chat-2');

    useOtherBenchStore.getState().removeProfile('p1');

    expect(useOtherBenchStore.getState().activeChatId).toBe('chat-2');
  });

  it('setProjects/upsertProject populate the project list, replacing by id', () => {
    useOtherBenchStore.getState().setProjects([makeProject()]);
    useOtherBenchStore.getState().upsertProject(makeProject({ name: 'Renamed' }));
    useOtherBenchStore.getState().upsertProject(makeProject({ id: 'proj-2' }));

    expect(useOtherBenchStore.getState().projects.map((p) => [p.id, p.name])).toEqual([
      ['proj-1', 'Renamed'],
      ['proj-2', 'Alpha'],
    ]);
  });

  it('removeProject drops the project and moves its chats to no project in the same update, keeping them', () => {
    useOtherBenchStore.getState().setProjects([makeProject(), makeProject({ id: 'proj-2' })]);
    useOtherBenchStore.getState().setChats([
      makeChat({ id: 'a', projectId: 'proj-1', workspaceRoot: '/ws' }),
      makeChat({ id: 'b', projectId: 'proj-2' }),
    ]);

    useOtherBenchStore.getState().removeProject('proj-1');

    const state = useOtherBenchStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['proj-2']);
    expect(state.chats.map((c) => [c.id, c.projectId, c.workspaceRoot])).toEqual([
      ['a', null, '/ws'],
      ['b', 'proj-2', null],
    ]);
  });

  it('a removed or archived profile stops being any project default, mirroring the server', () => {
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p-a' }), makeProfile({ id: 'p-b' })]);
    useOtherBenchStore.getState().setProjects([
      makeProject({ id: 'x', defaultProfileId: 'p-a' }),
      makeProject({ id: 'y', defaultProfileId: 'p-b' }),
    ]);

    useOtherBenchStore.getState().upsertProfile(makeProfile({ id: 'p-a', archivedAt: 5 }));
    expect(useOtherBenchStore.getState().projects.map((p) => p.defaultProfileId)).toEqual([null, 'p-b']);

    useOtherBenchStore.getState().removeProfile('p-b');
    expect(useOtherBenchStore.getState().projects.map((p) => p.defaultProfileId)).toEqual([null, null]);
  });

  it('removeConnection clears project defaults that pointed at its profiles', () => {
    useOtherBenchStore.getState().setProfiles([makeProfile({ id: 'p-a', connectionId: 'conn-1' })]);
    useOtherBenchStore.getState().setProjects([makeProject({ defaultProfileId: 'p-a' })]);

    useOtherBenchStore.getState().removeConnection('conn-1');

    expect(useOtherBenchStore.getState().projects[0]!.defaultProfileId).toBeNull();
  });
});

describe('app-wide events (Task 34)', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));

  it('chat-created adds a chat, chat-updated replaces it, chat-deleted removes it and clears it if active', () => {
    const s = () => useOtherBenchStore.getState();
    s().setChats([makeChat({ id: 'a', title: 'A' })]);
    s().applyAppEvent({ type: 'chat-created', chat: makeChat({ id: 'b', title: 'B' }) });
    expect(s().chats.map((c) => c.id)).toEqual(['a', 'b']);

    s().applyAppEvent({ type: 'chat-updated', chat: makeChat({ id: 'a', title: 'Renamed elsewhere' }) });
    expect(s().chats.find((c) => c.id === 'a')!.title).toBe('Renamed elsewhere');

    s().setActiveChatId('b');
    s().applyAppEvent({ type: 'chat-deleted', chatId: 'b' });
    expect(s().chats.map((c) => c.id)).toEqual(['a']);
    expect(s().activeChatId).toBeNull();
  });

  it('counts pending approvals from the hello and events, dropping them on resolve or when their turn ends', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyAppHello({ pendingApprovals: [{ chatId: 'c', messageId: 'm1', requestId: 'r1', toolName: 'write_file' }], runningTurns: [] });
    expect(selectPendingApprovalCount(s())).toBe(1);
    s().applyAppEvent({ type: 'approval-requested', chatId: 'c', messageId: 'm2', requestId: 'r2', toolName: 'run_command' });
    s().applyAppEvent({ type: 'approval-requested', chatId: 'c', messageId: 'm2', requestId: 'r3', toolName: 'run_command' });
    expect(selectPendingApprovalCount(s())).toBe(3);
    s().applyAppEvent({ type: 'approval-resolved', chatId: 'c', requestId: 'r1' });
    s().applyAppEvent({ type: 'turn-finished', chatId: 'c', messageId: 'm2', status: 'cancelled' });
    expect(selectPendingApprovalCount(s())).toBe(0);
    // A reconnect's hello replaces whatever was there.
    s().applyAppEvent({ type: 'approval-requested', chatId: 'c', messageId: 'm9', requestId: 'r9', toolName: 'x' });
    s().applyAppHello({ pendingApprovals: [], runningTurns: [] });
    expect(selectPendingApprovalCount(s())).toBe(0);
  });

  it('bumps the schedules version on each schedule event, and opens and closes the Scheduled overlay', () => {
    const s = () => useOtherBenchStore.getState();
    expect(s().schedulesVersion).toBe(0);
    s().applyAppEvent({ type: 'schedules-changed' });
    s().applyAppEvent({ type: 'schedule-run-started', scheduleId: 's', scheduleName: 'S', runId: 'r', chatId: 'c', messageId: 'm' });
    s().applyAppEvent({ type: 'schedule-run-finished', scheduleId: 's', scheduleName: 'S', runId: 'r', chatId: 'c', messageId: 'm', status: 'complete', detail: null });
    expect(s().schedulesVersion).toBe(3);

    expect(s().schedulesPage).toBeNull();
    s().openSchedules({ kind: 'chat', chatId: 'c' });
    expect(s().schedulesPage).toEqual({ prefill: { kind: 'chat', chatId: 'c' } });
    s().openSchedules();
    expect(s().schedulesPage).toEqual({});
    s().closeSchedules();
    expect(s().schedulesPage).toBeNull();
  });
});

describe('chats controlling the computer (computer use)', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));

  it('keeps the chats controlling the computer from the hello and from computer-session events', () => {
    const s = () => useOtherBenchStore.getState();
    expect(s().computerSessions).toEqual({});
    s().applyAppHello({ pendingApprovals: [], runningTurns: [], computerSessions: [{ chatId: 'c1', lastAction: 'click at 3, 4' }] });
    expect(s().computerSessions).toEqual({ c1: { lastAction: 'click at 3, 4' } });
    s().applyAppEvent({ type: 'computer-session', chatId: 'c2', active: true });
    expect(s().computerSessions['c2']).toEqual({});
    s().applyAppEvent({ type: 'computer-session', chatId: 'c2', active: true, lastAction: 'click at 1, 2' });
    expect(s().computerSessions['c2']).toEqual({ lastAction: 'click at 1, 2' });
    // An event with no lastAction keeps the last one.
    s().applyAppEvent({ type: 'computer-session', chatId: 'c2', active: true });
    expect(s().computerSessions['c2']).toEqual({ lastAction: 'click at 1, 2' });
    s().applyAppEvent({ type: 'computer-session', chatId: 'c1', active: false });
    expect(Object.keys(s().computerSessions)).toEqual(['c2']);
  });

  it('keeps the chats with background tasks from the hello and from background-tasks events', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyAppHello({ pendingApprovals: [], runningTurns: [], backgroundChats: [{ chatId: 'c1', count: 2 }] });
    expect(s().appBackgroundChats).toEqual({ c1: 2 });
    s().applyAppEvent({ type: 'background-tasks', chatId: 'c2', count: 1 });
    s().applyAppEvent({ type: 'background-tasks', chatId: 'c1', count: 0 });
    expect(s().appBackgroundChats).toEqual({ c2: 1 });
    // An older server's hello has none: nothing is left marked.
    s().applyAppHello({ pendingApprovals: [], runningTurns: [] });
    expect(s().appBackgroundChats).toEqual({});
  });

  it('a hello replaces the set, and one with no computerSessions (an older server) clears it', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyAppEvent({ type: 'computer-session', chatId: 'c1', active: true, lastAction: 'press ctrl+s' });
    s().applyAppHello({ pendingApprovals: [], runningTurns: [], computerSessions: [{ chatId: 'c3' }] });
    expect(s().computerSessions).toEqual({ c3: {} });
    s().applyAppHello({ pendingApprovals: [], runningTurns: [] });
    expect(s().computerSessions).toEqual({});
  });

  it('keeps no lastAction that is not a string', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyAppEvent({ type: 'computer-session', chatId: 'c1', active: true, lastAction: { text: 'x' } as unknown as string });
    expect(s().computerSessions['c1']).toEqual({});
  });
});

describe('running replies from app-wide events (#824)', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));

  it('tracks replies from turn-started to turn-finished, and a hello replaces the set', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyAppEvent({ type: 'turn-started', chatId: 'c1', messageIds: ['m1', 'm2'] });
    expect(s().appRunningTurns).toEqual({ m1: 'c1', m2: 'c1' });
    s().applyAppEvent({ type: 'turn-finished', chatId: 'c1', messageId: 'm1', status: 'complete' });
    expect(s().appRunningTurns).toEqual({ m2: 'c1' });
    s().applyAppHello({ pendingApprovals: [], runningTurns: [{ chatId: 'c9', messageId: 'm9' }] });
    expect(s().appRunningTurns).toEqual({ m9: 'c9' });
  });

  it('asks a chat to reload when a turn this window knows nothing of starts or finishes there, but not for its own', () => {
    const s = () => useOtherBenchStore.getState();
    const reply = (id: string, status: CanonMessage['status']): CanonMessage => ({
      id, chatId: 'c1', parentId: null, role: 'assistant', parts: [], status, error: null, producedBy: null, createdAt: 1,
    });

    // Sent from another window or machine: unknown here.
    s().applyAppEvent({ type: 'turn-started', chatId: 'c1', messageIds: ['theirs'] });
    expect(s().chatReloads).toEqual({ c1: 1 });
    s().applyAppEvent({ type: 'turn-finished', chatId: 'c1', messageId: 'theirs', status: 'complete' });
    expect(s().chatReloads).toEqual({ c1: 2 });

    // Sent from here: known, and already finished when its finish arrives.
    s().registerMessage(reply('mine', 'streaming'));
    s().applyAppEvent({ type: 'turn-started', chatId: 'c1', messageIds: ['mine'] });
    s().applyTurnEvent({ messageId: 'mine', type: 'status', status: 'complete' });
    s().applyAppEvent({ type: 'turn-finished', chatId: 'c1', messageId: 'mine', status: 'complete' });
    expect(s().chatReloads).toEqual({ c1: 2 });
  });

  it('asks a chat to reload when a turn starts with no replies (a /clear), as its line may not have synced yet', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyAppEvent({ type: 'turn-started', chatId: 'c1', messageIds: [] });
    expect(s().chatReloads).toEqual({ c1: 1 });
  });

  it('loading a finished message drops the events buffered for it before it was known', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyTurnEvent({ messageId: 'theirs', type: 'text-delta', text: 'early' });
    expect(s().pendingEvents['theirs']).toHaveLength(1);
    s().loadMessages('c1', [stubAssistant('theirs', { parts: [{ type: 'text', text: 'early and late' }], status: 'complete' })], null);
    expect(s().pendingEvents['theirs']).toBeUndefined();
    expect(s().messages['theirs']?.parts).toEqual([{ type: 'text', text: 'early and late' }]);
  });

  // A reload (another window's turn, a sync) can land while a reply is still
  // being written. What it brings back for that reply is only its last
  // checkpoint; the stream has everything.
  it('a reload leaves a reply this window is streaming as its stream has it', () => {
    const s = () => useOtherBenchStore.getState();
    s().registerMessage(stubAssistant('mine'));
    s().applyTurnEvent({ messageId: 'mine', type: 'text-delta', text: 'Project memory: Alpha' });
    s().loadMessages('chat-1', [stubAssistant('mine', { parts: [{ type: 'text', text: 'Project' }] })], null);
    s().applyTurnEvent({ messageId: 'mine', type: 'text-delta', text: '.' });
    expect(s().messages['mine']?.parts).toEqual([{ type: 'text', text: 'Project memory: Alpha.' }]);

    // Once it has finished, the stored copy is the final word.
    s().loadMessages('chat-1', [stubAssistant('mine', { parts: [{ type: 'text', text: 'Project memory: Alpha. Done.' }], status: 'complete' })], null);
    expect(s().messages['mine']).toMatchObject({ status: 'complete', parts: [{ type: 'text', text: 'Project memory: Alpha. Done.' }] });
  });

  it('a reply loaded mid-stream is rebuilt from the events buffered for it, not from its checkpoint', () => {
    const s = () => useOtherBenchStore.getState();
    s().applyTurnEvent({ messageId: 'theirs', type: 'notice', text: '1 image attachment was left out' });
    s().applyTurnEvent({ messageId: 'theirs', type: 'text-delta', text: 'Hel' });
    s().applyTurnEvent({ messageId: 'theirs', type: 'text-delta', text: 'lo' });
    s().loadMessages('chat-1', [stubAssistant('theirs', { parts: [{ type: 'notice', text: '1 image attachment was left out' }, { type: 'text', text: 'Hel' }] })], null);
    expect(s().pendingEvents['theirs']).toBeUndefined();
    s().applyTurnEvent({ messageId: 'theirs', type: 'text-delta', text: ' there' });
    expect(s().messages['theirs']?.parts).toEqual([
      { type: 'notice', text: '1 image attachment was left out' },
      { type: 'text', text: 'Hello there' },
    ]);
  });
});

describe('inspector collapsed state', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    window.localStorage.clear();
  });

  it('loads false with nothing stored or unreadable storage, true when stored', () => {
    expect(loadInspectorCollapsed()).toBe(false);
    window.localStorage.setItem(INSPECTOR_COLLAPSED_STORAGE_KEY, 'true');
    expect(loadInspectorCollapsed()).toBe(true);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadInspectorCollapsed()).toBe(false);
    get.mockRestore();
  });

  it('saves when it changes', () => {
    useOtherBenchStore.getState().setInspectorCollapsed(true);
    expect(window.localStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY)).toBe('true');
    useOtherBenchStore.getState().setInspectorCollapsed(false);
    expect(window.localStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY)).toBe('false');
  });
});

describe('the project page slot', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));

  it('starts closed, opens for creating or for editing a project, and closes', () => {
    expect(useOtherBenchStore.getState().projectPage).toBeNull();
    useOtherBenchStore.getState().openProjectPage({ mode: 'create' });
    expect(useOtherBenchStore.getState().projectPage).toEqual({ mode: 'create' });
    useOtherBenchStore.getState().openProjectPage({ mode: 'edit', projectId: 'p1' });
    expect(useOtherBenchStore.getState().projectPage).toEqual({ mode: 'edit', projectId: 'p1' });
    useOtherBenchStore.getState().closeProjectPage();
    expect(useOtherBenchStore.getState().projectPage).toBeNull();
  });
});

describe('asks and the app-wide pending list', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));
  it('dropAsk removes a dead card from whichever message holds it', () => {
    const ask = { kind: 'plan' as const, toolName: 'propose_plan', plan: '1. x', id: 'a1', chatId: 'c1', messageId: 'm1' };
    useOtherBenchStore.setState({ extras: { m1: { usage: null, pendingApprovals: [], pendingAsks: [ask] } } });
    useOtherBenchStore.getState().dropAsk('a1');
    expect(useOtherBenchStore.getState().extras['m1']!.pendingAsks).toEqual([]);
  });
  it('keeps the kind of a pending question, and the tray counts tool approvals only', () => {
    const s = useOtherBenchStore.getState();
    s.applyAppEvent({ type: 'approval-requested', chatId: 'c1', messageId: 'm1', requestId: 'a1', toolName: 'ask_user', kind: 'question' });
    s.applyAppEvent({ type: 'approval-requested', chatId: 'c1', messageId: 'm1', requestId: 'r1', toolName: 'write_file' });
    expect(useOtherBenchStore.getState().appPendingApprovals['a1']).toMatchObject({ kind: 'question' });
    expect(selectPendingApprovalCount(useOtherBenchStore.getState())).toBe(1);
  });
});

describe('notes (messages sent while a reply runs)', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));

  const note = (id: string, over: Partial<ReplyNote> = {}): ReplyNote => ({
    id, chatId: 'c1', text: id, attachments: [], path: 'wait', replyIds: [], parentId: null, profileIds: ['p1'], clientId: CLIENT_ID, sentAt: 1, ...over,
  });

  it("notes event replaces the chat's waiting notes", () => {
    const { applyChatEvent } = useOtherBenchStore.getState();
    applyChatEvent('c1', { type: 'notes', chatId: 'c1', notes: [note('n1'), note('n2')] });
    applyChatEvent('c1', { type: 'notes', chatId: 'c1', notes: [note('n2')] });
    expect(useOtherBenchStore.getState().chatNotes['c1']?.map((n) => n.id)).toEqual(['n2']);
  });

  it('a returned note comes back only to the tab that sent it', () => {
    const s = useOtherBenchStore.getState();
    s.noteSent(note('n1'));
    s.noteSent(note('n2', { clientId: 'other-tab' }));
    s.applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n1', outcome: 'returned', clientId: CLIENT_ID, note: note('n1') });
    s.applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n2', outcome: 'returned', clientId: 'other-tab', note: note('n2', { clientId: 'other-tab' }) });
    const after = useOtherBenchStore.getState();
    expect(after.returnedNotes.map((n) => n.id)).toEqual(['n1']);
    expect(after.takeReturnedNotes('c1').map((n) => n.id)).toEqual(['n1']);
    expect(useOtherBenchStore.getState().returnedNotes).toEqual([]);
  });

  it('after a reload, a taken-back note stays gone; a returned one, or one with no outcome, is restored', () => {
    const s = useOtherBenchStore.getState();
    for (const id of ['removed', 'returned', 'unknown']) s.noteSent(note(id));
    s.setChatNotes('c1', [], [{ noteId: 'removed', outcome: 'removed' }, { noteId: 'returned', outcome: 'returned' }]);
    const after = useOtherBenchStore.getState();
    expect(after.returnedNotes.map((n) => n.id).sort()).toEqual(['returned', 'unknown']);
    expect(after.sentNotes).toEqual({});
  });

  it("after a reload, a sent note the server no longer has and never delivered comes back; a delivered one doesn't", () => {
    const s = useOtherBenchStore.getState();
    for (const id of ['lost', 'folded', 'turn', 'waiting']) s.noteSent(note(id));
    s.setChatNotes('c1', [note('waiting')], [{ noteId: 'folded', outcome: 'folded' }, { noteId: 'turn', outcome: 'turn' }]);
    const after = useOtherBenchStore.getState();
    expect(after.returnedNotes.map((n) => n.id)).toEqual(['lost']);
    expect(Object.keys(after.sentNotes)).toEqual(['waiting']);
    expect(after.chatNotes['c1']?.map((n) => n.id)).toEqual(['waiting']);
  });

  it('a note resolved before its send returned is not remembered as sent, so a reload never restores it again', () => {
    const s = useOtherBenchStore.getState();
    s.applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n1', outcome: 'returned', clientId: CLIENT_ID, note: note('n1') });
    s.applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n2', outcome: 'folded', clientId: CLIENT_ID });
    s.noteSent(note('n1'));
    s.noteSent(note('n2'));
    expect(useOtherBenchStore.getState().sentNotes).toEqual({});
    s.setChatNotes('c1', [], []);
    const after = useOtherBenchStore.getState();
    expect(after.sentNotes).toEqual({});
    expect(after.returnedNotes.map((n) => n.id)).toEqual(['n1']);
    expect(after.earlyResolved).toEqual({});
  });

  it("another tab's resolved notes, and this tab's taken-back ones, aren't held for a send", () => {
    const s = useOtherBenchStore.getState();
    s.applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n1', outcome: 'turn', clientId: 'other-tab' });
    s.noteSent(note('n2'));
    s.noteTakenBack(note('n2'));
    s.applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n2', outcome: 'removed', clientId: CLIENT_ID });
    expect(useOtherBenchStore.getState().earlyResolved).toEqual({});
  });
});
