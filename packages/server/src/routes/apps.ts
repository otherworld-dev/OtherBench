import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { APP_NAME_MAX, githubRepoFromRemotes, isGithubRepo } from '@otherbench/core/domain/apps.js';
import { containPath, PathEscapeError } from '@otherbench/core/domain/paths.js';
import { sameWorkspace } from '@otherbench/core/domain/workspace.js';
import type { App, Store } from '@otherbench/core/ports/store.js';
import type { Workspace } from '@otherbench/core/types/workspace.js';
import type { Container } from '../container.js';
import { git, GitError } from '../code/git.js';
import { ghRunner, githubService, type GithubService } from '../code/github.js';
import { folderFromQuery } from '../code/folder-query.js';
import { CodeRouteError, codeCall } from '../code/route-errors.js';
import { ambiguousOnWindows, viewFailure } from '../view/roots.js';
import { optionalNullableString } from '../validation.js';
import { appView, appViews, parseWorkspaceBody, workspaceResolver } from '../workspace-view.js';
import { listViewDir, pathOf, readViewText } from './view.js';

/**
 * `/api/apps` (spec 2026-10-20-code-tab-design): the Code tab's apps, and the
 * git, GitHub issues and Files panels on each one.
 *
 * Every git and issue route here is a USER action on a server route, not a
 * model tool call ("Constraints from the codebase"), so none of it passes the
 * PermissionBroker and none of it may ever be offered to a model as a tool.
 * For the same reason this router is mounted only on the authed API in
 * app.ts, never on the peer listener (peer/forward.ts's forwardedApi): a paired
 * machine must not be able to commit, push or comment on this one's behalf
 * (spec "Anti-goals"). There is no forwarding to the peer either: git and the
 * Files tree run only where the app's folder resolves, and answer 409
 * `not-on-this-machine` elsewhere (spec "Decisions Adam made", runs-on-
 * elsewhere -- the web turns the actions off for such a chat).
 *
 * Every path from the UI goes through containPath against the app's resolved
 * root (the git service does its own for a pathspec; the Files routes do it
 * here). Branch names and commit messages reach git as separate argv values.
 */

interface AppBody {
  name?: unknown;
  workspace?: unknown;
  workspacePath?: unknown;
  workspaceRoot?: unknown;
  githubRepo?: unknown;
  deckBoardId?: unknown;
  wikiCollective?: unknown;
  wikiPagePath?: unknown;
  bookmarkTag?: unknown;
  linkedProjectId?: unknown;
  defaultProfileId?: unknown;
  sortOrder?: unknown;
  folderId?: unknown;
}

/** Trimmed, 1 to APP_NAME_MAX characters, as a project's name. */
function requireAppName(value: unknown): string {
  if (typeof value !== 'string') throw new HTTPException(400, { message: '"name" is required and must be a string.' });
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > APP_NAME_MAX) {
    throw new HTTPException(400, { message: `"name" must be 1-${APP_NAME_MAX} characters after trimming.` });
  }
  return trimmed;
}

/** "owner/name", or null; a blank string is none, as the New app form sends it when nothing was detected. */
function optionalGithubRepo(value: unknown): string | null | undefined {
  const parsed = optionalNullableString(value, 'githubRepo');
  if (parsed === undefined || parsed === null) return parsed;
  const trimmed = parsed.trim();
  if (trimmed === '') return null;
  if (!isGithubRepo(trimmed)) throw new HTTPException(400, { message: `"githubRepo" must be a GitHub repository as "owner/name"; got "${trimmed}".` });
  return trimmed;
}

/** A positive integer Deck board id, or null (cleared). */
function optionalDeckBoardId(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HTTPException(400, { message: '"deckBoardId" must be a positive whole number or null.' });
  }
  return value;
}

/** Trimmed; blank is none. */
function optionalTrimmed(value: unknown, field: string): string | null | undefined {
  const parsed = optionalNullableString(value, field);
  if (parsed === undefined || parsed === null) return parsed;
  const trimmed = parsed.trim();
  return trimmed === '' ? null : trimmed;
}

interface NextcloudFields { deckBoardId?: number | null; wikiCollective?: string | null; wikiPagePath?: string | null; bookmarkTag?: string | null }

