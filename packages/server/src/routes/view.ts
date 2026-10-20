import { basename, join } from 'node:path';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { versionFileName } from '@otherbench/core/domain/artifacts.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import { sniffBinary } from '@otherbench/tools/fs-tools.js';
import type { Container } from '../container.js';
import { kindByName, type ViewKind } from '../view/kinds.js';
import type { ViewLinks } from '../view/links.js';
import { chatRoots, listForView, locateForView, openForView } from '../view/roots.js';

/** The most of a text file `GET /api/view/text` returns (spec 2026-10-07-viewer). */
export const MAX_VIEW_TEXT_BYTES = 2 * 1024 * 1024;

function chatOf(container: Container, raw: unknown): Chat {
  if (typeof raw !== 'string' || raw === '') throw new HTTPException(400, { message: '"chatId" is required.' });
  const chat = container.store.chats.get(raw);
  if (!chat) throw new HTTPException(404, { message: `Chat "${raw}" not found.` });
  return chat;
}

export function pathOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0')) throw new HTTPException(400, { message: '"path" must be a file path.' });
  return raw.trim();
}

/** What `GET /api/view/text` answers: the file's resolved path, at most MAX_VIEW_TEXT_BYTES of it as UTF-8, and whether it was cut. */
export interface ViewText {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

/** One entry of a `GET /api/view/dirs` listing. */
export interface ViewDirEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

/**
 * Reads a text file for the viewer: `target` already contained to `root`,
 * opened through fs-tools' verified open. A folder is a 400, a binary file a
 * 415. Shared by `GET /api/view/text` and the Code tab's app-scoped
 * `GET /api/apps/:id/text` (spec 2026-10-20-code-tab-design, Goal 4), so the
 * two can never read files differently.
 */
export async function readViewText(root: string, target: string, shownAs: string): Promise<ViewText> {
  const { handle, resolved } = await openForView(root, target, shownAs);
  try {
    const st = await handle.stat();
    if (st.isDirectory()) throw new HTTPException(400, { message: `${shownAs} is a folder; open a file in it.` });
    if (await sniffBinary(handle)) throw new HTTPException(415, { message: "Can't preview this." });
    const want = Math.min(st.size, MAX_VIEW_TEXT_BYTES);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, 0);
    return { path: resolved, content: buf.subarray(0, bytesRead).toString('utf8'), truncated: st.size > MAX_VIEW_TEXT_BYTES, size: st.size };
  } finally {
    await handle.close();
  }
}

/**
 * One folder of the Files tree, folders first and then by name: `target`
 * already contained to `root`, listed through fs-tools' verified readdir.
 * Shared by `GET /api/view/dirs` and the Code tab's `GET /api/apps/:id/files`.
 */
export async function listViewDir(root: string, target: string, shownAs: string): Promise<{ path: string; entries: ViewDirEntry[] }> {
  const { resolved, dirents } = await listForView(root, target, shownAs);
  const entries = dirents
    .map((d) => ({ name: d.name, path: join(resolved, d.name), type: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: resolved, entries };
}

/**
 * The viewer's authed routes (Deck #826), mounted at `/api/view`: what a path
 * opens as (and a link for what the browser loads itself), text, and the
 * Files tree. Every path is a chat's, contained to its folders on this
 * machine. Not mounted on the peer listener.
 */
export function viewRoutes(container: Container, links: ViewLinks, clientOf?: (c: Context) => string): Hono {
  const app = new Hono();

  app.post('/links', async (c) => {
    // JSON only: a cross-site form can post text/plain without asking first, but not this.
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      throw new HTTPException(415, { message: 'Send the request as JSON.' });
    }
    const body = (await c.req.json().catch(() => ({}))) as { chatId?: unknown; path?: unknown; artifactVersionId?: unknown };
    const chat = chatOf(container, body.chatId);
    // An artifact version (Deck #896): pages, SVGs and diagrams are served in
    // the sandbox like a file; Markdown and code are shown from their text.
    if (body.artifactVersionId !== undefined) {
      const version = typeof body.artifactVersionId === 'string' ? container.store.artifacts.getVersion(body.artifactVersionId) : null;
      const artifact = version ? container.store.artifacts.get(version.artifactId) : null;
      if (!version || !artifact || artifact.chatId !== chat.id) throw new HTTPException(404, { message: 'Artifact version not found in this chat.' });
      // Each version is its own kind (a note made into a page).
      const linked = version.kind === 'html' || version.kind === 'svg' || version.kind === 'mermaid';
      const name = version.kind === 'mermaid' ? 'diagram.html' : versionFileName(artifact, version);
      const kinds: Record<typeof version.kind, ViewKind> = { html: 'html', mermaid: 'html', svg: 'image', markdown: 'markdown', code: 'text', document: 'markdown', spreadsheet: 'text', presentation: 'text' };
      const url = linked ? `/view/${links.create({ chatId: chat.id, scope: 'artifact', versionId: version.id, ...(clientOf ? { client: clientOf(c) } : {}) })}/${encodeURIComponent(name)}` : null;
      return c.json({ path: '', name, kind: kinds[version.kind], url, size: Buffer.byteLength(version.content, 'utf8') });
    }
    const path = pathOf(body.path);
    const { root, target } = locateForView(chatRoots(container, chat), path);
    const { handle, resolved } = await openForView(root, target, path);
    let kind: ViewKind;
    let size: number;
    try {
      const st = await handle.stat();
      if (st.isDirectory()) throw new HTTPException(400, { message: `${path} is a folder; open a file in it.` });
      size = st.size;
      kind = kindByName(resolved) ?? ((await sniffBinary(handle)) ? 'other' : 'text');
    } finally {
      await handle.close();
    }
    const name = basename(resolved);
    const linked = kind === 'image' || kind === 'video' || kind === 'pdf' || kind === 'html';
    const url = linked ? `/view/${links.create({ chatId: chat.id, root, target: resolved, scope: kind === 'html' ? 'folder' : 'file', ...(clientOf ? { client: clientOf(c) } : {}) })}/${encodeURIComponent(name)}` : null;
    return c.json({ path: resolved, name, kind, url, size });
  });

  app.get('/text', async (c) => {
    const chat = chatOf(container, c.req.query('chatId'));
    const path = pathOf(c.req.query('path'));
    const { root, target } = locateForView(chatRoots(container, chat), path);
    return c.json(await readViewText(root, target, path));
  });

  app.get('/dirs', async (c) => {
    const chat = chatOf(container, c.req.query('chatId'));
    const roots = chatRoots(container, chat);
    const raw = c.req.query('path');
    if (raw === undefined || raw === '') {
      if (roots.workspaceRoot === null) locateForView(roots, '.');
      const workspaceRoot = roots.workspaceRoot!;
      return c.json({
        roots: [
          { path: workspaceRoot, label: basename(workspaceRoot), access: 'readwrite', workspace: true },
          ...roots.folders.map((f) => ({ path: f.root, label: basename(f.root), access: f.access, workspace: false })),
        ],
      });
    }
    const path = pathOf(raw);
    const { root, target } = locateForView(roots, path);
    return c.json(await listViewDir(root, target, path));
  });

  return app;
}
