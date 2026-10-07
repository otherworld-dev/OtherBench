import { basename, join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Chat } from '@grunt/core/ports/store.js';
import { sniffBinary } from '@grunt/tools/fs-tools.js';
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

function pathOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0')) throw new HTTPException(400, { message: '"path" must be a file path.' });
  return raw.trim();
}

/**
 * The viewer's authed routes (Deck #826), mounted at `/api/view`: what a path
 * opens as (and a link for what the browser loads itself), text, and the
 * Files tree. Every path is a chat's, contained to its folders on this
 * machine. Not mounted on the peer listener.
 */
export function viewRoutes(container: Container, links: ViewLinks): Hono {
  const app = new Hono();

  app.post('/links', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { chatId?: unknown; path?: unknown };
    const chat = chatOf(container, body.chatId);
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
    const url = linked ? `/view/${links.create({ chatId: chat.id, root, target: resolved, scope: kind === 'html' ? 'folder' : 'file' })}/${encodeURIComponent(name)}` : null;
    return c.json({ path: resolved, name, kind, url, size });
  });

  app.get('/text', async (c) => {
    const chat = chatOf(container, c.req.query('chatId'));
    const path = pathOf(c.req.query('path'));
    const { root, target } = locateForView(chatRoots(container, chat), path);
    const { handle, resolved } = await openForView(root, target, path);
    try {
      const st = await handle.stat();
      if (st.isDirectory()) throw new HTTPException(400, { message: `${path} is a folder; open a file in it.` });
      if (await sniffBinary(handle)) throw new HTTPException(415, { message: "Can't preview this." });
      const want = Math.min(st.size, MAX_VIEW_TEXT_BYTES);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buf, 0, want, 0);
      return c.json({ path: resolved, content: buf.subarray(0, bytesRead).toString('utf8'), truncated: st.size > MAX_VIEW_TEXT_BYTES, size: st.size });
    } finally {
      await handle.close();
    }
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
    const { resolved, dirents } = await listForView(root, target, path);
    const entries = dirents
      .map((d) => ({ name: d.name, path: join(resolved, d.name), type: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return c.json({ path: resolved, entries });
  });

  return app;
}