/** The Nextcloud fields a body sets (left out = unchanged). A collective and a page path come as a pair; one without the other is a 400. */
function nextcloudFields(current: App | null, body: AppBody): NextcloudFields {
  const out: NextcloudFields = {};
  const deckBoardId = optionalDeckBoardId(body.deckBoardId);
  if (deckBoardId !== undefined) out.deckBoardId = deckBoardId;
  const wikiCollective = optionalTrimmed(body.wikiCollective, 'wikiCollective');
  if (wikiCollective !== undefined) out.wikiCollective = wikiCollective;
  const wikiPagePath = optionalTrimmed(body.wikiPagePath, 'wikiPagePath');
  if (wikiPagePath !== undefined) out.wikiPagePath = wikiPagePath;
  const bookmarkTag = optionalTrimmed(body.bookmarkTag, 'bookmarkTag');
  if (bookmarkTag !== undefined) out.bookmarkTag = bookmarkTag;
  const collective = out.wikiCollective !== undefined ? out.wikiCollective : (current?.wikiCollective ?? null);
  const pagePath = out.wikiPagePath !== undefined ? out.wikiPagePath : (current?.wikiPagePath ?? null);
  if ((collective === null) !== (pagePath === null)) {
    throw new HTTPException(400, { message: '"wikiCollective" and "wikiPagePath" must both be set or both be empty.' });
  }
  return out;
}

/** A linked project must exist here when it's set (spec "Data"); a synced row naming a missing one is read as none elsewhere. */
function optionalLinkedProjectId(container: Container, value: unknown): string | null | undefined {
  const parsed = optionalNullableString(value, 'linkedProjectId');
  if (parsed === undefined || parsed === null) return parsed;
  if (!container.store.projects.get(parsed)) throw new HTTPException(400, { message: `"linkedProjectId": project "${parsed}" not found.` });
  return parsed;
}

/** As a project's: the profile must exist and not be archived. */
function optionalDefaultProfileId(container: Container, value: unknown): string | null | undefined {
  const parsed = optionalNullableString(value, 'defaultProfileId');
  if (parsed === undefined || parsed === null) return parsed;
  const profile = container.store.profiles.get(parsed);
  if (!profile) throw new HTTPException(400, { message: `"defaultProfileId": profile "${parsed}" not found.` });
  if (profile.archivedAt !== null) throw new HTTPException(400, { message: `"defaultProfileId": profile "${profile.name}" is archived.` });
  return parsed;
}

/** An existing folder's id, or null (no folder). */
function optionalFolderId(container: Container, value: unknown): string | null | undefined {
  const parsed = optionalNullableString(value, 'folderId');
  if (parsed === undefined || parsed === null) return parsed;
  if (!container.store.appFolders.get(parsed)) throw new HTTPException(400, { message: '"folderId" names no folder.' });
  return parsed;
}

function optionalSortOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new HTTPException(400, { message: '"sortOrder" must be an integer.' });
  return value;
}

/**
 * An app IS a folder ("What it is": one repo, a folder on disk plus its
 * GitHub repo), so unlike a project it can't be created or left without one.
 * A synced row can still arrive without a folder (its location deleted), and
 * the git routes say so with `not-on-this-machine`.
 */
function requireAppFolder(container: Container, body: AppBody, creating: boolean): Workspace | undefined {
  const workspace = parseWorkspaceBody(container, body);
  if (workspace === null || (creating && workspace === undefined)) {
    throw new HTTPException(400, { message: 'An app needs its folder: give "workspacePath", an absolute path.' });
  }
  return workspace;
}

function sameFolder(a: Workspace | null, b: Workspace | null): boolean {
  return a === null || b === null ? a === b : sameWorkspace(a, b);
}

export function getAppOrThrow(container: Container, id: string): App {
  const app = container.store.apps.get(id);
  if (!app) throw new HTTPException(404, { message: `App "${id}" not found.` });
  return app;
}

/**
 * Clears `profileId` as every app's default profile, for a profile that was
 * just archived (mirrors `clearProjectDefaultProfile`; called from
 * routes/profiles.ts). A deleted profile needs no call: the
 * `app.default_profile_id` foreign key is ON DELETE SET NULL (migration 029).
 */
export function clearAppDefaultProfile(store: Store, profileId: string): void {
  for (const app of store.apps.list()) {
    if (app.defaultProfileId === profileId) store.apps.update(app.id, { defaultProfileId: null, updatedAt: Date.now() });
  }
}

/**
 * The app's folder on THIS machine, or a 409 `not-on-this-machine`. Uses the
 * same resolver as every chat and project view, so "isn't on this machine"
 * here means exactly what the app's `workspaceStatus` already shows.
 */
