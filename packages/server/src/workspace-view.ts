import { existsSync } from 'node:fs';
import { HTTPException } from 'hono/http-exception';
import { classifyPath, resolveWorkspace } from '@grunt/core/domain/workspace.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { AppEvent } from '@grunt/core/types/events.js';
import type { Workspace, WorkspaceStatus } from '@grunt/core/types/workspace.js';
import type { Container } from './container.js';
import { optionalWorkspaceRoot } from './validation.js';

/**
 * Chats and projects as the API returns them: the stored, portable
 * `workspace` plus what it means on THIS machine (v2 spec §6), so the UI
 * never resolves a folder itself.
 */

/** Whether a folder exists here; the container's own check when it has one (tests), else the real disk. */
function existsFor(container: Container): (path: string) => boolean {
  return container.pathExists ?? existsSync;
}

/** A resolver for one request: this machine's id and the location paths are read once, however many folders it resolves. */
export function workspaceResolver(container: Container): (ws: Workspace | null) => WorkspaceStatus {
  const self = container.store.nodes.self().id;
  const paths = container.store.locations.allPaths();
  const exists = existsFor(container);
  return (ws) => resolveWorkspace(ws, self, paths, exists);
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

export function chatView(container: Container, chat: Chat, resolve = workspaceResolver(container)): Chat {
  const status = resolve(chat.workspace);
  return { ...chat, workspaceRoot: viewRoot(status), workspaceStatus: status };
}

export function chatViews(container: Container, chats: Chat[]): Chat[] {
  const resolve = workspaceResolver(container);
  return chats.map((chat) => chatView(container, chat, resolve));
}

export function projectView(container: Container, project: Project, resolve = workspaceResolver(container)): Project {
  const status = resolve(project.workspace);
  return { ...project, workspaceRoot: viewRoot(status), workspaceStatus: status };
}

export function projectViews(container: Container, projects: Project[]): Project[] {
  const resolve = workspaceResolver(container);
  return projects.map((project) => projectView(container, project, resolve));
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
export function parseWorkspaceBody(container: Container, body: WorkspaceBody): Workspace | null | undefined {
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
  const self = container.store.nodes.self().id;
  return classifyPath(path, self, container.store.locations.pathsForNode(self));
}
