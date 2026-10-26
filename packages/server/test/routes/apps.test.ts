import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { Profile } from '@otherbench/core/types/config.js';
import type { IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import { GhError, githubService } from '../../src/code/github.js';
import type { Container } from '../../src/container.js';
import type { OverviewService } from '../../src/overview/service.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { AppEventBus, withChatEvents } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const made: string[] = [];

function tmp(prefix = 'ob-apps-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
function g(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
/** A temp repo with a local identity and no signing, so commits work on CI without global config. */
function repo(): string {
  const dir = tmp('ob-apps-repo-');
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const ISSUE: IssueSummary = {
  number: 48,
  title: 'MCP tools vanish',
  state: 'open',
  author: 'adam',
  labels: ['bug'],
  comments: 2,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  url: 'https://github.com/o/r/issues/48',
};

interface GithubCalls {
  list: [string, string][];
  view: [string, number][];
  comment: [string, number, string][];
  close: [string, number][];
  reopen: [string, number][];
}

let container: Container;
let store: InMemoryStore;
let dataDir: string;
let events: AppEvent[];
let calls: GithubCalls;
let githubFails: GhError | null;

function makeProfile(over: Partial<Profile> & { id: string }): Profile {
  return {
    name: over.id,
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...over,
  };
}

beforeEach(() => {
  dataDir = tmp('ob-apps-data-');
  store = new InMemoryStore('node-pc');
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  const bus = new AppEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  calls = { list: [], view: [], comment: [], close: [], reopen: [] };
  githubFails = null;
  const fail = (): void => {
    if (githubFails) throw githubFails;
  };
  container = {
    // Announcing chat changes, as createContainer's store does.
    store: withChatEvents(store, bus),
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    events: bus,
    github: {
      async list(repo, state) {
        calls.list.push([repo, state]);
        fail();
        return [ISSUE];
      },
      async view(repo, n): Promise<IssueDetail> {
        calls.view.push([repo, n]);
        fail();
        return { ...ISSUE, number: n, body: 'It vanished.', commentList: [] };
      },
      async comment(repo, n, body) {
        calls.comment.push([repo, n, body]);
        fail();
      },
      async close(repo, n) {
        calls.close.push([repo, n]);
        fail();
      },
      async reopen(repo, n) {
        calls.reopen.push([repo, n]);
        fail();
      },
    },
    close: () => {},
  };
  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create(makeProfile({ id: 'profile-1', isDefault: true }));
  store.profiles.create(makeProfile({ id: 'profile-coder' }));
  store.profiles.create(makeProfile({ id: 'profile-old', archivedAt: 1 }));
  store.projects.create({ id: 'proj-1', name: 'Planning', workspaceRoot: null, defaultProfileId: null });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** An app made straight in the store, its folder on this machine. */
function newApp(id: string, root: string, over: { githubRepo?: string | null; defaultProfileId?: string | null } = {}) {
  return store.apps.create({ id, name: id, workspaceRoot: root, githubRepo: over.githubRepo ?? null, defaultProfileId: over.defaultProfileId ?? null });
}

function newChat(id: string, appId: string | null, root: string | null) {
  return store.chats.create({ id, title: id, profileId: 'profile-1', headMessageId: null, workspaceRoot: root, pinned: false, archivedAt: null, appId });
}

describe('apps CRUD', () => {
  it('creates an app with a trimmed name, its folder resolved here, each new one after the last', async () => {
    const root = tmp();
    const first = await send('POST', '/api/apps', { name: '  OtherBench  ', workspacePath: root, githubRepo: 'otherworld-dev/OtherBench', linkedProjectId: 'proj-1', defaultProfileId: 'profile-coder' });
    expect(first.status).toBe(201);
    expect(await json(first)).toMatchObject({
      name: 'OtherBench',
      workspaceRoot: root,
      workspaceStatus: { status: 'ok', root },
      githubRepo: 'otherworld-dev/OtherBench',
      linkedProjectId: 'proj-1',
      defaultProfileId: 'profile-coder',
      sortOrder: 0,
    });
    const second = await send('POST', '/api/apps', { name: 'Nextcloud-CLI', workspacePath: root });
    expect(await json(second)).toMatchObject({ githubRepo: null, linkedProjectId: null, defaultProfileId: null, sortOrder: 1 });

    const list = await json<{ name: string; workspaceRoot: string }[]>(await send('GET', '/api/apps'));
    expect(list.map((a) => a.name)).toEqual(['OtherBench', 'Nextcloud-CLI']);
    expect(list[0]?.workspaceRoot).toBe(root);
  });

  it('stores and clears the Nextcloud fields', async () => {
    const root = tmp();
    const created = await send('POST', '/api/apps', {
      name: 'A', workspacePath: root, deckBoardId: 5, wikiCollective: ' Otherworld Dev ', wikiPagePath: ' Products/A ', bookmarkTag: ' a ',
    });
    expect(created.status).toBe(201);
    const app = await json<{ id: string }>(created);
    expect(app).toMatchObject({ deckBoardId: 5, wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/A', bookmarkTag: 'a' });
    expect(store.apps.get(app.id)).toMatchObject({ deckBoardId: 5, wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/A', bookmarkTag: 'a' });

    const cleared = await send('PATCH', `/api/apps/${app.id}`, { deckBoardId: null, wikiCollective: '  ', wikiPagePath: null, bookmarkTag: '' });
    expect(cleared.status).toBe(200);
    expect(await json(cleared)).toMatchObject({ deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null });

    expect((await send('PATCH', `/api/apps/${app.id}`, { deckBoardId: 0 })).status).toBe(400);
    expect((await send('PATCH', `/api/apps/${app.id}`, { deckBoardId: 'x' })).status).toBe(400);
  });

  it('refuses a page path without a collective', async () => {
    const root = tmp();
    expect((await send('POST', '/api/apps', { name: 'A', workspacePath: root, wikiPagePath: 'Products/A' })).status).toBe(400);
    expect((await send('POST', '/api/apps', { name: 'A', workspacePath: root, wikiCollective: 'Otherworld Dev' })).status).toBe(400);
    const ok = await json<{ id: string }>(await send('POST', '/api/apps', { name: 'A', workspacePath: root, wikiCollective: 'C', wikiPagePath: 'P' }));
    // Clearing one half of a stored pair is refused too.
    expect((await send('PATCH', `/api/apps/${ok.id}`, { wikiCollective: null })).status).toBe(400);
    expect(store.apps.get(ok.id)).toMatchObject({ wikiCollective: 'C', wikiPagePath: 'P' });
  });

  it('treats a blank githubRepo as none', async () => {
    const res = await send('POST', '/api/apps', { name: 'A', workspacePath: tmp(), githubRepo: '  ' });
    expect(await json(res)).toMatchObject({ githubRepo: null });
  });

  it.each([
    ['a missing name', { workspacePath: 'ROOT' }],
    ['an empty name', { name: '', workspacePath: 'ROOT' }],
    ['a blank name', { name: '   ', workspacePath: 'ROOT' }],
    ['an 81-character name', { name: 'x'.repeat(81), workspacePath: 'ROOT' }],
    ['no folder', { name: 'A' }],
    ['a relative folder', { name: 'A', workspacePath: 'relative/dir' }],
    ['githubRepo "nope"', { name: 'A', workspacePath: 'ROOT', githubRepo: 'nope' }],
    ['an unknown linkedProjectId', { name: 'A', workspacePath: 'ROOT', linkedProjectId: 'no-such-project' }],
    ['an unknown defaultProfileId', { name: 'A', workspacePath: 'ROOT', defaultProfileId: 'no-such-profile' }],
    ['an archived defaultProfileId', { name: 'A', workspacePath: 'ROOT', defaultProfileId: 'profile-old' }],
    ['a non-integer sortOrder', { name: 'A', workspacePath: 'ROOT', sortOrder: 1.5 }],
  ])('rejects %s with 400 and creates nothing', async (_label, raw) => {
    const root = tmp();
    const body = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === 'ROOT' ? root : v]));
    const res = await send('POST', '/api/apps', body);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error.length).toBeGreaterThan(0);
    expect(store.apps.list()).toEqual([]);
  });

  it('PATCH validates like POST and changes nothing on a bad field', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    for (const body of [{ name: '' }, { githubRepo: 'nope' }, { linkedProjectId: 'missing' }, { defaultProfileId: 'profile-old' }, { workspace: null }]) {
      const res = await send('PATCH', '/api/apps/a1', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(store.apps.get('a1')).toMatchObject({ name: 'a1', githubRepo: 'o/r' });
  });

  it('PATCH renames and relinks; a missing app is a 404', async () => {
    newApp('a1', tmp());
    const res = await send('PATCH', '/api/apps/a1', { name: 'Renamed', githubRepo: null, linkedProjectId: 'proj-1', sortOrder: 4 });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ name: 'Renamed', githubRepo: null, linkedProjectId: 'proj-1', sortOrder: 4 });
    expect((await send('PATCH', '/api/apps/nope', { name: 'x' })).status).toBe(404);
    expect((await send('DELETE', '/api/apps/nope')).status).toBe(404);
  });

  it("PATCH sets, moves and clears an app's folderId; one naming no folder is a 400", async () => {
    newApp('a1', tmp());
    store.appFolders.create({ id: 'f1', name: 'Work' });
    store.appFolders.create({ id: 'f2', name: 'Play' });
    expect(await json(await send('PATCH', '/api/apps/a1', { folderId: 'f1' }))).toMatchObject({ folderId: 'f1' });
    expect(store.apps.get('a1')?.folderId).toBe('f1');
    expect(await json(await send('PATCH', '/api/apps/a1', { folderId: 'f2' }))).toMatchObject({ folderId: 'f2' });
    const bad = await send('PATCH', '/api/apps/a1', { folderId: 'nope' });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toBe('"folderId" names no folder.');
    expect((await send('PATCH', '/api/apps/a1', { folderId: 7 })).status).toBe(400);
    expect(store.apps.get('a1')?.folderId).toBe('f2');
    expect(await json(await send('PATCH', '/api/apps/a1', { name: 'Same' }))).toMatchObject({ folderId: 'f2' });
    expect(await json(await send('PATCH', '/api/apps/a1', { folderId: null }))).toMatchObject({ folderId: null });
    expect(store.apps.get('a1')?.folderId).toBeNull();
  });

  it('POST takes a folderId (null or an existing folder) and refuses one naming no folder', async () => {
    store.appFolders.create({ id: 'f1', name: 'Work' });
    const inFolder = await send('POST', '/api/apps', { name: 'A', workspacePath: tmp(), folderId: 'f1' });
    expect(inFolder.status).toBe(201);
    expect(await json(inFolder)).toMatchObject({ folderId: 'f1' });
    const none = await send('POST', '/api/apps', { name: 'B', workspacePath: tmp() });
    expect(await json(none)).toMatchObject({ folderId: null });
    const bad = await send('POST', '/api/apps', { name: 'C', workspacePath: tmp(), folderId: 'nope' });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toBe('"folderId" names no folder.');
    expect(store.apps.list()).toHaveLength(2);
  });

  it("a workspace PATCH moves every chat in the app to the new folder, announcing each", async () => {
    const before = tmp();
    const after = tmp();
    newApp('a1', before);
    newChat('c1', 'a1', before);
    newChat('c2', 'a1', before);
    newChat('other', null, before);
    events.length = 0;

    const res = await send('PATCH', '/api/apps/a1', { workspacePath: after });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ workspaceRoot: after });
    expect(store.chats.get('c1')?.workspace).toEqual({ kind: 'machine', nodeId: 'node-pc', root: after });
    expect(store.chats.get('c2')?.workspace).toEqual({ kind: 'machine', nodeId: 'node-pc', root: after });
    expect(store.chats.get('other')?.workspace).toEqual({ kind: 'machine', nodeId: 'node-pc', root: before });
    const updated = events.filter((e) => e.type === 'chat-updated').map((e) => (e.type === 'chat-updated' ? e.chat.id : ''));
    expect(updated.sort()).toEqual(['c1', 'c2']);
  });

  it('DELETE moves its chats to no app, keeping them, and announces each one', async () => {
    const root = tmp();
    newApp('a1', root);
    newChat('c1', 'a1', root);
    newChat('other', null, root);
    events.length = 0;

    const res = await send('DELETE', '/api/apps/a1');
    expect(res.status).toBe(204);
    expect(store.apps.get('a1')).toBeNull();
    expect(store.chats.get('c1')).toMatchObject({ appId: null });
    expect(store.chats.get('other')).not.toBeNull();
    expect(events).toEqual([{ type: 'chat-updated', chat: expect.objectContaining({ id: 'c1', appId: null }) }]);
  });

  it("archiving a profile stops it being any app's default", async () => {
    newApp('a1', tmp(), { defaultProfileId: 'profile-coder' });
    const res = await send('PATCH', '/api/profiles/profile-coder', { archivedAt: 5 });
    expect(res.status).toBe(200);
    expect(store.apps.get('a1')?.defaultProfileId).toBeNull();
  });
});

describe('linking a repo or a board checks the Overview straight away', () => {
  let refresh: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    refresh = vi.fn(() => Promise.resolve());
    container.overview = { refresh } as unknown as OverviewService;
  });

  it('POST refreshes when the new app has a repo or a board, and not when it has neither', async () => {
    await send('POST', '/api/apps', { name: 'A', workspacePath: tmp() });
    expect(refresh).not.toHaveBeenCalled();
    await send('POST', '/api/apps', { name: 'B', workspacePath: tmp(), githubRepo: 'o/r' });
    expect(refresh).toHaveBeenCalledTimes(1);
    await send('POST', '/api/apps', { name: 'C', workspacePath: tmp(), deckBoardId: 5 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('PATCH refreshes when the repo or the board changes, and not on an unrelated or same-value change', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    await send('PATCH', '/api/apps/a1', { name: 'Renamed' });
    await send('PATCH', '/api/apps/a1', { githubRepo: 'o/r' });
    expect(refresh).not.toHaveBeenCalled();
    await send('PATCH', '/api/apps/a1', { githubRepo: 'o/other' });
    expect(refresh).toHaveBeenCalledTimes(1);
    await send('PATCH', '/api/apps/a1', { deckBoardId: 7 });
    expect(refresh).toHaveBeenCalledTimes(2);
    await send('PATCH', '/api/apps/a1', { deckBoardId: 7 });
    expect(refresh).toHaveBeenCalledTimes(2);
    await send('PATCH', '/api/apps/a1', { deckBoardId: null });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('a failed check does not fail the PATCH', async () => {
    refresh.mockImplementation(() => Promise.reject(new Error('gh broke')));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    newApp('a1', tmp());
    const res = await send('PATCH', '/api/apps/a1', { githubRepo: 'o/r' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });
});

describe("changing an app's repo forgets the old repo's issue ticks", () => {
  it('drops the ticks when the repo changes, keeps them otherwise', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    newApp('a2', tmp(), { githubRepo: 'o/r' });
    store.issueTicks.set('a1', 7, '2026-10-01T00:00:00Z');
    store.issueTicks.set('a2', 7, '2026-10-01T00:00:00Z');
    await send('PATCH', '/api/apps/a1', { name: 'Renamed' });
    await send('PATCH', '/api/apps/a1', { githubRepo: 'o/r' });
    expect(store.issueTicks.list().map((t) => t.appId).sort()).toEqual(['a1', 'a2']);
    const res = await send('PATCH', '/api/apps/a1', { githubRepo: 'o/other' });
    expect(res.status).toBe(200);
    expect(store.issueTicks.list().map((t) => t.appId)).toEqual(['a2']);
  });
});

describe.skipIf(!hasGit)('GET /api/apps/detect-repo', () => {
  it('finds the GitHub repo among the remotes', async () => {
    const dir = repo();
    g(dir, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
    const res = await send('GET', `/api/apps/detect-repo?path=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ githubRepo: 'o/r', isRepo: true });
  });

  it('a repo with no GitHub remote, and a plain folder', async () => {
    const dir = repo();
    expect(await json(await send('GET', `/api/apps/detect-repo?path=${encodeURIComponent(dir)}`))).toEqual({ githubRepo: null, isRepo: true });
    const plain = tmp();
    expect(await json(await send('GET', `/api/apps/detect-repo?path=${encodeURIComponent(plain)}`))).toEqual({ githubRepo: null, isRepo: false });
  });

  it('refuses a relative path, and a folder that is not there', async () => {
    expect((await send('GET', '/api/apps/detect-repo?path=relative')).status).toBe(400);
    expect((await send('GET', '/api/apps/detect-repo')).status).toBe(400);
    expect((await send('GET', `/api/apps/detect-repo?path=${encodeURIComponent(join(tmp(), 'gone'))}`)).status).toBe(404);
  });
});

describe.skipIf(!hasGit)('git routes', () => {
  it('status on a temp repo names its branch', async () => {
    const dir = repo();
    const branch = g(dir, 'symbolic-ref', '--short', 'HEAD').trim();
    newApp('a1', dir);
    const res = await send('GET', '/api/apps/a1/git/status');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ branch, ahead: 0, behind: 0, files: [] });
  });

  it('commits, diffs, branches and checks out', async () => {
    const dir = repo();
    newApp('a1', dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const diff = await json<{ diff: string }>(await send('GET', '/api/apps/a1/git/diff?path=a.txt'));
    expect(diff.diff).toContain('+one');

    const commit = await send('POST', '/api/apps/a1/git/commit', { message: 'first', paths: 'all' });
    expect(commit.status).toBe(200);
    expect((await json<{ sha: string }>(commit)).sha).toMatch(/^[0-9a-f]{40}$/);

    expect((await send('POST', '/api/apps/a1/git/branch', { branch: 'feature' })).status).toBe(204);
    const branches = await json<{ branches: { name: string; current: boolean }[] }>(await send('GET', '/api/apps/a1/git/branches'));
    expect(branches.branches).toContainEqual({ name: 'feature', current: true });
    const first = branches.branches.find((b) => b.name !== 'feature')?.name ?? '';
    expect((await send('POST', '/api/apps/a1/git/checkout', { branch: first })).status).toBe(204);
    expect(await json(await send('GET', '/api/apps/a1/git/status'))).toMatchObject({ branch: first });
  });

  it('a path outside the folder is a 400 bad-path, for diff and commit', async () => {
    newApp('a1', repo());
    const diff = await send('GET', `/api/apps/a1/git/diff?path=${encodeURIComponent('../x')}`);
    expect(diff.status).toBe(400);
    expect(await json(diff)).toMatchObject({ code: 'bad-path' });
    const commit = await send('POST', '/api/apps/a1/git/commit', { message: 'm', paths: ['../x'] });
    expect(commit.status).toBe(400);
    expect(await json(commit)).toMatchObject({ code: 'bad-path' });
  });

  it('a branch name starting with "-" is a 400 bad-branch', async () => {
    newApp('a1', repo());
    const res = await send('POST', '/api/apps/a1/git/branch', { branch: '-x' });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: 'bad-branch' });
    expect((await send('POST', '/api/apps/a1/git/checkout', {})).status).toBe(400);
  });

  it('a folder that is not a repo is a 409 not-a-repo', async () => {
    newApp('a1', tmp());
    const res = await send('GET', '/api/apps/a1/git/status');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'not-a-repo' });
  });

  it("git's own failure is a 409 git-failed carrying stderr as-is", async () => {
    newApp('a1', repo());
    // A branch that doesn't exist: git switch fails, saying so on stderr.
    const res = await send('POST', '/api/apps/a1/git/checkout', { branch: 'no-such-branch' });
    expect(res.status).toBe(409);
    const body = await json<{ code: string; stderr?: string; error: string }>(res);
    expect(body.code).toBe('git-failed');
    expect(body.stderr).toContain('no-such-branch');
    expect(body.stderr?.split('\n').map((l) => l.trim())).toContain(body.error);
  });

  it('refuses a NUL in a branch name or commit message with 400, before git runs', async () => {
    newApp('a1', repo());
    for (const path of ['/api/apps/a1/git/branch', '/api/apps/a1/git/checkout']) {
      const res = await send('POST', path, { branch: 'a\u0000b' });
      expect(res.status, path).toBe(400);
      expect(await json(res)).toMatchObject({ code: 'bad-branch' });
    }
    expect((await send('POST', '/api/apps/a1/git/commit', { message: 'a\u0000b', paths: 'all' })).status).toBe(400);
  });

  it('refuses a commit with no message or bad paths with 400', async () => {
    newApp('a1', repo());
    expect((await send('POST', '/api/apps/a1/git/commit', { message: '  ', paths: 'all' })).status).toBe(400);
    expect((await send('POST', '/api/apps/a1/git/commit', { message: 'm', paths: 'some' })).status).toBe(400);
    expect((await send('POST', '/api/apps/a1/git/commit', { message: 'm', paths: [7] })).status).toBe(400);
  });
});

describe('an app whose folder is not on this machine', () => {
  it('answers the git, files and text routes with 409 not-on-this-machine', async () => {
    store.apps.create({ id: 'a1', name: 'A', workspace: { kind: 'machine', nodeId: 'node-laptop', root: tmp() } });
    for (const path of ['/api/apps/a1/git/status', '/api/apps/a1/git/branches', '/api/apps/a1/files', '/api/apps/a1/text?path=a.txt']) {
      const res = await send('GET', path);
      expect(res.status, path).toBe(409);
      expect(await json(res)).toMatchObject({ code: 'not-on-this-machine' });
    }
    const pull = await send('POST', '/api/apps/a1/git/pull');
    expect(pull.status).toBe(409);
    expect(await json(pull)).toMatchObject({ code: 'not-on-this-machine' });
  });

  it('and so does an app with no folder at all', async () => {
    store.apps.create({ id: 'a1', name: 'A', workspace: null });
    const res = await send('GET', '/api/apps/a1/git/status');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'not-on-this-machine' });
  });

  it('an unknown app is a 404', async () => {
    expect((await send('GET', '/api/apps/nope/git/status')).status).toBe(404);
    expect((await send('GET', '/api/apps/nope/issues')).status).toBe(404);
  });
});

describe('files routes', () => {
  function tree(): string {
    const root = tmp();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
    writeFileSync(join(root, 'README.md'), '# Hi\n');
    return root;
  }

  it("lists the app's folder, folders first, in the /view/dirs entry shape", async () => {
    const root = tree();
    newApp('a1', root);
    const top = await send('GET', '/api/apps/a1/files');
    expect(top.status).toBe(200);
    const listing = await json<{ path: string; entries: { name: string; path: string; type: string }[] }>(top);
    expect(listing.entries.map((e) => [e.name, e.type])).toEqual([
      ['src', 'dir'],
      ['README.md', 'file'],
    ]);
    const sub = await json<{ entries: { name: string; path: string; type: string }[] }>(await send('GET', '/api/apps/a1/files?path=src'));
    expect(sub.entries.map((e) => e.name)).toEqual(['main.ts']);
    // An absolute path inside the folder works too (the tree hands back the paths it was given).
    const again = await send('GET', `/api/apps/a1/files?path=${encodeURIComponent(sub.entries[0]!.path.replace(/[\\/]main\.ts$/, ''))}`);
    expect(again.status).toBe(200);
  });

  it('a path outside the folder is a 400 bad-path', async () => {
    newApp('a1', tree());
    for (const path of ['../..', '..', tmp()]) {
      const res = await send('GET', `/api/apps/a1/files?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(400);
      expect(await json(res)).toMatchObject({ code: 'bad-path' });
    }
    const text = await send('GET', `/api/apps/a1/text?path=${encodeURIComponent('../secret.txt')}`);
    expect(text.status).toBe(400);
    expect(await json(text)).toMatchObject({ code: 'bad-path' });
  });

  it('reads a text file, as GET /view/text does', async () => {
    const root = tree();
    newApp('a1', root);
    const res = await send('GET', '/api/apps/a1/text?path=README.md');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ content: '# Hi\n', truncated: false, size: 5 });
    expect((await send('GET', '/api/apps/a1/text?path=missing.md')).status).toBe(404);
    expect((await send('GET', '/api/apps/a1/text?path=src')).status).toBe(400);
    expect((await send('GET', '/api/apps/a1/text')).status).toBe(400);
  });
});

describe('issue routes', () => {
  it('lists the repo\'s issues through the github service, open by default', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    const res = await send('GET', '/api/apps/a1/issues');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ repo: 'o/r', issues: [ISSUE] });
    await send('GET', '/api/apps/a1/issues?state=closed');
    expect(calls.list).toEqual([
      ['o/r', 'open'],
      ['o/r', 'closed'],
    ]);
    expect((await send('GET', '/api/apps/a1/issues?state=all')).status).toBe(400);
  });

  it('views, comments on, closes and reopens an issue', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    expect(await json(await send('GET', '/api/apps/a1/issues/48'))).toMatchObject({ number: 48, body: 'It vanished.' });
    expect((await send('POST', '/api/apps/a1/issues/48/comment', { body: 'On it.' })).status).toBe(204);
    expect((await send('POST', '/api/apps/a1/issues/48/close')).status).toBe(204);
    expect((await send('POST', '/api/apps/a1/issues/48/reopen')).status).toBe(204);
    expect(calls.view).toEqual([['o/r', 48]]);
    expect(calls.comment).toEqual([['o/r', 48, 'On it.']]);
    expect(calls.close).toEqual([['o/r', 48]]);
    expect(calls.reopen).toEqual([['o/r', 48]]);
  });

  it('refuses a blank comment and a bad issue number with 400, without calling gh', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    expect((await send('POST', '/api/apps/a1/issues/48/comment', { body: '   ' })).status).toBe(400);
    expect((await send('POST', '/api/apps/a1/issues/48/comment', {})).status).toBe(400);
    expect((await send('GET', '/api/apps/a1/issues/0')).status).toBe(400);
    expect((await send('GET', '/api/apps/a1/issues/x1')).status).toBe(400);
    expect(calls.comment).toEqual([]);
    expect(calls.view).toEqual([]);
  });

  it('an app with no GitHub repo is a 409 no-github-repo', async () => {
    newApp('a1', tmp());
    for (const [method, path] of [['GET', '/api/apps/a1/issues'], ['GET', '/api/apps/a1/issues/1'], ['POST', '/api/apps/a1/issues/1/close']] as const) {
      const res = await send(method, path);
      expect(res.status, path).toBe(409);
      expect(await json(res)).toMatchObject({ code: 'no-github-repo' });
    }
    expect(calls.list).toEqual([]);
  });

  it("works whether or not the app's folder is on this machine", async () => {
    store.apps.create({ id: 'a1', name: 'A', workspace: { kind: 'machine', nodeId: 'node-laptop', root: '/elsewhere' }, githubRepo: 'o/r' });
    expect((await send('GET', '/api/apps/a1/issues')).status).toBe(200);
  });

  it.each([
    ['gh-missing', 409],
    ['gh-signed-out', 409],
    ['repo-not-found', 409],
    ['gh-failed', 409],
  ] as const)('a %s failure is a %i carrying its code', async (code, status) => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    githubFails = new GhError(code, `failed: ${code}`);
    const res = await send('GET', '/api/apps/a1/issues');
    expect(res.status).toBe(status);
    expect(await json(res)).toMatchObject({ code, error: `failed: ${code}` });
  });
});