export function appRootOrThrow(container: Container, app: App): string {
  const status = workspaceResolver(container)(app.workspace);
  if (status.status === 'ok') return status.root;
  let message = "This app's folder isn't on this machine.";
  if (status.status === 'none') message = 'This app has no folder.';
  else if (status.reason === 'missing') message = `This app's folder isn't on this machine: there's nothing at ${status.hint?.path ?? 'its path'}.`;
  else if (status.reason === 'other-machine') {
    const nodeId = status.hint?.nodeId;
    const machine = nodeId ? (container.store.peers.get(nodeId)?.name ?? 'another machine') : 'another machine';
    message = `This app's folder isn't on this machine; it's on ${machine}.`;
  }
  throw new CodeRouteError(409, 'not-on-this-machine', message);
}

/** The app's GitHub repo, or a 409 `no-github-repo` (spec "Creating an app": the Issues tab explains why it's empty). */
function githubRepoOrThrow(app: App): string {
  if (app.githubRepo === null) throw new CodeRouteError(409, 'no-github-repo', "This app has no GitHub repository set. Add one in the app's settings to see its issues.");
  return app.githubRepo;
}

/**
 * A Files refusal as the app routes answer it: an escape is a 400 `bad-path`, whether containPath caught it up front
 * or fs-tools' verified open or listing caught it afterwards (a link swapped in between); anything else is the
 * viewer's own message.
 */
function filesFailure(err: unknown, path: string): never {
  if (err instanceof PathEscapeError) throw new CodeRouteError(400, 'bad-path', `"${path}" is outside the app's folder.`);
  viewFailure(err, path);
}

/** A path from the Files tab, contained to the app's root: relative paths mean inside it, and anything that escapes is a 400 `bad-path`. */
function filesTarget(root: string, path: string): string {
  // As the viewer: a hidden stream or a segment Windows would trim names a different file from the one asked for.
  if (ambiguousOnWindows(path)) throw new HTTPException(404, { message: `File not found: ${path}` });
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  try {
    return containPath(root, absolute);
  } catch (err) {
    filesFailure(err, path);
  }
}

function issueNumberOf(raw: string): number {
  const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new HTTPException(400, { message: `"${raw}" is not an issue number.` });
  return n;
}

/** A NUL can't be in an argv value at all (spawn would refuse it as "Could not start git"), so it's the request's fault. */
function requireBranch(value: unknown): string {
  if (typeof value !== 'string') throw new CodeRouteError(400, 'bad-branch', '"branch" is required and must be a string.');
  if (value.includes('\0')) throw new CodeRouteError(400, 'bad-branch', 'A branch name cannot contain a NUL character.');
  return value;
}

async function bodyOf<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

let realGithub: GithubService | null = null;
/** The container's github service, else the machine's own gh (created once). The Overview's checks use it too. */
export function githubOf(container: Container): GithubService {
  if (container.github) return container.github;
  realGithub ??= githubService(ghRunner());
  return realGithub;
}

