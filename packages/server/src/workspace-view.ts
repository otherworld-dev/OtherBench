import { existsSync } from 'node:fs';
import { HTTPException } from 'hono/http-exception';
import { classifyPath, MAX_EXTRA_FOLDERS, mergeFolders, parseFolders, resolveWorkspace, sameWorkspace } from '@otherbench/core/domain/workspace.js';
import type { App, Chat, Project } from '@otherbench/core/ports/store.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { ExtraFolder, FolderView, Workspace, WorkspaceStatus } from '@otherbench/core/types/workspace.js';
import type { Container } from './container.js';
import { optionalWorkspaceRoot } from './validation.js';

/**
 * Chats, projects and apps as the API returns them: the stored, portable
 * `workspace` plus what it means on THIS machine (v2 spec §6), so the UI
 * never resolves a folder itself.
 */

/** Whether a folder exists here; the container's own check when it has one (tests), else the real disk. */
function existsFor(container: Container): (path: string) => boolean {
  return container.pathExists ?? existsSync;
}

/**
 * A resolver for one request: this machine's id and the location paths are
 * read once, however many folders it resolves. `on` resolves for another
 * machine (a chat that runs there), whose disk this one can't check.
 */
export function workspaceResolver(container: Container): (ws: Workspace | null, on?: string) => WorkspaceStatus {
  const self = container.store.nodes.self().id;
  const paths = container.store.locations.allPaths();
  const exists = existsFor(container);
  return (ws, on = self) => resolveWorkspace(ws, on, paths, on === self ? exists : () => true);
}

/**
 * The folder on this machine for the API's `workspaceRoot`: the resolved one,
 * or, when it's missing, the path it was expected at (so the folder field
 * still shows it); null when there is none here at all.
 */
function viewRoot(status: WorkspaceStatus): string | null {
  if (status.status === 'ok') return status.root;
  if (status.status === 'unresolved' && status.reason === 'missing') return status.hint?.path ?? null;
  return null;
}

/** Extra folders as the API shows them: each resolved on the machine `on` (spec 2026-10-07-extra-folders). */
function folderViews(folders: ExtraFolder[] | undefined, resolve: (ws: Workspace | null, on?: string) => WorkspaceStatus, on?: string): { folderViews?: FolderView[] } {
  if (!folders || folders.length === 0) return {};
  return {
    folderViews: folders.map((folder) => {
      const status = resolve(folder.workspace, on);
      return { ...folder, root: viewRoot(status), status };
    }),
  };
}

/** A chat as the API shows it: its folder (and extra folders) resolved on the machine it runs on. */
export function chatView(container: Container, chat: Chat, resolve = workspaceResolver(container)): Chat {
  const status = resolve(chat.workspace, chat.runsOn);
  return { ...chat, workspaceRoot: viewRoot(status), workspaceStatus: status, ...folderViews(chat.folders, resolve, chat.runsOn) };
}

export function chatViews(container: Container, chats: Chat[]): Chat[] {
  const resolve = workspaceResolver(container);
  return chats.map((chat) => chatView(container, chat, resolve));
}

export function projectView(container: Container, project: Project, resolve = workspaceResolver(container)): Project {
  const status = resolve(project.workspace);
  return { ...project, workspaceRoot: viewRoot(status), workspaceStatus: status, ...folderViews(project.folders, resolve) };
}

export function projectViews(container: Container, projects: Project[]): Project[] {
  const resolve = workspaceResolver(container);
  return projects.map((project) => projectView(container, project, resolve));
}

/** An app (spec 2026-10-20-code-tab-design) as the API shows it: its folder resolved on this machine, like a project's. Apps have no extra folders. */
export function appView(container: Container, app: App, resolve = workspaceResolver(container)): App {
  const status = resolve(app.workspace);
  return { ...app, workspaceRoot: viewRoot(status), workspaceStatus: status };
}

export function appViews(container: Container, apps: App[]): App[] {
  const resolve = workspaceResolver(container);
  return apps.map((app) => appView(container, app, resolve));
}

