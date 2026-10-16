import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { artifactFileName, artifactsOnBranch, artifactTitleOk, currentVersion, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_TITLE, versionFileName } from '@otherbench/core/domain/artifacts.js';
import { containPathIn, PathEscapeError } from '@otherbench/core/domain/paths.js';
import { activePath, extendToTip } from '@otherbench/core/domain/tree.js';
import { checkOfficeContent, isOfficeKind } from '@otherbench/core/domain/office-spec.js';
import type { Artifact, ArtifactVersion, Chat, Store } from '@otherbench/core/ports/store.js';
import { AlreadyExistsError, openVerified } from '@otherbench/tools/fs-tools.js';
import type { Container } from '../container.js';
import { ambiguousOnWindows, chatRoots, OUTSIDE_MESSAGE, viewFailure } from '../view/roots.js';
import { contentDisposition } from './attachments.js';
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

export function requireJson(c: Context): void {
  if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) throw new HTTPException(415, { message: 'Send the request as JSON.' });
}

function chatOrThrow(container: Container, id: string): Chat {
  const chat = container.store.chats.get(id);
  if (!chat) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
  return chat;
}

export function artifactOrThrow(container: Container, chatId: string, artifactId: string): { chat: Chat; artifact: Artifact } {
  const chat = chatOrThrow(container, chatId);
  const artifact = container.store.artifacts.get(artifactId);
  if (!artifact || artifact.chatId !== chat.id) throw new HTTPException(404, { message: 'Artifact not found in this chat.' });
  return { chat, artifact };
}

/**
 * The file a version downloads or saves as (spec 2026-10-12-office-files §4):
 * an Office kind's made .docx/.xlsx/.pptx, any other kind's text as UTF-8.
 * The writers load on first use, as unpdf does. A source that can't be made
 * is a 422 naming the file, before anything is written anywhere.
 */
async function versionFile(artifact: Artifact, version: ArtifactVersion): Promise<{ name: string; bytes: Buffer }> {
  const name = versionFileName(artifact, version);
  if (!isOfficeKind(version.kind)) return { name, bytes: Buffer.from(version.content, 'utf8') };
  const { renderOfficeFile } = await import('../office/render.js');
  try {
    return { name, bytes: await renderOfficeFile(version.kind, version.content, version.title) };
  } catch (err) {
    throw new HTTPException(422, { message: `Couldn't make ${name}: ${err instanceof Error ? err.message : String(err)}` });
  }
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
        live: current.live?.calls.length ?? 0,
      })),
    });
  });

  app.get('/chats/:id/artifacts/:artifactId', (c) => {
    const { chat, artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    const { onBranch } = chatBranch(store, chat);
    const versions = store.artifacts.versionInfos(artifact.id);
    const current = currentVersion(versions, onBranch);
    // Each version is its own kind (a note made into a page), so each has its own file name.
    return c.json({
      artifact,
      fileName: current ? versionFileName(artifact, current) : artifactFileName(artifact),
      currentVersionId: current?.id ?? null,
      versions: versions.map((v) => ({
        id: v.id, number: v.number, title: v.title, madeBy: v.madeBy, createdAt: v.createdAt, onBranch: v.messageId !== null && onBranch(v.messageId),
        kind: v.kind, language: v.language, fileName: versionFileName(artifact, v),
        live: v.live?.calls.length ?? 0,
      })),
    });
  });

  app.get('/chats/:id/artifacts/:artifactId/versions/:versionId', (c) => {
    const { artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    const version = store.artifacts.getVersion(c.req.param('versionId'));
    if (!version || version.artifactId !== artifact.id) throw new HTTPException(404, { message: 'Version not found.' });
    return c.json(version);
  });

  app.get('/chats/:id/artifacts/:artifactId/versions/:versionId/file', async (c) => {
    const { artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    const version = store.artifacts.getVersion(c.req.param('versionId'));
    if (!version || version.artifactId !== artifact.id) throw new HTTPException(404, { message: 'Version not found.' });
    const file = await versionFile(artifact, version);
    // Always a download, never shown: the same headers as an attachment that isn't an inert image.
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition('attachment', file.name),
        'Content-Length': String(file.bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
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
    const versions = store.artifacts.versionInfos(artifact.id);
    const from = (typeof body.fromVersionId === 'string' ? versions.find((v) => v.id === body.fromVersionId) : undefined) ?? currentVersion(versions, onBranch) ?? versions.at(-1) ?? null;
    // An Office source is checked as the tool checks it (spec §3): your edit is the kind it was made from.
    const problem = checkOfficeContent(from?.kind ?? artifact.kind, body.content);
    if (problem) throw new HTTPException(400, { message: problem });
    const version = store.artifacts.addVersion({
      id: randomUUID(),
      artifactId: artifact.id,
      title: typeof body.title === 'string' ? body.title.trim() : (from?.title ?? artifact.slug),
      content: body.content,
      // Your edit is the kind of the version it was made from, with its live calls (spec 2026-10-12-live-artifacts).
      ...(from ? { kind: from.kind, language: from.language, live: from.kind === 'html' ? from.live : null } : {}),
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
    if (ambiguousOnWindows(path)) throw new HTTPException(400, { message: `Can't save to ${path}.` });
    const absolute = isAbsolute(path) ? path : resolve(roots.workspaceRoot, path);
    let located: { root: string; writable: boolean };
    try {
      located = containPathIn(roots.workspaceRoot, roots.folders, absolute);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HTTPException(404, { message: OUTSIDE_MESSAGE });
      throw err;
    }
    if (!located.writable) throw new HTTPException(403, { message: 'That folder is read-only for this chat.' });
    // Make the file before opening anything, so one that can't be made (a 422) writes nothing.
    const file = await versionFile(artifact, version);
    // Not O_TRUNC: a file is only cut down once the verified open says what it is (fs-tools' write_file).
    let opened: Awaited<ReturnType<typeof openVerified>>;
    try {
      opened = await openVerified(located.root, absolute, fsConstants.O_WRONLY | fsConstants.O_CREAT, { createParents: true });
    } catch (err) {
      // Another program made the file between the check and the open: ask, as for any file that's there.
      if (err instanceof AlreadyExistsError) return c.json({ error: `${path} was just created by another program.`, exists: true }, 409);
      viewFailure(err, path);
    }
    try {
      if (opened.existed && body.replace !== true) return c.json({ error: `${opened.resolved} already exists.`, exists: true }, 409);
      const buf = file.bytes;
      await opened.handle.write(buf, 0, buf.length, 0);
      await opened.handle.truncate(buf.length);
    } finally {
      await opened.handle.close();
    }
    return c.json({ path: opened.resolved });
  });

  return app;
}
