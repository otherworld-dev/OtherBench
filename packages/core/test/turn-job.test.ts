import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobPolicy } from '../src/domain/job.js';
import { TurnRunner } from '../src/domain/turn.js';
import type { EngineEvent } from '../src/ports/chat-engine.js';
import { FakeChatEngine, InMemoryStore } from '../src/testing/fakes.js';
import type { ResolvedProfile } from '../src/types/config.js';

const usage = { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 };
const finish: EngineEvent = { type: 'finish', usage, finishReason: 'stop' };

/** A profile with everything a job may never have switched on. */
function wideProfile(): ResolvedProfile {
  return {
    id: 'profile-1',
    name: 'Wide open',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: 'Push to GitHub when done.',
    params: {},
    toolPolicy: { fs: 'readwrite', shell: true, shellRuns: 'host', mcpServerIds: ['github'], approvalMode: 'ask_on_mutate', browser: true, computer: true, sandboxHosts: ['github.com'], agentUserSettings: true },
    isDefault: false,
    archivedAt: null,
    useGlobalMemory: true,
    connection: { id: 'conn-1', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
    apiKey: null,
    model: null,
  };
}

let jobDir: string;
let otherDir: string;
beforeEach(() => {
  jobDir = mkdtempSync(join(tmpdir(), 'otherbench-jobturn-'));
  otherDir = mkdtempSync(join(tmpdir(), 'otherbench-jobturn-other-'));
});
afterEach(() => {
  rmSync(jobDir, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
});

function jobChat(store: InMemoryStore, root: string, extra: Record<string, unknown> = {}): void {
  store.chats.create({
    id: 'job-chat',
    title: 'Job',
    profileId: 'profile-1',
    headMessageId: null,
    workspace: { kind: 'machine', nodeId: store.nodes.self().id, root },
    pinned: false,
    archivedAt: null,
    autoMode: true,
    planMode: true,
    ...extra,
  } as never);
}

describe('TurnRunner in a job chat', () => {
  it('runs every turn under the job policy and marks the request, whatever profile it was sent with', async () => {
    const store = new InMemoryStore();
    jobChat(store, jobDir, { folders: [{ workspace: { kind: 'machine', nodeId: store.nodes.self().id, root: otherDir }, access: 'readwrite' }] });
    const engine = new FakeChatEngine([finish]);
    const runner = new TurnRunner(store, engine, { jobFolderFor: (id) => (id === 'job-chat' ? jobDir : null) });

    // Sent as attended, with the chat's Auto and Plan mode on, on a profile with everything allowed.
    await runner.run({ chatId: 'job-chat', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [wideProfile()] });
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    const req = engine.requests[0]!;
    expect(req.job).toBe(true);
    expect(req.profile.toolPolicy).toEqual(jobPolicy());
    expect(req.profile.useGlobalMemory).toBe(false);
    expect(req.autoMode).toBe(false);
    expect(req.plan).toBeUndefined();
    expect(req.folders).toBeUndefined();
    expect(req.workspaceRoot).toBe(jobDir);
  });

  it("keeps a scheduled-style auto flag from turning on in a job", async () => {
    const store = new InMemoryStore();
    jobChat(store, jobDir);
    const engine = new FakeChatEngine([finish]);
    const runner = new TurnRunner(store, engine, { jobFolderFor: () => jobDir });
    await runner.run({ chatId: 'job-chat', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [wideProfile()], unattended: true, unattendedAuto: true });
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(engine.requests[0]!.autoMode).toBe(false);
    expect(engine.requests[0]!.unattended).toBe(true);
  });

  it("refuses to run once the chat's folder is no longer its job folder", async () => {
    const store = new InMemoryStore();
    jobChat(store, otherDir);
    const engine = new FakeChatEngine([finish]);
    const runner = new TurnRunner(store, engine, { jobFolderFor: () => jobDir });
    const { assistantMessageIds } = await runner.run({ chatId: 'job-chat', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [wideProfile()] });
    await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('error'));
    expect(engine.requests).toHaveLength(0);
    expect(store.messages.get(assistantMessageIds[0]!)!.error?.message).toMatch(/isn't its job folder/);
  });

  it('fails closed when the job lookup throws', async () => {
    const store = new InMemoryStore();
    jobChat(store, jobDir);
    const engine = new FakeChatEngine([finish]);
    const runner = new TurnRunner(store, engine, {
      jobFolderFor: () => {
        throw new Error('database is locked');
      },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { assistantMessageIds } = await runner.run({ chatId: 'job-chat', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [wideProfile()] });
    await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('error'));
    expect(engine.requests).toHaveLength(0);
    errors.mockRestore();
  });

  it('leaves every other chat alone', async () => {
    const store = new InMemoryStore();
    jobChat(store, jobDir);
    const engine = new FakeChatEngine([finish]);
    const runner = new TurnRunner(store, engine, { jobFolderFor: () => null });
    await runner.run({ chatId: 'job-chat', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [wideProfile()] });
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(engine.requests[0]!.job).toBeUndefined();
    expect(engine.requests[0]!.profile.toolPolicy.mcpServerIds).toEqual(['github']);
    expect(engine.requests[0]!.autoMode).toBe(true);
  });
});