/** An app event as the events stream sends it: a chat it carries is shown as the API shows chats. */
export function eventView(container: Container, event: AppEvent): AppEvent {
  if (event.type === 'chat-created' || event.type === 'chat-updated') return { ...event, chat: chatView(container, event.chat) };
  return event;
}

interface WorkspaceBody {
  workspace?: unknown;
  workspacePath?: unknown;
  workspaceRoot?: unknown;
}

/**
 * The folder a chat or project body sets, or undefined when it sets none.
 * `workspacePath` (or its older name `workspaceRoot`) is an absolute path on
 * this machine, stored location-relative when it's inside one of this
 * machine's locations; `workspace: null` clears it. A full `Workspace` object
 * is never accepted from a client.
 */
export function parseWorkspaceBody(container: Container, body: WorkspaceBody, on?: string): Workspace | null | undefined {
  if (body.workspace !== undefined) {
    if (body.workspace !== null) {
      throw new HTTPException(400, { message: '"workspace" can only be null here; set a folder with "workspacePath".' });
    }
    return null;
  }
  const field = body.workspacePath !== undefined ? 'workspacePath' : 'workspaceRoot';
  const raw = body.workspacePath !== undefined ? body.workspacePath : body.workspaceRoot;
  const path = optionalWorkspaceRoot(raw, field);
  if (path === undefined) return undefined;
  if (path === null) return null;
  const node = on ?? container.store.nodes.self().id;
  return classifyPath(path, node, container.store.locations.pathsForNode(node));
}

/**
 * The extra folders a chat or project body sets (spec 2026-10-07-extra-folders),
 * or undefined when it sets none. Each entry is `{ path, access }` -- an
 * absolute path on the machine `on`, stored location-relative when it's
 * inside one of that machine's locations -- or `{ workspace, access }` naming
 * one of the folders it already has (`current`), which keeps a folder this
 * machine can't see. As with the workspace, a client never sets an arbitrary
 * stored folder. Duplicates merge, the stricter access winning; the workspace
 * itself, and more than MAX_EXTRA_FOLDERS, are refused.
 */
export function parseFoldersBody(
  container: Container,
  raw: unknown,
  current: readonly ExtraFolder[],
  workspace: Workspace | null,
  on?: string
): ExtraFolder[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new HTTPException(400, { message: '"folders" must be a list.' });
  if (raw.length > MAX_EXTRA_FOLDERS) throw new HTTPException(400, { message: `A chat or project can have at most ${MAX_EXTRA_FOLDERS} other folders.` });
  const node = on ?? container.store.nodes.self().id;
  const folders: ExtraFolder[] = raw.map((entry: unknown, i) => {
    const where = `folders[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new HTTPException(400, { message: `"${where}" must be an object.` });
    const { path, workspace: stored, access } = entry as { path?: unknown; workspace?: unknown; access?: unknown };
    if (access !== 'read' && access !== 'readwrite') throw new HTTPException(400, { message: `"${where}.access" must be "read" or "readwrite".` });
    let folder: Workspace;
    if (path !== undefined) {
      const abs = optionalWorkspaceRoot(path, `${where}.path`);
      if (!abs) throw new HTTPException(400, { message: `"${where}.path" must be a folder's absolute path.` });
      folder = classifyPath(abs, node, container.store.locations.pathsForNode(node));
    } else {
      const kept = parseFolders([{ workspace: stored, access }])[0];
      if (!kept || !current.some((c) => sameWorkspace(c.workspace, kept.workspace))) {
        throw new HTTPException(400, { message: `"${where}" must give a "path", or name one of the folders it already has.` });
      }
      folder = kept.workspace;
    }
    if (workspace !== null && sameWorkspace(folder, workspace)) {
      throw new HTTPException(400, { message: `"${where}" is the workspace folder itself; it's already available.` });
    }
    return { workspace: folder, access };
  });
  return mergeFolders(folders);
}
