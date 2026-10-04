import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  Store,
  Chat,
  Project,
  Attachment,
  UsageRecord,
  McpServer,
  Grant,
  AuditEntry,
} from '../ports/store.js';
import type { Connection, ModelInfo, Profile, ToolPolicy } from '../types/config.js';
import type { CanonMessage, Part } from '../types/messages.js';
import type { PricingSnapshot } from '../types/usage.js';
import { MEMORY_VERSIONS_KEPT } from '../domain/memory.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// Every dependent entity below is seeded through its full referential chain
// (connection -> model -> profile -> chat -> message) rather than handed a
// bare, possibly-dangling foreign key. InMemoryStore doesn't care either
// way, but this suite also runs verbatim against a real SQLite schema
// (Task 9), which may enforce foreign keys -- a contract that only an
// FK-less fake could satisfy would defeat the point of sharing it.
// ---------------------------------------------------------------------------

function makeConnection(over: Partial<Connection> & { id: string }): Connection {
  return {
    name: 'Test Connection',
    kind: 'mock',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...over,
  };
}

function makeModel(over: Partial<ModelInfo> & { id: string; connectionId: string }): ModelInfo {
  return {
    modelId: 'test-model',
    displayName: 'Test Model',
    source: 'manual',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: null,
    priceOutPer1m: null,
    priceCachedPer1m: null,
    currency: 'USD',
    ...over,
  };
}

function makeProfile(
  over: Partial<Profile> & { id: string; connectionId: string; modelId: string }
): Profile {
  const toolPolicy: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' };
  return {
    name: 'Test Profile',
    description: null,
    colour: null,
    systemPrompt: null,
    params: {},
    toolPolicy,
    isDefault: false,
    archivedAt: null,
    ...over,
  };
}

function makeChatInput(over: { id: string; profileId: string } & Partial<Chat>) {
  return {
    title: 'Test Chat',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    ...over,
  };
}

function makeMessageInput(over: { id: string; chatId: string } & Partial<CanonMessage>) {
  const defaultParts: Part[] = [{ type: 'text', text: 'hello' }];
  return {
    parentId: null,
    role: 'user',
    parts: defaultParts,
    status: 'complete',
    error: null,
    producedBy: null,
    ...over,
  } satisfies Omit<CanonMessage, 'createdAt'> & { createdAt?: number };
}

function makeAttachment(over: Partial<Attachment> & { id: string; chatId: string }): Attachment {
  return {
    messageId: null,
    filename: 'test.txt',
    mime: 'text/plain',
    size: 4,
    sha256: 'deadbeef',
    storagePath: '/tmp/test.txt',
    extractedText: null,
    ...over,
  };
}

const zeroPricing: PricingSnapshot = {
  priceInPer1m: null,
  priceOutPer1m: null,
  priceCachedPer1m: null,
  currency: 'USD',
};

function makeUsageRecord(
  over: Partial<UsageRecord> & {
    id: string;
    chatId: string;
    messageId: string;
    profileId: string;
    connectionId: string;
    modelId: string;
  }
): UsageRecord {
  return {
    tokensIn: 10,
    tokensOut: 20,
    tokensCached: 0,
    tokensReasoning: 0,
    costEstimate: null,
    pricingSnapshot: zeroPricing,
    latencyMs: 100,
    ...over,
  };
}

function makeMcpServer(over: Partial<McpServer> & { id: string }): McpServer {
  return {
    name: 'Test MCP',
    transport: 'stdio',
    command: 'node',
    args: [],
    envRefs: {},
    url: null,
    headerRefs: {},
    enabled: true,
    status: 'unknown',
    toolsCache: null,
    ...over,
  };
}

function makeGrant(over: Partial<Grant> & { id: string }): Grant {
  return {
    chatId: null,
    profileId: null,
    toolName: 'fs.read',
    source: 'fs',
    scope: 'chat',
    constraint: null,
    expiresAt: null,
    ...over,
  };
}

function makeAuditInput(over: { id: string; chatId: string; messageId: string } & Partial<AuditEntry>) {
  return {
    toolName: 'fs.read',
    argsRedacted: {},
    resultSummary: 'ok',
    durationMs: 5,
    grantedBy: 'user',
    ...over,
  } satisfies Omit<AuditEntry, 'createdAt'> & { createdAt?: number };
}

interface SeededProfile {
  profileId: string;
  connectionId: string;
  modelId: string;
}

/** Seeds a connection + model + profile referential chain, returns the ids created. */
function seedProfile(store: Store, id: string): SeededProfile {
  const connectionId = `${id}::conn`;
  const modelId = `${id}::model`;
  store.connections.create(makeConnection({ id: connectionId }));
  store.models.create(makeModel({ id: modelId, connectionId }));
  store.profiles.create(makeProfile({ id, connectionId, modelId }));
  return { profileId: id, connectionId, modelId };
}

interface SeededChat extends SeededProfile {
  chat: Chat;
}