describe('gh failures through the real github service', () => {
  it("gh-failed carries gh's stderr as-is", async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    container.github = githubService(async () => ({ code: 1, stdout: '', stderr: 'HTTP 502: bad gateway\nretry later', timedOut: false, truncated: false }));
    const res = await send('GET', '/api/apps/a1/issues');
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'HTTP 502: bad gateway', code: 'gh-failed', stderr: 'HTTP 502: bad gateway\nretry later' });
  });

  it('a gh that cannot be started is a 409 gh-failed, never a 500', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    container.github = githubService(async () => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    });
    const res = await send('GET', '/api/apps/a1/issues');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'gh-failed', error: 'Could not start gh: spawn EACCES' });
  });
});

describe('the peer listener', () => {
  it('has no /apps route, whatever the app', async () => {
    newApp('a1', tmp(), { githubRepo: 'o/r' });
    const api = forwardedApi(container);
    for (const path of ['/apps', '/apps/a1', '/apps/a1/git/status', '/apps/a1/issues', '/apps/a1/files', '/apps/detect-repo?path=/']) {
      const res = await api.request(path, {}, { peerNodeId: 'node-laptop' });
      expect(res.status, path).toBe(404);
    }
    const push = await api.request('/apps/a1/git/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, { peerNodeId: 'node-laptop' });
    expect(push.status).toBe(404);
  });
});
