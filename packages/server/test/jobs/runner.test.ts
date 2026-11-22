import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { TurnEvent, TurnInput, TurnResult } from '@otherbench/core/domain/turn.js';
import { FakeSandbox, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import { INSTALL_HOSTS, SANDBOX_PLACEHOLDERS } from '../../src/jobs/git.js';
import { createJobRunner, type JobRunnerDeps } from '../../src/jobs/runner.js';

// A job folder is always a clone of the app: a real folder with a plain .git in it.
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'otherbench-runner-')));
const FOLDER = join(ROOT, 'one');
mkdirSync(join(FOLDER, '.git'), { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function profile(over: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return { id: 'p1', name: 'Worker', archivedAt: null, toolPolicy: { fs: 'read', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, ...over } as unknown as ResolvedProfile;
}

function setup(over: Partial<JobRunnerDeps> = {}) {
  const store = new InMemoryStore();
  const listeners = new Set<(e: TurnEvent) => void>();
  const started: TurnInput[] = [];
  const sandbox = new FakeSandbox({ ready: true });
  const deps: JobRunnerDeps = {
    store,
    startTurn: vi.fn(async (input: TurnInput): Promise<TurnResult> => {
      started.push(input);
      // TurnRunner reads the job folder for the chat before it runs anything.
      expect(store.jobChats.folderFor(input.chatId)).toBe(FOLDER);
      return { userMessageId: 'u1', assistantMessageIds: ['a1'] };
    }),
    turnRunner: { on: (cb) => (listeners.add(cb), () => listeners.delete(cb)), cancel: vi.fn() },
    resolveProfile: vi.fn(async (id: string) => profile({ id })),
    defaultProfileId: () => 'p-default',
    sandbox,
    closeChats: vi.fn(),
    ...over,
  };
  return { store, deps, runner: createJobRunner(deps), started, sandbox, emit: (e: TurnEvent) => listeners.forEach((l) => l(e)) };
}

describe('JobRunner', () => {
  it('createChat records the chat as a job chat in its folder, on this machine, never in Auto', () => {
    const { store, runner } = setup();
    const { chatId } = runner.createChat({ title: 'Job: App (j1)', folder: FOLDER, profileId: 'p1' });
    expect(store.jobChats.folderFor(chatId)).toBe(FOLDER);
    const chat = store.chats.get(chatId);
    expect(chat).toMatchObject({ title: 'Job: App (j1)', profileId: 'p1', autoMode: false, projectId: null, appId: null, workspace: { kind: 'machine', root: FOLDER } });
    // The brief is untrusted: nothing from a job chat reaches a memory note.
    expect(chat!.memoryExcluded).toBe(true);
  });

  it("createChat puts the chat in the app it names, so the Code tab lists it there, and refuses an app that isn't here", () => {
    const { store, runner } = setup();
    store.apps.create({ id: 'app-1', name: 'Shop' });
    const { chatId } = runner.createChat({ title: 'Job', folder: FOLDER, profileId: 'p1', appId: 'app-1' });
    // Still in the job's own folder, not the app's, and still a job chat.
    expect(store.chats.get(chatId)).toMatchObject({ appId: 'app-1', projectId: null, workspace: { kind: 'machine', root: FOLDER } });
    expect(store.jobChats.folderFor(chatId)).toBe(FOLDER);
    expect(() => runner.createChat({ title: 'Job', folder: FOLDER, profileId: 'p1', appId: 'gone' })).toThrow(/app/);
    expect(store.chats.list()).toHaveLength(1);
  });

  it("createChat records a chat made with its app's knowledge, and refuses that for a chat with no app", () => {
    const { store, runner } = setup();
    store.apps.create({ id: 'app-1', name: 'Shop' });
    const plain = runner.createChat({ title: 'Job', folder: FOLDER, profileId: 'p1', appId: 'app-1' });
    const knowing = runner.createChat({ title: 'Job', folder: FOLDER, profileId: 'p1', appId: 'app-1', appContext: true });
    expect(store.jobChats.appContextFor(plain.chatId)).toBe(false);
    expect(store.jobChats.appContextFor(knowing.chatId)).toBe(true);
    expect(() => runner.createChat({ title: 'Job', folder: FOLDER, profileId: 'p1', appContext: true })).toThrow(/app/);
    expect(store.chats.list()).toHaveLength(2);
  });

  it("createChat refuses a folder that isn't a job's clone: relative, missing, without a plain .git, or the home folder or one above it", () => {
    const { store, runner } = setup();
    const noGit = join(ROOT, 'no-git');
    mkdirSync(noGit);
    const gitFile = join(ROOT, 'git-file');
    mkdirSync(gitFile);
    writeFileSync(join(gitFile, '.git'), 'gitdir: elsewhere\n');
    for (const folder of ['jobs/one', join(ROOT, 'missing'), noGit, gitFile]) {
      expect(() => runner.createChat({ title: 'Job', folder, profileId: 'p1' }), folder).toThrow();
    }
    // A clone that is the home folder, or holds it, is refused for that alone.
    for (const home of [FOLDER, join(FOLDER, 'inner')]) {
      const { runner: r, store: s } = setup({ homeDir: () => home });
      expect(() => r.createChat({ title: 'Job', folder: FOLDER, profileId: 'p1' }), home).toThrow(/home/);
      expect(s.chats.list()).toEqual([]);
    }
    expect(store.chats.list()).toEqual([]);
  });

  it('starts an unattended turn from the chat tip with the resolved profile', async () => {
    const { runner, started } = setup();
    const { chatId } = runner.createChat({ title: 'Job', folder: FOLDER, profileId: 'p1' });
    await expect(runner.startTurn({ chatId, text: 'Do the task', profileId: 'p1' })).resolves.toEqual({ userMessageId: 'u1', messageId: 'a1' });
    expect(started[0]).toMatchObject({ chatId, parentId: null, unattended: true, userParts: [{ type: 'text', text: 'Do the task' }], profiles: [expect.objectContaining({ id: 'p1' })] });
  });

  it('profile() takes the default for null, and says when one is archived', async () => {
    const { runner } = setup({ resolveProfile: vi.fn(async (id: string) => profile({ id, archivedAt: id === 'old' ? 5 : null })) });
    await expect(runner.profile(null)).resolves.toMatchObject({ id: 'p-default', archived: false });
    await expect(runner.profile('old')).resolves.toMatchObject({ id: 'old', archived: true });
  });

  it('profile() is null when there is no profile at all', async () => {
    const { runner } = setup({ defaultProfileId: () => null });
    await expect(runner.profile(null)).resolves.toBeNull();
  });

  it('tells a listener when a reply ends, and not while it streams', () => {
    const { runner, emit } = setup();
    const ended = vi.fn();
    runner.onReplyEnded(ended);
    emit({ type: 'status', messageId: 'a1', status: 'streaming' });
    emit({ type: 'status', messageId: 'a1', status: 'complete' });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith('a1', 'complete');
  });

  it('runCommand gives the install command the registry hosts and a test none, and never asks', async () => {
    const { runner, sandbox } = setup();
    await runner.runCommand({ chatId: 'c1', folder: FOLDER, command: 'npm ci', network: 'install' });
    await runner.runCommand({ chatId: 'c1', folder: FOLDER, command: 'npm test', network: 'none' });
    expect(sandbox.requests.map((r) => r.allowedHosts)).toEqual([[...INSTALL_HOSTS], []]);
    expect(sandbox.requests.every((r) => r.fs === 'readwrite' && r.workspaceRoot === FOLDER && r.folders.length === 0)).toBe(true);
    await expect(sandbox.requests[0]!.askHost('example.com', 443)).resolves.toBe(false);
  });

  it('runCommand says so when there is no sandbox', async () => {
    const { runner } = setup({ sandbox: null });
    await expect(runner.runCommand({ chatId: 'c1', folder: FOLDER, command: 'npm test', network: 'none' })).resolves.toMatchObject({ ok: false, summary: expect.stringMatching(/no sandbox/) });
  });

  it('refusedCalls counts refusals since the start, but not cancellations or earlier ones', () => {
    const { store, runner } = setup();
    let n = 0;
    const add = (grantedBy: string, createdAt: number): void => {
      store.audit.create({ id: `au${n++}`, chatId: 'c1', messageId: 'a1', toolName: 'x', argsRedacted: {}, resultSummary: '', durationMs: 0, grantedBy, createdAt });
    };
    add('deny:job', 50);
    add('deny:job', 150);
    add('deny:unattended', 160);
    add('deny:cancelled', 170);
    add('job', 180);
    expect(runner.refusedCalls('c1', 100)).toBe(2);
  });

  it('uncommitted leaves out untracked sandbox placeholders but keeps a changed tracked .gitmodules', async () => {
    const placeholder = SANDBOX_PLACEHOLDERS[0]!.replace(/^\/|\/$/g, '');
    const sandbox = new FakeSandbox({ ready: true, result: () => ({ exitCode: 0, output: `?? ${placeholder}\n M .gitmodules\n?? new.txt\n` }) });
    const { runner } = setup({ sandbox });
    await expect(runner.uncommitted('c1', FOLDER)).resolves.toEqual({ files: 2, summary: ' M .gitmodules\n?? new.txt' });
    expect(sandbox.requests[0]!.allowedHosts).toEqual([]);
  });

  it('cancel, closeChat and releaseSandbox reach the turn runner, engine and sandbox', async () => {
    const { runner, deps, sandbox } = setup();
    runner.cancel('a1', 'Stopped.');
    runner.closeChat('c1');
    await runner.releaseSandbox('c1');
    expect(deps.turnRunner.cancel).toHaveBeenCalledWith('a1', 'Stopped.');
    expect(deps.closeChats).toHaveBeenCalled();
    expect(sandbox.released).toEqual(['c1']);
  });
});