/** Seeds a full connection -> model -> profile -> chat chain. */
function seedChat(store: Store, id: string): SeededChat {
  const seededProfile = seedProfile(store, `${id}::profile`);
  const chat = store.chats.create(makeChatInput({ id, profileId: seededProfile.profileId }));
  return { chat, ...seededProfile };
}

/**
 * Asserts a defaulted timestamp is a real "now"-ish value, not just any
 * number -- `expect.any(Number)` alone would also pass for a default of `0`
 * or `-1`, which is exactly the kind of bug this contract is meant to catch.
 */
function expectRecentTimestamp(value: number): void {
  expect(value).toBeGreaterThan(0);
  expect(value).toBeLessThanOrEqual(Date.now());
  expect(Date.now() - value).toBeLessThan(5_000);
}

// ---------------------------------------------------------------------------
// The shared contract
// ---------------------------------------------------------------------------

/**
 * Registers a full `describe` block of behavioural tests against any `Store`
 * implementation, so a fake (InMemoryStore) and a real adapter (SQLite,
 * Task 9) are held to the identical suite and cannot drift apart.
 *
 * @param name       Label for the describe block (e.g. "InMemoryStore", "SqliteStore").
 * @param makeStore  Builds a fresh, empty store for each test.
 * @param teardown   Optional per-test cleanup (e.g. close + unlink a temp DB
 *                    file). When omitted, `store.close()` is called for you.
 */
