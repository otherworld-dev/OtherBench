import { constants as fsConstants, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { containPath, containPathIn, PathEscapeError } from '@grunt/core/domain/paths.js';
import { mergeFolders, resolveFolders, resolveWorkspace } from '@grunt/core/domain/workspace.js';
import type { Chat } from '@grunt/core/ports/store.js';
import type { ResolvedFolder } from '@grunt/core/types/workspace.js';
import { HardLinkError, openVerified, readdirVerified, ToctouGuardError } from '@grunt/tools/fs-tools.js';
import type { Container } from '../container.js';
import type { ViewLink } from './links.js';

export const OUTSIDE_MESSAGE = "This isn't in this chat's workspace or folders.";

/** A chat's folders as they are on THIS machine (spec 2026-10-07-viewer): the viewer never reads another machine's files. */
export interface ChatRoots {
  workspaceRoot: string | null;
  folders: ResolvedFolder[];
  /** The name of the machine the chat's workspace is on, when it is only there. */
  elsewhere: string | null;
}

export function chatRoots(container: Container, chat: Chat): ChatRoots {
  const self = container.store.nodes.self().id;
  const paths = container.store.locations.allPaths();
  const exists = container.pathExists ?? existsSync;
  const status = resolveWorkspace(chat.workspace, self, paths, exists);
  const workspaceRoot = status.status === 'ok' ? status.root : null;
  const project = chat.projectId ? container.store.projects.get(chat.projectId) : null;
  const folders = workspaceRoot === null ? [] : resolveFolders(mergeFolders(project?.folders, chat.folders), self, paths, exists, workspaceRoot);
  const nodeId = status.status === 'unresolved' && status.reason === 'other-machine' ? status.hint?.nodeId : undefined;
  const elsewhere = nodeId ? (container.store.peers.get(nodeId)?.name ?? 'another machine') : null;
  return { workspaceRoot, folders, elsewhere };
}

/**
 * Whether Windows would open a different file from the one `path` names: a
 * `:` after the drive (a hidden stream, `notes.txt:x.html`) or a segment
 * ending in `.` or a space, which Windows drops (`notes.txt.`).
 */
export function ambiguousOnWindows(path: string): boolean {
  const rest = /^[A-Za-z]:/.test(path) ? path.slice(2) : path;
  return rest.includes(':') || rest.split(/[\\/]/).some((s) => s !== '.' && s !== '..' && /[. ]$/.test(s));
}

/** Whether a viewer link's folder is still one of its chat's folders here: removing the folder, or deleting the chat, ends its links. */
export function linkStillAllowed(container: Container, link: ViewLink): boolean {
  const chat = container.store.chats.get(link.chatId);
  if (!chat) return false;
  if (link.scope === 'artifact') {
    const version = container.store.artifacts.getVersion(link.versionId);
    const artifact = version ? container.store.artifacts.get(version.artifactId) : null;
    return artifact?.chatId === link.chatId;
  }
  const roots = chatRoots(container, chat);
  return roots.workspaceRoot !== null && [roots.workspaceRoot, ...roots.folders.map((f) => f.root)].includes(link.root);
}

/** Which of the chat's folders `path` is in, and the file resolved; a relative path means the workspace. Throws the panel's message. */
export function locateForView(roots: ChatRoots, path: string): { root: string; target: string } {
  if (process.platform === 'win32' && ambiguousOnWindows(path)) throw new HTTPException(404, { message: `File not found: ${path}` });
  if (roots.workspaceRoot === null) {
    throw new HTTPException(404, { message: roots.elsewhere ? `This file is on ${roots.elsewhere}.` : 'This chat has no workspace folder on this machine.' });
  }
  const absolute = isAbsolute(path) ? path : resolve(roots.workspaceRoot, path);
  try {
    const { root } = containPathIn(roots.workspaceRoot, roots.folders, absolute);
    return { root, target: containPath(root, absolute) };
  } catch (err) {
    viewFailure(err, path);
  }
}

/** A filesystem refusal as the panel's message (spec: the panel always says why). */
export function viewFailure(err: unknown, path: string): never {
  if (err instanceof HTTPException) throw err;
  if (err instanceof PathEscapeError) throw new HTTPException(404, { message: OUTSIDE_MESSAGE });
  if (err instanceof ToctouGuardError || err instanceof HardLinkError) throw new HTTPException(403, { message: err.message });
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new HTTPException(404, { message: `File not found: ${path}` });
  if (code === 'EISDIR') throw new HTTPException(400, { message: `${path} is a folder; open a file in it.` });
  throw err;
}

/** fs-tools' verified open, read-only, with refusals as the panel's messages. `shownAs` is the path as asked for. */
export async function openForView(root: string, target: string, shownAs: string): Promise<Awaited<ReturnType<typeof openVerified>>> {
  try {
    return await openVerified(root, target, fsConstants.O_RDONLY);
  } catch (err) {
    viewFailure(err, shownAs);
  }
}

/** fs-tools' verified listing, with refusals as the panel's messages. */
export async function listForView(root: string, target: string, shownAs: string): Promise<Awaited<ReturnType<typeof readdirVerified>>> {
  try {
    return await readdirVerified(root, target);
  } catch (err) {
    viewFailure(err, shownAs);
  }
}
