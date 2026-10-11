import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { Connection, ModelInfo, Profile } from '@grunt/core/types/config.js';
import { INSPECTOR_COLLAPSED_STORAGE_KEY, loadInspectorCollapsed, selectPendingApprovalCount, useGruntStore } from './store.js';

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
  useGruntStore.setState(useGruntStore.getInitialState(), true);
}

describe('useGruntStore', () => {
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
      autoMode: false,
      projectId: null,
      memoryCursor: null,
      memoryExcluded: false,
      sortOrder: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    useGruntStore.getState().setChats([chat]);
    expect(useGruntStore.getState().chats).toEqual([chat]);

    useGruntStore.getState().upsertChat({ ...chat, title: 'Renamed' });
    expect(useGruntStore.getState().chats).toHaveLength(1);
    expect(useGruntStore.getState().chats[0]?.title).toBe('Renamed');
  });

  it('applyTurnEvent on a known message appends streamed text', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Hello' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: ' world' });

    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  // Load-bearing (task 19 brief): a `text-delta` for a message id the store
  // doesn't know yet must be buffered, not silently dropped. This is a real
  // race in this design -- the SSE connection can already be open and
  // delivering events for a message before the `POST .../turns` response
  // (which is how the client normally learns the id) has even resolved.
  it('buffers a text-delta for an unknown message id instead of dropping it, then flushes it once the message is registered', () => {
    useGruntStore.getState().applyTurnEvent({ messageId: 'm-unknown', type: 'text-delta', text: 'early bird' });

    // Not dropped: it's sitting in pendingEvents, and no message was
    // fabricated for it.
    expect(useGruntStore.getState().messages['m-unknown']).toBeUndefined();
    expect(useGruntStore.getState().pendingEvents['m-unknown']).toHaveLength(1);

    // Once the message becomes known (e.g. the turn-creation response
    // arrives), the buffered event is folded in immediately.
    useGruntStore.getState().registerMessage(stubAssistant('m-unknown'));

    expect(useGruntStore.getState().messages['m-unknown']?.parts).toEqual([{ type: 'text', text: 'early bird' }]);
    expect(useGruntStore.getState().pendingEvents['m-unknown']).toBeUndefined();
  });

  it('buffers events for several unknown messages independently', () => {
    useGruntStore.getState().applyTurnEvent({ messageId: 'a', type: 'text-delta', text: 'A' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'b', type: 'text-delta', text: 'B' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'a', type: 'text-delta', text: '1' });

    expect(useGruntStore.getState().pendingEvents['a']).toHaveLength(2);
    expect(useGruntStore.getState().pendingEvents['b']).toHaveLength(1);
  });

  // Load-bearing (task 19 brief): reconnecting and replaying the `hello`
  // snapshot must not duplicate text already applied from the live feed
  // before the disconnect. StreamRegistry's buffer is "everything since the
  // turn started", not "everything since you last saw", so naively
  // appending the hello replay on top of current state would double it.
  it('reconnect replay via applyHello does not duplicate text already streamed live', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Hello' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: ' world' });
    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);

    // Simulate a drop + reconnect: the server's hello snapshot replays the
    // FULL buffer for this message, which happens to be exactly the two
    // deltas already applied above.
    useGruntStore.getState().applyHello([
      {
        messageId: 'm1',
        status: 'streaming',
        events: [
          { messageId: 'm1', type: 'text-delta', text: 'Hello' },
          { messageId: 'm1', type: 'text-delta', text: ' world' },
        ],
      },
    ]);

    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('applyHello for a message not yet known replaces (not appends to) its pending buffer', () => {
    useGruntStore.getState().applyTurnEvent({ messageId: 'm2', type: 'text-delta', text: 'partial-from-live' });

    useGruntStore.getState().applyHello([
      {
        messageId: 'm2',
        status: 'streaming',
        events: [{ messageId: 'm2', type: 'text-delta', text: 'full-from-hello' }],
      },
    ]);
    useGruntStore.getState().registerMessage(stubAssistant('m2'));

    expect(useGruntStore.getState().messages['m2']?.parts).toEqual([{ type: 'text', text: 'full-from-hello' }]);
  });

  it('applyHello on a known message also updates its authoritative status', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyHello([{ messageId: 'm1', status: 'complete', events: [] }]);
    expect(useGruntStore.getState().messages['m1']?.status).toBe('complete');
  });

  it('registerMessage does not clobber an already-known message', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'live text' });
    // A redundant registration (e.g. a stale bulk hydrate racing the live
    // stream) must not overwrite the further-along live state.
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'live text' }]);
  });

  it('resetMessageForRetry clears parts/error and re-arms status so a retried stream starts clean', () => {
    useGruntStore.getState().registerMessage(
      stubAssistant('m1', {
        status: 'error',
        parts: [{ type: 'text', text: 'partial before failing' }],
        error: { kind: 'rate_limit', message: 'boom', retryable: true },
      })
    );
    useGruntStore.getState().applyTurnEvent({
      messageId: 'm1',
      type: 'finish',
      usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 },
      finishReason: 'stop',
    });
    expect(useGruntStore.getState().extras['m1']?.usage).not.toBeNull();

    useGruntStore.getState().resetMessageForRetry('m1');

    expect(useGruntStore.getState().messages['m1']).toMatchObject({ status: 'streaming', error: null, parts: [] });
    expect(useGruntStore.getState().extras['m1']?.usage).toBeNull();

    // A delta after the reset builds on the clean slate, not the old failed text.
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Second attempt' });
    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Second attempt' }]);
  });

  it('resetMessageForRetry is a no-op for a message the store does not know', () => {
    useGruntStore.getState().resetMessageForRetry('unknown');
    expect(useGruntStore.getState().messages['unknown']).toBeUndefined();
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
      autoMode: false,
      projectId: null,
      memoryCursor: null,
      memoryExcluded: false,
      sortOrder: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    useGruntStore.getState().setChats([chat]);
    useGruntStore.getState().setHeadMessageId('chat-1', 'm1');
    expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('m1');
  });

  it('upsertConnection inserts a new connection and replaces an existing one by id', () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    useGruntStore.getState().upsertConnection(makeConnection({ name: 'Renamed' }));
    expect(useGruntStore.getState().connections).toHaveLength(1);
    expect(useGruntStore.getState().connections[0]?.name).toBe('Renamed');

    useGruntStore.getState().upsertConnection(makeConnection({ id: 'conn-2', name: 'Second' }));
    expect(useGruntStore.getState().connections).toHaveLength(2);
  });

  // Load-bearing: the database cascades a connection delete onto its models
  // and profiles (ON DELETE CASCADE, migrations/001-initial.ts) -- local
  // state must mirror that or the Settings UI keeps showing rows the server
  // just deleted.
  it('removeConnection also drops every model and profile that referenced it, mirroring the DB cascade', () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1' }), makeConnection({ id: 'conn-2' })]);
    useGruntStore.getState().setModels([makeModel({ id: 'm1', connectionId: 'conn-1' }), makeModel({ id: 'm2', connectionId: 'conn-2' })]);
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p1', connectionId: 'conn-1' }), makeProfile({ id: 'p2', connectionId: 'conn-2' })]);

    useGruntStore.getState().removeConnection('conn-1');

    expect(useGruntStore.getState().connections.map((c) => c.id)).toEqual(['conn-2']);
    expect(useGruntStore.getState().models.map((m) => m.id)).toEqual(['m2']);
    expect(useGruntStore.getState().profiles.map((p) => p.id)).toEqual(['p2']);
  });

  // Load-bearing (Finding 5): the DB cascade goes connection -> profile ->
  // chat, but the previous removeConnection only mirrored the first hop.
  // Left as-is, a chat built on a deleted connection's profile stayed in
  // `chats` and, if it was the active one, stayed selected -- a dead
  // composer still offering Send, and the Inspector polling
  // /grants and /audit for an id the server would now 404 on forever.
  it('removeConnection also drops every chat built on one of its profiles, and clears activeChatId if the active chat was one of them', () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1' }), makeConnection({ id: 'conn-2' })]);
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p1', connectionId: 'conn-1' }), makeProfile({ id: 'p2', connectionId: 'conn-2' })]);
    useGruntStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useGruntStore.getState().setActiveChatId('chat-1');

    useGruntStore.getState().removeConnection('conn-1');

    expect(useGruntStore.getState().chats.map((c) => c.id)).toEqual(['chat-2']);
    expect(useGruntStore.getState().activeChatId).toBeNull();
  });

  it('removeConnection leaves activeChatId alone when the active chat survives (not built on the deleted connection)', () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1' }), makeConnection({ id: 'conn-2' })]);
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p1', connectionId: 'conn-1' }), makeProfile({ id: 'p2', connectionId: 'conn-2' })]);
    useGruntStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useGruntStore.getState().setActiveChatId('chat-2');

    useGruntStore.getState().removeConnection('conn-1');

    expect(useGruntStore.getState().chats.map((c) => c.id)).toEqual(['chat-2']);
    expect(useGruntStore.getState().activeChatId).toBe('chat-2');
  });

  it('upsertModel inserts a new model and replaces an existing one by id', () => {
    useGruntStore.getState().setModels([makeModel()]);
    useGruntStore.getState().upsertModel(makeModel({ supportsTools: true }));
    expect(useGruntStore.getState().models).toHaveLength(1);
    expect(useGruntStore.getState().models[0]?.supportsTools).toBe(true);

    useGruntStore.getState().upsertModel(makeModel({ id: 'model-2' }));
    expect(useGruntStore.getState().models).toHaveLength(2);
  });

  it('upsertModels folds a batch of discovered models in, inserting new ids and replacing known ones', () => {
    useGruntStore.getState().setModels([makeModel({ id: 'm1', displayName: 'Old name' })]);
    useGruntStore.getState().upsertModels([makeModel({ id: 'm1', displayName: 'New name' }), makeModel({ id: 'm2' })]);

    const models = useGruntStore.getState().models;
    expect(models).toHaveLength(2);
    expect(models.find((m) => m.id === 'm1')?.displayName).toBe('New name');
  });

  it('upsertProfile inserts a new profile and replaces an existing one by id', () => {
    useGruntStore.getState().setProfiles([makeProfile()]);
    useGruntStore.getState().upsertProfile(makeProfile({ name: 'Renamed profile' }));
    expect(useGruntStore.getState().profiles).toHaveLength(1);
    expect(useGruntStore.getState().profiles[0]?.name).toBe('Renamed profile');

    useGruntStore.getState().upsertProfile(makeProfile({ id: 'profile-2' }));
    expect(useGruntStore.getState().profiles).toHaveLength(2);
  });

  it('removeProfile drops just that profile', () => {
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p1' }), makeProfile({ id: 'p2' })]);
    useGruntStore.getState().removeProfile('p1');
    expect(useGruntStore.getState().profiles.map((p) => p.id)).toEqual(['p2']);
  });

  // Load-bearing (Finding 5): same gap as removeConnection above, one hop
  // shorter -- deleting a profile directly (not via its connection) must
  // also drop every chat built on it and clear activeChatId if needed.
  it('removeProfile also drops every chat built on it, and clears activeChatId if the active chat was one of them', () => {
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p1' }), makeProfile({ id: 'p2' })]);
    useGruntStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useGruntStore.getState().setActiveChatId('chat-1');

    useGruntStore.getState().removeProfile('p1');

    expect(useGruntStore.getState().chats.map((c) => c.id)).toEqual(['chat-2']);
    expect(useGruntStore.getState().activeChatId).toBeNull();
  });

  it('removeProfile leaves activeChatId alone when the active chat survives', () => {
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p1' }), makeProfile({ id: 'p2' })]);
    useGruntStore.getState().setChats([makeChat({ id: 'chat-1', profileId: 'p1' }), makeChat({ id: 'chat-2', profileId: 'p2' })]);
    useGruntStore.getState().setActiveChatId('chat-2');

    useGruntStore.getState().removeProfile('p1');

    expect(useGruntStore.getState().activeChatId).toBe('chat-2');
  });

  it('setProjects/upsertProject populate the project list, replacing by id', () => {
    useGruntStore.getState().setProjects([makeProject()]);
    useGruntStore.getState().upsertProject(makeProject({ name: 'Renamed' }));
    useGruntStore.getState().upsertProject(makeProject({ id: 'proj-2' }));

    expect(useGruntStore.getState().projects.map((p) => [p.id, p.name])).toEqual([
      ['proj-1', 'Renamed'],
      ['proj-2', 'Alpha'],
    ]);
  });

  it('removeProject drops the project and moves its chats to no project in the same update, keeping them', () => {
    useGruntStore.getState().setProjects([makeProject(), makeProject({ id: 'proj-2' })]);
    useGruntStore.getState().setChats([
      makeChat({ id: 'a', projectId: 'proj-1', workspaceRoot: '/ws' }),
      makeChat({ id: 'b', projectId: 'proj-2' }),
    ]);

    useGruntStore.getState().removeProject('proj-1');

    const state = useGruntStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['proj-2']);
    expect(state.chats.map((c) => [c.id, c.projectId, c.workspaceRoot])).toEqual([
      ['a', null, '/ws'],
      ['b', 'proj-2', null],
    ]);
  });

  it('a removed or archived profile stops being any project default, mirroring the server', () => {
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p-a' }), makeProfile({ id: 'p-b' })]);
    useGruntStore.getState().setProjects([
      makeProject({ id: 'x', defaultProfileId: 'p-a' }),
      makeProject({ id: 'y', defaultProfileId: 'p-b' }),
    ]);

    useGruntStore.getState().upsertProfile(makeProfile({ id: 'p-a', archivedAt: 5 }));
    expect(useGruntStore.getState().projects.map((p) => p.defaultProfileId)).toEqual([null, 'p-b']);

    useGruntStore.getState().removeProfile('p-b');
    expect(useGruntStore.getState().projects.map((p) => p.defaultProfileId)).toEqual([null, null]);
  });

  it('removeConnection clears project defaults that pointed at its profiles', () => {
    useGruntStore.getState().setProfiles([makeProfile({ id: 'p-a', connectionId: 'conn-1' })]);
    useGruntStore.getState().setProjects([makeProject({ defaultProfileId: 'p-a' })]);

    useGruntStore.getState().removeConnection('conn-1');

    expect(useGruntStore.getState().projects[0]!.defaultProfileId).toBeNull();
  });
});