export function runStoreContract(
  name: string,
  makeStore: () => Store | Promise<Store>,
  teardown?: (store: Store) => void | Promise<void>
): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store;

    beforeEach(async () => {
      store = await makeStore();
    });

    afterEach(async () => {
      if (teardown) {
        await teardown(store);
      } else {
        store.close();
      }
    });

    it('connections: create/get round-trip', () => {
      store.connections.create(makeConnection({ id: 'conn-a', name: 'My Connection' }));
      expect(store.connections.get('conn-a')).toMatchObject({ id: 'conn-a', name: 'My Connection' });
      expect(store.connections.get('does-not-exist')).toBeNull();
    });

    it('models: create/get round-trip', () => {
      store.connections.create(makeConnection({ id: 'conn-a' }));
      store.models.create(makeModel({ id: 'model-a', connectionId: 'conn-a', displayName: 'GPT Test' }));
      expect(store.models.get('model-a')).toMatchObject({ id: 'model-a', displayName: 'GPT Test' });
    });

    it('profiles: create/get round-trip', () => {
      store.connections.create(makeConnection({ id: 'conn-a' }));
      store.models.create(makeModel({ id: 'model-a', connectionId: 'conn-a' }));
      store.profiles.create(makeProfile({ id: 'profile-a', connectionId: 'conn-a', modelId: 'model-a', name: 'My Profile' }));
      expect(store.profiles.get('profile-a')).toMatchObject({ id: 'profile-a', name: 'My Profile' });
    });

    it('chats: create/get round-trip, defaulting createdAt/updatedAt', () => {
      const { profileId } = seedProfile(store, 'profile-a');
      const created = store.chats.create(makeChatInput({ id: 'chat-a', profileId, title: 'My Chat' }));

      expectRecentTimestamp(created.createdAt);
      expectRecentTimestamp(created.updatedAt);
      expect(store.chats.get('chat-a')).toMatchObject({ id: 'chat-a', title: 'My Chat', profileId });
    });

    it('chats: autoMode defaults to false and round-trips through create and update', () => {
      const { profileId } = seedProfile(store, 'profile-a');
      const created = store.chats.create(makeChatInput({ id: 'chat-a', profileId }));
      expect(created.autoMode).toBe(false);
      expect(store.chats.get('chat-a')!.autoMode).toBe(false);

      store.chats.update('chat-a', { autoMode: true });
      expect(store.chats.get('chat-a')!.autoMode).toBe(true);
      expect(store.chats.list().find((c) => c.id === 'chat-a')!.autoMode).toBe(true);

      store.chats.create(makeChatInput({ id: 'chat-b', profileId, autoMode: true }));
      expect(store.chats.get('chat-b')!.autoMode).toBe(true);
    });

    describe('projects', () => {
      function makeProjectInput(over: { id: string } & Partial<Project>) {
        return { name: 'Test Project', workspaceRoot: null, defaultProfileId: null, ...over };
      }

      it('create/get round-trip, defaulting sortOrder to 0 and the timestamps to now', () => {
        const created = store.projects.create(makeProjectInput({ id: 'proj-a', name: 'Alpha', workspaceRoot: '/ws/alpha' }));
        expect(created.sortOrder).toBe(0);
        expectRecentTimestamp(created.createdAt);
        expectRecentTimestamp(created.updatedAt);
        expect(store.projects.get('proj-a')).toEqual(created);
        expect(store.projects.get('does-not-exist')).toBeNull();
      });

      it('list orders by sortOrder, then name ignoring ASCII case, then id', () => {
        store.projects.create(makeProjectInput({ id: 'p3', name: 'beta', sortOrder: 1 }));
        store.projects.create(makeProjectInput({ id: 'p5', name: 'Same', sortOrder: 1 }));
        store.projects.create(makeProjectInput({ id: 'p2', name: 'Alpha', sortOrder: 1 }));
        store.projects.create(makeProjectInput({ id: 'p4', name: 'same', sortOrder: 1 }));
        store.projects.create(makeProjectInput({ id: 'p1', name: 'Zed', sortOrder: 0 }));

        expect(store.projects.list().map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
      });

      it('update persists a patch, update of an unknown id throws, and delete is idempotent', () => {
        store.projects.create(makeProjectInput({ id: 'proj-a' }));

        const updated = store.projects.update('proj-a', { name: 'Renamed', workspaceRoot: '/ws', sortOrder: 3 });

        expect(updated).toMatchObject({ name: 'Renamed', workspaceRoot: '/ws', sortOrder: 3 });
        expect(store.projects.get('proj-a')).toMatchObject({ name: 'Renamed', workspaceRoot: '/ws', sortOrder: 3 });
        expect(() => store.projects.update('does-not-exist', { name: 'x' })).toThrow(Error);
        store.projects.delete('proj-a');
        expect(store.projects.get('proj-a')).toBeNull();
        expect(() => store.projects.delete('proj-a')).not.toThrow();
      });

      it('chats: projectId defaults to null and round-trips through create, update and list', () => {
        const { profileId } = seedProfile(store, 'profile-a');
        store.projects.create(makeProjectInput({ id: 'proj-a' }));

        expect(store.chats.create(makeChatInput({ id: 'chat-a', profileId })).projectId).toBeNull();
        expect(store.chats.get('chat-a')!.projectId).toBeNull();
        store.chats.create(makeChatInput({ id: 'chat-b', profileId, projectId: 'proj-a' }));
        expect(store.chats.get('chat-b')!.projectId).toBe('proj-a');

        store.chats.update('chat-a', { projectId: 'proj-a' });
        expect(store.chats.list().filter((c) => c.projectId === 'proj-a').map((c) => c.id).sort()).toEqual(['chat-a', 'chat-b']);
        store.chats.update('chat-b', { projectId: null });
        expect(store.chats.get('chat-b')!.projectId).toBeNull();
      });

      it('deleting a project moves its chats to no project and keeps them, folder and all', () => {
        const { profileId } = seedProfile(store, 'profile-a');
        store.projects.create(makeProjectInput({ id: 'proj-a' }));
        store.projects.create(makeProjectInput({ id: 'proj-b' }));
        store.chats.create(makeChatInput({ id: 'chat-a', profileId, projectId: 'proj-a', workspaceRoot: '/ws' }));
        store.chats.create(makeChatInput({ id: 'chat-b', profileId, projectId: 'proj-b' }));

        store.projects.delete('proj-a');

        expect(store.chats.get('chat-a')).toMatchObject({ projectId: null, workspaceRoot: '/ws' });
        expect(store.chats.get('chat-b')!.projectId).toBe('proj-b');
      });

      it("deleting a profile clears it as a project's default profile", () => {
        const { profileId } = seedProfile(store, 'profile-a');
        const { profileId: otherId } = seedProfile(store, 'profile-b');
        store.projects.create(makeProjectInput({ id: 'proj-a', defaultProfileId: profileId }));
        store.projects.create(makeProjectInput({ id: 'proj-b', defaultProfileId: otherId }));

        store.profiles.delete(profileId);

        expect(store.projects.get('proj-a')!.defaultProfileId).toBeNull();
        expect(store.projects.get('proj-b')!.defaultProfileId).toBe(otherId);
      });
    });

    describe('chats: memory fields', () => {
      function addProject(id: string): void {
        store.projects.create({ id, name: id, workspaceRoot: null, defaultProfileId: null });
      }

      it('memoryCursor defaults to null and memoryExcluded to false; both round-trip through create, update and list', () => {
        const { profileId } = seedProfile(store, 'profile-a');
        const created = store.chats.create(makeChatInput({ id: 'chat-a', profileId }));
        expect(created).toMatchObject({ memoryCursor: null, memoryExcluded: false });
        expect(store.chats.get('chat-a')).toMatchObject({ memoryCursor: null, memoryExcluded: false });

        store.chats.update('chat-a', { memoryCursor: 'msg-9', memoryExcluded: true });
        expect(store.chats.get('chat-a')).toMatchObject({ memoryCursor: 'msg-9', memoryExcluded: true });
        expect(store.chats.list().find((c) => c.id === 'chat-a')).toMatchObject({ memoryCursor: 'msg-9', memoryExcluded: true });

        store.chats.create(makeChatInput({ id: 'chat-b', profileId, memoryExcluded: true }));
        expect(store.chats.get('chat-b')!.memoryExcluded).toBe(true);
      });

      it('moving a chat to another project, or out of one, resets its memory cursor; other updates keep it', () => {
        const { profileId } = seedProfile(store, 'profile-a');
        addProject('proj-a');
        addProject('proj-b');
        store.chats.create(makeChatInput({ id: 'chat-a', profileId, projectId: 'proj-a' }));
        store.chats.update('chat-a', { memoryCursor: 'msg-1' });

        store.chats.update('chat-a', { title: 'Renamed', projectId: 'proj-a' });
        expect(store.chats.get('chat-a')!.memoryCursor).toBe('msg-1');

        expect(store.chats.update('chat-a', { projectId: 'proj-b' }).memoryCursor).toBeNull();
        expect(store.chats.get('chat-a')!.memoryCursor).toBeNull();

        store.chats.update('chat-a', { memoryCursor: 'msg-2' });
        store.chats.update('chat-a', { projectId: null });
        expect(store.chats.get('chat-a')!.memoryCursor).toBeNull();
      });

      it("deleting a project clears its chats' memory cursors and leaves other chats alone", () => {
        const { profileId } = seedProfile(store, 'profile-a');
        addProject('proj-a');
        addProject('proj-b');
        store.chats.create(makeChatInput({ id: 'chat-a', profileId, projectId: 'proj-a' }));
        store.chats.create(makeChatInput({ id: 'chat-b', profileId, projectId: 'proj-b' }));
        store.chats.update('chat-a', { memoryCursor: 'msg-a' });
        store.chats.update('chat-b', { memoryCursor: 'msg-b' });

        store.projects.delete('proj-a');

        expect(store.chats.get('chat-a')).toMatchObject({ projectId: null, memoryCursor: null });
        expect(store.chats.get('chat-b')!.memoryCursor).toBe('msg-b');
      });
    });

    describe('projectMemory', () => {
      beforeEach(() => {
        store.projects.create({ id: 'proj-a', name: 'A', workspaceRoot: null, defaultProfileId: null });
        store.projects.create({ id: 'proj-b', name: 'B', workspaceRoot: null, defaultProfileId: null });
      });

      it('get is null until the first save; save stores the note and returns it', () => {
        expect(store.projectMemory.get('proj-a')).toBeNull();

        const saved = store.projectMemory.save('proj-a', 'note one', 'user', null, 1000);
        expect(saved).toEqual({ projectId: 'proj-a', body: 'note one', updatedAt: 1000, updatedBy: 'user', sourceChatId: null });
        expect(store.projectMemory.get('proj-a')).toEqual(saved);

        store.projectMemory.save('proj-a', 'note two', 'summariser', 'chat-x', 2000);
        expect(store.projectMemory.get('proj-a')).toEqual({ projectId: 'proj-a', body: 'note two', updatedAt: 2000, updatedBy: 'summariser', sourceChatId: 'chat-x' });
        expect(store.projectMemory.get('proj-b')).toBeNull();
      });

      it('defaults the save time to now', () => {
        expectRecentTimestamp(store.projectMemory.save('proj-a', 'note', 'user', null).updatedAt);
      });

      it('every save adds a version; versions come newest first, per project, and version(id) returns one', () => {
        store.projectMemory.save('proj-a', 'first', 'user', null, 1000);
        store.projectMemory.save('proj-a', 'second', 'summariser', 'chat-x', 2000);
        store.projectMemory.save('proj-b', 'other', 'user', null, 1500);

        const versions = store.projectMemory.versions('proj-a');
        expect(versions.map((v) => [v.projectId, v.body, v.createdAt, v.createdBy, v.sourceChatId])).toEqual([
          ['proj-a', 'second', 2000, 'summariser', 'chat-x'],
          ['proj-a', 'first', 1000, 'user', null],
        ]);
        expect(store.projectMemory.version(versions[1]!.id)).toEqual(versions[1]);
        expect(store.projectMemory.version('does-not-exist')).toBeNull();
      });

      it(`keeps only the newest ${MEMORY_VERSIONS_KEPT} versions per project, even when they share a timestamp`, () => {
        for (let i = 0; i < MEMORY_VERSIONS_KEPT + 5; i++) store.projectMemory.save('proj-a', `body ${i}`, 'user', null, 5000);
        store.projectMemory.save('proj-b', 'other', 'user', null, 1);

        const versions = store.projectMemory.versions('proj-a');
        expect(versions).toHaveLength(MEMORY_VERSIONS_KEPT);
        expect(versions[0]!.body).toBe(`body ${MEMORY_VERSIONS_KEPT + 4}`);
        expect(versions.at(-1)!.body).toBe('body 5');
        expect(store.projectMemory.versions('proj-b')).toHaveLength(1);
      });

      it('deleting a project deletes its note and its versions', () => {
        store.projectMemory.save('proj-a', 'note', 'user', null, 1000);
        const versionId = store.projectMemory.versions('proj-a')[0]!.id;
        store.projectMemory.save('proj-b', 'kept', 'user', null, 1000);

        store.projects.delete('proj-a');

        expect(store.projectMemory.get('proj-a')).toBeNull();
        expect(store.projectMemory.versions('proj-a')).toEqual([]);
        expect(store.projectMemory.version(versionId)).toBeNull();
        expect(store.projectMemory.get('proj-b')!.body).toBe('kept');
      });

      it('saving for a project that does not exist throws', () => {
        expect(() => store.projectMemory.save('does-not-exist', 'note', 'user', null)).toThrow(Error);
        expect(store.projectMemory.get('does-not-exist')).toBeNull();
      });
    });

    describe('settings', () => {
      it('starts with no memory model, stores one, ignores an empty patch, and clears it with null', () => {
        expect(store.settings.get()).toEqual({ memoryProfileId: null });
        expect(store.settings.update({ memoryProfileId: 'profile-a' })).toEqual({ memoryProfileId: 'profile-a' });
        expect(store.settings.get()).toEqual({ memoryProfileId: 'profile-a' });
        expect(store.settings.update({})).toEqual({ memoryProfileId: 'profile-a' });
        store.settings.update({ memoryProfileId: null });
        expect(store.settings.get()).toEqual({ memoryProfileId: null });
      });
    });

    it('attachments: create/get round-trip', () => {
      const { chat } = seedChat(store, 'chat-a');
      store.attachments.create(makeAttachment({ id: 'att-a', chatId: chat.id, filename: 'photo.png' }));
      expect(store.attachments.get('att-a')).toMatchObject({ id: 'att-a', chatId: chat.id, filename: 'photo.png' });
    });

    describe('attachments: isReferenced / referencedShas', () => {
      it('isReferenced is false for a sha256 no row has', () => {
        expect(store.attachments.isReferenced('no-such-sha')).toBe(false);
      });

      it('isReferenced is true once a row has that sha256, and false again once it is deleted', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.attachments.create(makeAttachment({ id: 'att-a', chatId: chat.id, sha256: 'sha-x' }));

        expect(store.attachments.isReferenced('sha-x')).toBe(true);

        store.attachments.delete('att-a');

        expect(store.attachments.isReferenced('sha-x')).toBe(false);
      });

      it('isReferenced stays true while a SECOND row (in a different chat) still shares the sha256, even after the first row is deleted', () => {
        const { chat: chatA } = seedChat(store, 'chat-a');
        const { chat: chatB } = seedChat(store, 'chat-b');
        store.attachments.create(makeAttachment({ id: 'att-a', chatId: chatA.id, sha256: 'shared-sha' }));
        store.attachments.create(makeAttachment({ id: 'att-b', chatId: chatB.id, sha256: 'shared-sha' }));

        store.attachments.delete('att-a');
        expect(store.attachments.isReferenced('shared-sha')).toBe(true);

        store.attachments.delete('att-b');
        expect(store.attachments.isReferenced('shared-sha')).toBe(false);
      });

      it('referencedShas returns every distinct sha256 across every chat, and updates as rows are deleted', () => {
        const { chat: chatA } = seedChat(store, 'chat-a');
        const { chat: chatB } = seedChat(store, 'chat-b');
        store.attachments.create(makeAttachment({ id: 'att-a', chatId: chatA.id, sha256: 'sha-1' }));
        store.attachments.create(makeAttachment({ id: 'att-b', chatId: chatB.id, sha256: 'sha-2' }));
        // Same sha256 as att-a, in a different chat -- must not duplicate in the set.
        store.attachments.create(makeAttachment({ id: 'att-c', chatId: chatB.id, sha256: 'sha-1' }));

        expect(store.attachments.referencedShas()).toEqual(new Set(['sha-1', 'sha-2']));

        store.attachments.delete('att-b');
        expect(store.attachments.referencedShas()).toEqual(new Set(['sha-1']));
      });

      it('referencedShas is empty when there are no attachment rows at all', () => {
        expect(store.attachments.referencedShas()).toEqual(new Set());
      });
    });

    it('usage: create/get round-trip', () => {
      const { chat, profileId, connectionId, modelId } = seedChat(store, 'chat-a');
      const message = store.messages.create(makeMessageInput({ id: 'msg-a', chatId: chat.id }));
      store.usage.create(
        makeUsageRecord({
          id: 'usage-a',
          chatId: chat.id,
          messageId: message.id,
          profileId,
          connectionId,
          modelId,
          tokensIn: 42,
        })
      );
      expect(store.usage.get('usage-a')).toMatchObject({ id: 'usage-a', chatId: chat.id, tokensIn: 42 });
    });

    it('mcpServers: create/get round-trip', () => {
      store.mcpServers.create(makeMcpServer({ id: 'mcp-a', name: 'My MCP Server' }));
      expect(store.mcpServers.get('mcp-a')).toMatchObject({ id: 'mcp-a', name: 'My MCP Server' });
    });

    it('audit: create/get round-trip, defaulting createdAt', () => {
      const { chat } = seedChat(store, 'chat-a');
      const message = store.messages.create(makeMessageInput({ id: 'msg-a', chatId: chat.id }));
      const created = store.audit.create(makeAuditInput({ id: 'audit-a', chatId: chat.id, messageId: message.id }));

      expectRecentTimestamp(created.createdAt);
      expect(store.audit.get('audit-a')).toMatchObject({ id: 'audit-a', chatId: chat.id });
    });

    describe('messages', () => {
      it('create/get round-trip, defaulting createdAt', () => {
        const { chat } = seedChat(store, 'chat-a');
        const created = store.messages.create(makeMessageInput({ id: 'msg-a', chatId: chat.id }));

        expectRecentTimestamp(created.createdAt);
        expect(store.messages.get('msg-a')).toMatchObject({ id: 'msg-a', chatId: chat.id });
        expect(store.messages.get('does-not-exist')).toBeNull();
      });

      it('engineMeta: absent by default, set by updateEngineMeta, carried by get and pathToRoot', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'u1', chatId: chat.id }));
        store.messages.create(makeMessageInput({ id: 'a1', chatId: chat.id, parentId: 'u1', role: 'assistant' }));
        expect('engineMeta' in store.messages.get('a1')!).toBe(false);
        const meta = { engine: 'claude_code' as const, sessionId: 's1', backend: 'claude', cwd: '/ws' };
        store.messages.updateEngineMeta('a1', meta);
        expect(store.messages.get('a1')!.engineMeta).toEqual(meta);
        expect(store.messages.pathToRoot('a1')[1]!.engineMeta).toEqual(meta);
        expect('engineMeta' in store.messages.pathToRoot('a1')[0]!).toBe(false);
        expect(store.messages.children('u1')[0]!.engineMeta).toEqual(meta);
        expect(() => store.messages.updateEngineMeta('nope', meta)).toThrow();
      });

      it('keptAt: absent by default, set by markKept, carried by get, children and pathToRoot', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'u1', chatId: chat.id }));
        store.messages.create(makeMessageInput({ id: 'a1', chatId: chat.id, parentId: 'u1', role: 'assistant' }));
        expect('keptAt' in store.messages.get('a1')!).toBe(false);
        store.messages.markKept('a1', 1234);
        expect(store.messages.get('a1')!.keptAt).toBe(1234);
        expect(store.messages.children('u1')[0]!.keptAt).toBe(1234);
        expect(store.messages.pathToRoot('a1')[1]!.keptAt).toBe(1234);
        expect('keptAt' in store.messages.pathToRoot('a1')[0]!).toBe(false);
        store.messages.markKept('a1', 5678);
        expect(store.messages.get('a1')!.keptAt).toBe(5678);
        expect(() => store.messages.markKept('nope', 1)).toThrow();
      });

      it('latestBySession returns the newest message carrying that session id in the chat', () => {
        const { chat } = seedChat(store, 'chat-a');
        const meta = (sessionId: string) => ({ engine: 'claude_code' as const, sessionId, backend: 'claude', cwd: '/ws' });
        store.messages.create(makeMessageInput({ id: 'u1', chatId: chat.id, createdAt: 1 }));
        store.messages.create(makeMessageInput({ id: 'a1', chatId: chat.id, parentId: 'u1', role: 'assistant', createdAt: 2 }));
        store.messages.create(makeMessageInput({ id: 'u2', chatId: chat.id, parentId: 'a1', createdAt: 3 }));
        store.messages.create(makeMessageInput({ id: 'a2', chatId: chat.id, parentId: 'u2', role: 'assistant', createdAt: 4 }));
        store.messages.updateEngineMeta('a1', meta('s1'));
        expect(store.messages.latestBySession(chat.id, 's1')!.id).toBe('a1');
        store.messages.updateEngineMeta('a2', meta('s1'));
        expect(store.messages.latestBySession(chat.id, 's1')!.id).toBe('a2');
        expect(store.messages.latestBySession(chat.id, 'other')).toBeNull();
      });

      it('children returns child messages ordered by creation time, not insertion order', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'parent', chatId: chat.id, createdAt: 1 }));
        // deliberately inserted out of chronological order
        store.messages.create(makeMessageInput({ id: 'child-2', chatId: chat.id, parentId: 'parent', createdAt: 30 }));
        store.messages.create(makeMessageInput({ id: 'child-1', chatId: chat.id, parentId: 'parent', createdAt: 10 }));
        store.messages.create(makeMessageInput({ id: 'child-3', chatId: chat.id, parentId: 'parent', createdAt: 20 }));

        expect(store.messages.children('parent').map((m) => m.id)).toEqual(['child-1', 'child-3', 'child-2']);
      });

      // A compare turn queries several models for the same user turn at
      // once, so their replies routinely land in the same millisecond --
      // `createdAt` alone cannot order them, and an implementation that only
      // sorts by `createdAt` would return them in whatever order they
      // happen to be stored, not a deterministic one. Ids are deliberately
      // created out of alphabetical order here so a correct id tie-break is
      // the only way to pass.
      it('children breaks a created_at tie by id (the compare-turn case: several replies in the same millisecond)', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'parent', chatId: chat.id, createdAt: 1 }));
        store.messages.create(makeMessageInput({ id: 'reply-c', chatId: chat.id, parentId: 'parent', createdAt: 5 }));
        store.messages.create(makeMessageInput({ id: 'reply-a', chatId: chat.id, parentId: 'parent', createdAt: 5 }));
        store.messages.create(makeMessageInput({ id: 'reply-b', chatId: chat.id, parentId: 'parent', createdAt: 5 }));

        expect(store.messages.children('parent').map((m) => m.id)).toEqual(['reply-a', 'reply-b', 'reply-c']);
      });

      it('roots returns only the given chat\'s root messages', () => {
        const { chat: chatA } = seedChat(store, 'chat-a');
        const { chat: chatB } = seedChat(store, 'chat-b');
        store.messages.create(makeMessageInput({ id: 'root-a1', chatId: chatA.id, createdAt: 1 }));
        store.messages.create(makeMessageInput({ id: 'root-a2', chatId: chatA.id, createdAt: 2 }));
        store.messages.create(makeMessageInput({ id: 'child-a1', chatId: chatA.id, parentId: 'root-a1', createdAt: 3 }));
        store.messages.create(makeMessageInput({ id: 'root-b1', chatId: chatB.id, createdAt: 1 }));

        expect(store.messages.roots(chatA.id).map((m) => m.id).sort()).toEqual(['root-a1', 'root-a2']);
      });

      it('pathToRoot returns messages in root -> leaf order', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'root', chatId: chat.id, createdAt: 1 }));
        store.messages.create(makeMessageInput({ id: 'mid', chatId: chat.id, parentId: 'root', createdAt: 2 }));
        store.messages.create(makeMessageInput({ id: 'leaf', chatId: chat.id, parentId: 'mid', createdAt: 3 }));

        expect(store.messages.pathToRoot('leaf').map((m) => m.id)).toEqual(['root', 'mid', 'leaf']);
      });

      it('updateParts persists the new parts', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'msg-a', chatId: chat.id }));
        const newParts: Part[] = [{ type: 'text', text: 'updated content' }];

        store.messages.updateParts('msg-a', newParts);

        expect(store.messages.get('msg-a')?.parts).toEqual(newParts);
      });

      it('updateStatus persists the status and error', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'msg-a', chatId: chat.id, status: 'streaming' }));

        store.messages.updateStatus('msg-a', 'error', { kind: 'transient', message: 'boom', retryable: true });

        const after = store.messages.get('msg-a');
        expect(after?.status).toBe('error');
        expect(after?.error).toEqual({ kind: 'transient', message: 'boom', retryable: true });
      });

      it('searchText finds a message by a word appearing in one of its text parts', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(
          makeMessageInput({
            id: 'msg-findable',
            chatId: chat.id,
            parts: [{ type: 'text', text: 'The quick brown fox jumps' }],
          })
        );

        const results = store.messages.searchText('brown', 10);

        expect(results.some((r) => r.messageId === 'msg-findable')).toBe(true);
      });

      it('searchText does not match a message whose only text lives in a different chat\'s message', () => {
        const { chat: chatA } = seedChat(store, 'chat-a');
        const { chat: chatB } = seedChat(store, 'chat-b');
        store.messages.create(
          makeMessageInput({
            id: 'msg-chat-a',
            chatId: chatA.id,
            parts: [{ type: 'text', text: 'zephyrwombat unique token' }],
          })
        );
        store.messages.create(
          makeMessageInput({
            id: 'msg-chat-b',
            chatId: chatB.id,
            parts: [{ type: 'text', text: 'a totally unrelated message' }],
          })
        );

        const results = store.messages.searchText('zephyrwombat', 10);

        expect(results.map((r) => r.messageId)).toEqual(['msg-chat-a']);
        expect(results.every((r) => r.chatId === chatA.id)).toBe(true);
      });

      // Every one of these is an ordinary thing a person might type into a
      // search box, not an adversarial payload -- a lone quote, a trailing
      // boolean operator, an unclosed paren, a leading dash, and a
      // `col:value` form. Against a raw FTS5 MATCH these throw a syntax
      // error; the fix must escape/tolerate them instead of crashing the
      // search. Kept permissive on purpose (no snippet/ranking assertions)
      // per the brief -- the point is "doesn't throw", not "matches exactly
      // this way".
      it.each([
        ['a lone double quote', '"'],
        ['a dangling boolean operator', 'banana AND'],
        ['an unclosed parenthesis', '(unclosed'],
        ['a leading dash (NOT-prefix syntax)', '-banana'],
        ['column-filter syntax', 'col:banana'],
      ])('searchText does not throw for %s (%j)', (_label, query) => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(
          makeMessageInput({
            id: 'msg-a',
            chatId: chat.id,
            parts: [{ type: 'text', text: 'ordinary message content' }],
          })
        );

        expect(() => store.messages.searchText(query, 10)).not.toThrow();
      });

      it('searchText still finds a message by an ordinary word after tricky queries have run', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(
          makeMessageInput({
            id: 'msg-mango',
            chatId: chat.id,
            parts: [{ type: 'text', text: 'The mango recipe needs banana and honey' }],
          })
        );

        // Run the same tricky queries as above first, to prove they leave
        // ordinary search working rather than merely not crashing in isolation.
        for (const query of ['"', 'banana AND', '(unclosed', '-banana', 'col:banana']) {
          store.messages.searchText(query, 10);
        }

        const results = store.messages.searchText('mango', 10);
        expect(results.some((r) => r.messageId === 'msg-mango')).toBe(true);
      });

      it('searchText treats a dangling "AND" as a literal word, finding a message containing both words', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(
          makeMessageInput({
            id: 'msg-both-words',
            chatId: chat.id,
            parts: [{ type: 'text', text: 'banana and honey on toast' }],
          })
        );

        const results = store.messages.searchText('banana AND', 10);

        expect(results.some((r) => r.messageId === 'msg-both-words')).toBe(true);
      });

      it('create throws on a duplicate id', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.messages.create(makeMessageInput({ id: 'msg-a', chatId: chat.id }));

        expect(() => store.messages.create(makeMessageInput({ id: 'msg-a', chatId: chat.id }))).toThrow(Error);
      });

      it('create throws on a self-referencing parentId', () => {
        const { chat } = seedChat(store, 'chat-a');

        expect(() =>
          store.messages.create(makeMessageInput({ id: 'msg-self', chatId: chat.id, parentId: 'msg-self' }))
        ).toThrow(Error);
      });

      it('pathToRoot returns [] for an unknown id', () => {
        expect(store.messages.pathToRoot('does-not-exist')).toEqual([]);
      });

      it('updateParts throws when the id does not exist', () => {
        expect(() => store.messages.updateParts('does-not-exist', [{ type: 'text', text: 'x' }])).toThrow(Error);
      });

      it('updateStatus throws when the id does not exist', () => {
        expect(() => store.messages.updateStatus('does-not-exist', 'complete')).toThrow(Error);
      });

      it('listByStatus returns every message at that status across every chat, and none at another status', () => {
        const { chat: chatA } = seedChat(store, 'chat-a');
        const { chat: chatB } = seedChat(store, 'chat-b');
        store.messages.create(makeMessageInput({ id: 'streaming-a', chatId: chatA.id, status: 'streaming' }));
        store.messages.create(makeMessageInput({ id: 'streaming-b', chatId: chatB.id, status: 'streaming' }));
        store.messages.create(makeMessageInput({ id: 'complete-a', chatId: chatA.id, status: 'complete' }));

        expect(store.messages.listByStatus('streaming').map((m) => m.id).sort()).toEqual(['streaming-a', 'streaming-b']);
        expect(store.messages.listByStatus('complete').map((m) => m.id)).toEqual(['complete-a']);
      });

      it('listByStatus returns [] when nothing is at that status', () => {
        expect(store.messages.listByStatus('streaming')).toEqual([]);
      });
    });

    describe('grants', () => {
      it('create/get round-trip', () => {
        const { chat } = seedChat(store, 'chat-a');
        store.grants.create(makeGrant({ id: 'grant-a', chatId: chat.id }));
        expect(store.grants.get('grant-a')).toMatchObject({ id: 'grant-a', chatId: chat.id });
      });

      it('list filters grants by chat', () => {
        const { chat: chatA } = seedChat(store, 'chat-a');
        const { chat: chatB } = seedChat(store, 'chat-b');
        store.grants.create(makeGrant({ id: 'grant-a', chatId: chatA.id }));
        store.grants.create(makeGrant({ id: 'grant-b', chatId: chatB.id }));

        expect(store.grants.list(chatA.id).map((g) => g.id)).toEqual(['grant-a']);
      });
    });

    describe('update / delete semantics shared across the simple repos', () => {
      // Exercised via `connections` as a representative of the simple,
      // non-tree repos (models/profiles/attachments/usage/mcpServers/grants/
      // audit all share this same InMemoryCrudRepo-backed behaviour). This
      // is the exact policy documented at the top of fakes.ts -- it was
      // previously only documented, never asserted, which is precisely the
      // drift the shared contract exists to catch: a SQLite adapter (Task 9)
      // that throws a different shape on a missing-id update, or throws
      // instead of no-op-ing on a missing-id delete, or accepts a duplicate
      // id silently, must fail these.

      it('create throws on a duplicate id', () => {
        store.connections.create(makeConnection({ id: 'conn-a' }));

        expect(() => store.connections.create(makeConnection({ id: 'conn-a' }))).toThrow(Error);
      });

      it('update persists a patch and returns the updated entity', () => {
        store.connections.create(makeConnection({ id: 'conn-a', name: 'Before' }));

        const updated = store.connections.update('conn-a', { name: 'After' });

        expect(updated.name).toBe('After');
        expect(store.connections.get('conn-a')?.name).toBe('After');
      });

      it('update throws when the id does not exist', () => {
        expect(() => store.connections.update('does-not-exist', { name: 'x' })).toThrow(Error);
      });

      it('delete removes the entity so a subsequent get returns null', () => {
        store.connections.create(makeConnection({ id: 'conn-a' }));

        store.connections.delete('conn-a');

        expect(store.connections.get('conn-a')).toBeNull();
      });

      it('delete is a no-op when the id does not exist (idempotent)', () => {
        expect(() => store.connections.delete('does-not-exist')).not.toThrow();
        expect(store.connections.get('does-not-exist')).toBeNull();
      });
    });
  });
}
