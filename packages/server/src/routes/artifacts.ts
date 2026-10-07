import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { artifactFileName, artifactsOnBranch, artifactTitleOk, currentVersion, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_TITLE, versionFileName } from '@grunt/core/domain/artifacts.js';
import { containPathIn, PathEscapeError } from '@grunt/core/domain/paths.js';
import { activePath, extendToTip } from '@grunt/core/domain/tree.js';
import type { Artifact, Chat, Store } from '@grunt/core/ports/store.js';
import { openVerified } from '@grunt/tools/fs-tools.js';
import type { Container } from '../container.js';
import { ambiguousOnWindows, chatRoots, OUTSIDE_MESSAGE, viewFailure } from '../view/roots.js';
import { collectMessageTree } from './chats.js';

/** The branch the chat shows (its head extended to the tip, as the thread displays it), and that branch's newest message. */
export function chatBranch(store: Store, chat: Chat): { onBranch: (messageId: string) => boolean; tip: string | null } {
  if (!chat.headMessageId) return { onBranch: () => false, tip: null };
  const messages = collectMessageTree(store, chat.id);
  try {
    let path = activePath(messages, chat.headMessageId);
    const tail = path.at(-1);
    if (tail) path = [...path, ...extendToTip(messages, tail.id)];
    const ids = new Set(path.map((m) => m.id));
    return { onBranch: (id) => ids.has(id), tip: path.at(-1)?.id ?? null };
  } catch {
    return { onBranch: () => false, tip: null };
  }
}

function requireJson(c: Context): void {
  if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) throw new HTTPException(415, { message: 'Send the request as JSON.' });
}

function chatOrThrow(container: Container, id: string): Chat {
  const chat = container.store.chats.get(id);
  if (!chat) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
  return chat;
}

function artifactOrThrow(container: Container, chatId: string, artifactId: string): { chat: Chat; artifact: Artifact } {
  const chat = chatOrThrow(container, chatId);
  const artifact = container.store.artifacts.get(artifactId);
  if (!artifact || artifact.chatId !== chat.id) throw new HTTPException(404, { message: 'Artifact not found in this chat.' });
  return { chat, artifact };
}

/**
 * Artifact routes (spec 2026-10-07-artifacts, Deck #896), mounted at the
 * authed root: the chat's artifacts on its branch, one artifact's versions,
 * a version's content, your edit (a new version), and Save to workspace.
 * Not on the peer listener: artifacts reach the other machine by sync.
 */