export function appsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(appViews(container, container.store.apps.list())));

  /**
   * `GET /detect-repo?path=<abs>`: whether a folder is a repository's top
   * level and which GitHub repo its remotes point at, for the New app form's
   * auto-fill. The path is checked by folderFromQuery (absolute, then
   * resolved), and this route reads nothing but git's remote list.
   * Before `/:id`, which would otherwise take "detect-repo" as an id.
   */
  app.get('/detect-repo', async (c) => {
    const path = await folderFromQuery(c.req.query('path'));
    const remotes = await codeCall(async () => {
      try {
        return await git.remotes(path);
      } catch (err) {
        // A plain folder, or one inside another repository: not an app's repo.
        if (err instanceof GitError && err.code === 'not-a-repo') return null;
        throw err;
      }
    });
    return c.json({ githubRepo: remotes ? githubRepoFromRemotes(remotes) : null, isRepo: remotes !== null });
  });

  app.post('/', async (c) => {
    const body = await bodyOf<AppBody>(c);
    // Every field is validated before anything is written.
    const name = requireAppName(body.name);
    const workspace = requireAppFolder(container, body, true) ?? null;
    const githubRepo = optionalGithubRepo(body.githubRepo) ?? null;
    const nextcloud = nextcloudFields(null, body);
    const linkedProjectId = optionalLinkedProjectId(container, body.linkedProjectId) ?? null;
    const defaultProfileId = optionalDefaultProfileId(container, body.defaultProfileId) ?? null;
    const folderId = optionalFolderId(container, body.folderId) ?? null;
    // New apps go to the bottom of the sidebar unless the request places them.
    const sortOrder = optionalSortOrder(body.sortOrder) ?? container.store.apps.list().reduce((max, a) => Math.max(max, a.sortOrder), -1) + 1;
    const created = container.store.apps.create({ id: randomUUID(), name, workspace, githubRepo, linkedProjectId, defaultProfileId, folderId, sortOrder, ...nextcloud });
    return c.json(appView(container, created), 201);
  });

  app.get('/:id', (c) => c.json(appView(container, getAppOrThrow(container, c.req.param('id')))));

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const current = getAppOrThrow(container, id);
    const body = await bodyOf<AppBody>(c);

    // Every field is validated before anything is written.
    const patch: Partial<Omit<App, 'id'>> = {};
    if (body.name !== undefined) patch.name = requireAppName(body.name);
    const workspace = requireAppFolder(container, body, false);
    if (workspace !== undefined) patch.workspace = workspace;
    const githubRepo = optionalGithubRepo(body.githubRepo);
    if (githubRepo !== undefined) patch.githubRepo = githubRepo;
    Object.assign(patch, nextcloudFields(current, body));
    const linkedProjectId = optionalLinkedProjectId(container, body.linkedProjectId);
    if (linkedProjectId !== undefined) patch.linkedProjectId = linkedProjectId;
    const defaultProfileId = optionalDefaultProfileId(container, body.defaultProfileId);
    if (defaultProfileId !== undefined) patch.defaultProfileId = defaultProfileId;
    const folderId = optionalFolderId(container, body.folderId);
    if (folderId !== undefined) patch.folderId = folderId;
    const sortOrder = optionalSortOrder(body.sortOrder);
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
    patch.updatedAt = Date.now();

    const updated = container.store.apps.update(id, patch);
    // Spec "Calls I made": an app chat's folder is the app's folder, so a new folder moves every chat in the app,
    // through the chat repo so the change syncs (and the evented repo announces each chat-updated). A Claude Code
    // chat whose folder changed starts a fresh session on its next turn (engine-claude-code session.ts compares cwd).
    if (workspace !== undefined && !sameFolder(current.workspace, updated.workspace)) {
      for (const chat of container.store.chats.list()) {
        if (chat.appId === id && !sameFolder(chat.workspace, updated.workspace)) container.store.chats.update(chat.id, { workspace: updated.workspace });
      }
    }
    return c.json(appView(container, updated));
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    getAppOrThrow(container, id);
    // Its chats go back to Chat mode (appId: null) and are never deleted. The app repo clears them through its own
    // chat repo, past the evented one, so announce each moved chat here (as projects.ts does).
    const moved = container.store.chats.list().filter((chat) => chat.appId === id).map((chat) => chat.id);
    container.store.apps.delete(id);
    // Its terminals go with it (spec 2026-10-21-code-terminal-design); not awaited, the kills run on their own.
    void container.terminals?.killApp(id);
    for (const chatId of moved) {
      const chat = container.store.chats.get(chatId);
      if (chat) container.events?.emit({ type: 'chat-updated', chat });
    }
    return c.body(null, 204);
  });

  // --- git (spec Goal 2) -----------------------------------------------------------------------------------------

  /** The app and its folder here: a 404 for an unknown app, a 409 for one whose folder isn't on this machine. */
  const rootOf = (id: string): string => appRootOrThrow(container, getAppOrThrow(container, id));

  app.get('/:id/git/status', async (c) => {
    const root = rootOf(c.req.param('id'));
    return c.json(await codeCall(() => git.status(root)));
  });

  app.get('/:id/git/diff', async (c) => {
    const root = rootOf(c.req.param('id'));
    const raw = c.req.query('path');
    const path = raw === undefined || raw === '' ? undefined : raw;
    return c.json({ diff: await codeCall(() => git.diff(root, path)) });
  });

  app.post('/:id/git/commit', async (c) => {
    const root = rootOf(c.req.param('id'));
    const body = await bodyOf<{ message?: unknown; paths?: unknown }>(c);
    if (typeof body.message !== 'string' || body.message.trim() === '') {
      throw new HTTPException(400, { message: '"message" is required: a commit needs a message.' });
    }
    if (body.message.includes('\0')) throw new HTTPException(400, { message: 'A commit message cannot contain a NUL character.' });
    // Every changed file by default (spec Goal 2: "all of them by default").
    const paths = body.paths === undefined ? 'all' : body.paths;
    if (paths !== 'all' && (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p !== ''))) {
      throw new HTTPException(400, { message: '"paths" must be "all" or a non-empty list of file paths.' });
    }
    const message = body.message;
    return c.json(await codeCall(() => git.commit(root, message, paths as string[] | 'all')));
  });

  app.post('/:id/git/pull', async (c) => {
    const root = rootOf(c.req.param('id'));
    return c.json(await codeCall(() => git.pull(root)));
  });

  app.post('/:id/git/push', async (c) => {
    const root = rootOf(c.req.param('id'));
    const body = await bodyOf<{ setUpstream?: unknown }>(c);
    if (body.setUpstream !== undefined && typeof body.setUpstream !== 'boolean') throw new HTTPException(400, { message: '"setUpstream" must be a boolean.' });
    const setUpstream = body.setUpstream === true;
    return c.json(await codeCall(() => git.push(root, { setUpstream })));
  });

  app.get('/:id/git/branches', async (c) => {
    const root = rootOf(c.req.param('id'));
    return c.json({ branches: await codeCall(() => git.branches(root)) });
  });

  app.post('/:id/git/checkout', async (c) => {
    const root = rootOf(c.req.param('id'));
    const branch = requireBranch((await bodyOf<{ branch?: unknown }>(c)).branch);
    await codeCall(() => git.checkout(root, branch));
    return c.body(null, 204);
  });

  app.post('/:id/git/branch', async (c) => {
    const root = rootOf(c.req.param('id'));
    const branch = requireBranch((await bodyOf<{ branch?: unknown }>(c)).branch);
    await codeCall(() => git.createBranch(root, branch));
    return c.body(null, 204);
  });

  // --- GitHub issues (spec Goal 3) ---------------------------------------------------------------------------------
  // From GitHub, not the folder, so these work wherever the app's folder is (spec: "Issues keep working").

  app.get('/:id/issues', async (c) => {
    const repo = githubRepoOrThrow(getAppOrThrow(container, c.req.param('id')));
    const state = c.req.query('state') ?? 'open';
    if (state !== 'open' && state !== 'closed') throw new HTTPException(400, { message: '"state" must be "open" or "closed".' });
    return c.json({ repo, issues: await codeCall(() => githubOf(container).list(repo, state)) });
  });

  app.get('/:id/issues/:n', async (c) => {
    const repo = githubRepoOrThrow(getAppOrThrow(container, c.req.param('id')));
    const n = issueNumberOf(c.req.param('n'));
    return c.json(await codeCall(() => githubOf(container).view(repo, n)));
  });

  app.post('/:id/issues/:n/comment', async (c) => {
    const repo = githubRepoOrThrow(getAppOrThrow(container, c.req.param('id')));
    const n = issueNumberOf(c.req.param('n'));
    const { body } = await bodyOf<{ body?: unknown }>(c);
    if (typeof body !== 'string' || body.trim() === '') throw new HTTPException(400, { message: '"body" is required: write the comment first.' });
    await codeCall(() => githubOf(container).comment(repo, n, body));
    return c.body(null, 204);
  });

  for (const action of ['close', 'reopen'] as const) {
    app.post(`/:id/issues/:n/${action}`, async (c) => {
      const repo = githubRepoOrThrow(getAppOrThrow(container, c.req.param('id')));
      const n = issueNumberOf(c.req.param('n'));
      await codeCall(() => githubOf(container)[action](repo, n));
      return c.body(null, 204);
    });
  }

  // --- Files (spec Goal 4) -----------------------------------------------------------------------------------------
  // The Files tab on the app home, with no chat: the same listing and text read as /api/view (shared helpers),
  // rooted at the app's folder only. The app has no extra folders of its own, so nothing outside it opens here.

  app.get('/:id/files', async (c) => {
    const root = rootOf(c.req.param('id'));
    const raw = c.req.query('path');
    const path = raw === undefined || raw === '' ? '.' : pathOf(raw);
    return c.json(await listViewDir(root, filesTarget(root, path), path, filesFailure));
  });

  app.get('/:id/text', async (c) => {
    const root = rootOf(c.req.param('id'));
    const path = pathOf(c.req.query('path'));
    return c.json(await readViewText(root, filesTarget(root, path), path, filesFailure));
  });

  return app;
}