describe('app-wide events (Task 34)', () => {
  beforeEach(() => useGruntStore.setState(useGruntStore.getInitialState(), true));

  it('chat-created adds a chat, chat-updated replaces it, chat-deleted removes it and clears it if active', () => {
    const s = () => useGruntStore.getState();
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
    const s = () => useGruntStore.getState();
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
});

describe('running replies from app-wide events (#824)', () => {
  beforeEach(() => useGruntStore.setState(useGruntStore.getInitialState(), true));

  it('tracks replies from turn-started to turn-finished, and a hello replaces the set', () => {
    const s = () => useGruntStore.getState();
    s().applyAppEvent({ type: 'turn-started', chatId: 'c1', messageIds: ['m1', 'm2'] });
    expect(s().appRunningTurns).toEqual({ m1: 'c1', m2: 'c1' });
    s().applyAppEvent({ type: 'turn-finished', chatId: 'c1', messageId: 'm1', status: 'complete' });
    expect(s().appRunningTurns).toEqual({ m2: 'c1' });
    s().applyAppHello({ pendingApprovals: [], runningTurns: [{ chatId: 'c9', messageId: 'm9' }] });
    expect(s().appRunningTurns).toEqual({ m9: 'c9' });
  });

  it('asks a chat to reload when a turn this window knows nothing of starts or finishes there, but not for its own', () => {
    const s = () => useGruntStore.getState();
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

  it('loading a finished message drops the events buffered for it before it was known', () => {
    const s = () => useGruntStore.getState();
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
    const s = () => useGruntStore.getState();
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
    const s = () => useGruntStore.getState();
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
    useGruntStore.setState(useGruntStore.getInitialState(), true);
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
    useGruntStore.getState().setInspectorCollapsed(true);
    expect(window.localStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY)).toBe('true');
    useGruntStore.getState().setInspectorCollapsed(false);
    expect(window.localStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY)).toBe('false');
  });
});

describe('the project page slot', () => {
  beforeEach(() => useGruntStore.setState(useGruntStore.getInitialState(), true));

  it('starts closed, opens for creating or for editing a project, and closes', () => {
    expect(useGruntStore.getState().projectPage).toBeNull();
    useGruntStore.getState().openProjectPage({ mode: 'create' });
    expect(useGruntStore.getState().projectPage).toEqual({ mode: 'create' });
    useGruntStore.getState().openProjectPage({ mode: 'edit', projectId: 'p1' });
    expect(useGruntStore.getState().projectPage).toEqual({ mode: 'edit', projectId: 'p1' });
    useGruntStore.getState().closeProjectPage();
    expect(useGruntStore.getState().projectPage).toBeNull();
  });
});