export function artifactsRoutes(container: Container): Hono {
  const app = new Hono();
  const store = container.store;

  app.get('/chats/:id/artifacts', (c) => {
    const chat = chatOrThrow(container, c.req.param('id'));
    const { onBranch } = chatBranch(store, chat);
    return c.json({
      artifacts: artifactsOnBranch(store, chat.id, onBranch).map(({ artifact, current }) => ({
        id: artifact.id, slug: artifact.slug, kind: current.kind, language: current.language,
        title: current.title, versionId: current.id, number: current.number, madeBy: current.madeBy,
      })),
    });
  });

  app.get('/chats/:id/artifacts/:artifactId', (c) => {
    const { chat, artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    const { onBranch } = chatBranch(store, chat);
    const versions = store.artifacts.versions(artifact.id);
    const current = currentVersion(versions, onBranch);
    // Each version is its own kind (a note made into a page), so each has its own file name.
    return c.json({
      artifact,
      fileName: current ? versionFileName(artifact, current) : artifactFileName(artifact),
      currentVersionId: current?.id ?? null,
      versions: versions.map((v) => ({
        id: v.id, number: v.number, title: v.title, madeBy: v.madeBy, createdAt: v.createdAt, onBranch: v.messageId !== null && onBranch(v.messageId),
        kind: v.kind, language: v.language, fileName: versionFileName(artifact, v),
      })),
    });
  });

  app.get('/chats/:id/artifacts/:artifactId/versions/:versionId', (c) => {
    const { artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    const version = store.artifacts.getVersion(c.req.param('versionId'));
    if (!version || version.artifactId !== artifact.id) throw new HTTPException(404, { message: 'Version not found.' });
    return c.json(version);
  });

  app.put('/chats/:id/artifacts/:artifactId', async (c) => {
    requireJson(c);
    const { chat, artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown; title?: unknown; fromVersionId?: unknown };
    if (typeof body.content !== 'string') throw new HTTPException(400, { message: '"content" must be text.' });
    if (Buffer.byteLength(body.content, 'utf8') > MAX_ARTIFACT_BYTES) throw new HTTPException(400, { message: 'An artifact version can be at most 1 MB.' });
    // The title goes into the model's system prompt, so the same rule as the tool's: one line.
    if (body.title !== undefined && (typeof body.title !== 'string' || !artifactTitleOk(body.title))) {
      throw new HTTPException(400, { message: `"title" must be one line of 1-${MAX_ARTIFACT_TITLE} characters.` });
    }
    const { onBranch, tip } = chatBranch(store, chat);
    const versions = store.artifacts.versions(artifact.id);
    const from = (typeof body.fromVersionId === 'string' ? versions.find((v) => v.id === body.fromVersionId) : undefined) ?? currentVersion(versions, onBranch) ?? versions.at(-1) ?? null;
    const version = store.artifacts.addVersion({
      id: randomUUID(),
      artifactId: artifact.id,
      title: typeof body.title === 'string' ? body.title.trim() : (from?.title ?? artifact.slug),
      content: body.content,
      // Your edit is the kind of the version it was made from.
      ...(from ? { kind: from.kind, language: from.language } : {}),
      madeBy: 'user',
      messageId: tip,
      parentVersionId: from?.id ?? null,
      createdAt: Date.now(),
    });
    return c.json(version, 201);
  });

  app.post('/chats/:id/artifacts/:artifactId/save', async (c) => {
    requireJson(c);
    const { chat, artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    const body = (await c.req.json().catch(() => ({}))) as { versionId?: unknown; path?: unknown; replace?: unknown };
    const version = typeof body.versionId === 'string' ? store.artifacts.getVersion(body.versionId) : null;
    if (!version || version.artifactId !== artifact.id) throw new HTTPException(404, { message: 'Version not found.' });
    if (typeof body.path !== 'string' || body.path.trim() === '' || body.path.includes('\0')) throw new HTTPException(400, { message: '"path" must be a file path.' });
    const path = body.path.trim();
    const roots = chatRoots(container, chat);
    if (roots.workspaceRoot === null) throw new HTTPException(404, { message: 'This chat has no workspace folder on this machine.' });
    if (process.platform === 'win32' && ambiguousOnWindows(path)) throw new HTTPException(400, { message: `Can't save to ${path}.` });
    const absolute = isAbsolute(path) ? path : resolve(roots.workspaceRoot, path);
    let located: { root: string; writable: boolean };
    try {
      located = containPathIn(roots.workspaceRoot, roots.folders, absolute);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HTTPException(404, { message: OUTSIDE_MESSAGE });
      throw err;
    }
    if (!located.writable) throw new HTTPException(403, { message: 'That folder is read-only for this chat.' });
    // Not O_TRUNC: a file is only cut down once the verified open says what it is (fs-tools' write_file).
    let opened: Awaited<ReturnType<typeof openVerified>>;
    try {
      opened = await openVerified(located.root, absolute, fsConstants.O_WRONLY | fsConstants.O_CREAT, { createParents: true });
    } catch (err) {
      viewFailure(err, path);
    }
    try {
      if (opened.existed && body.replace !== true) return c.json({ error: `${opened.resolved} already exists.`, exists: true }, 409);
      const buf = Buffer.from(version.content, 'utf8');
      await opened.handle.write(buf, 0, buf.length, 0);
      await opened.handle.truncate(buf.length);
    } finally {
      await opened.handle.close();
    }
    return c.json({ path: opened.resolved });
  });

  return app;
}
