import { constants as fsConstants } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { versionFileName } from '@grunt/core/domain/artifacts.js';
import { containPath } from '@grunt/core/domain/paths.js';
import type { ArtifactRepo } from '@grunt/core/ports/store.js';
import { openVerified } from '@grunt/tools/fs-tools.js';
import { servedType } from '../view/kinds.js';
import type { ViewLink, ViewLinks } from '../view/links.js';
import { mermaidPage, mermaidScript } from '../view/mermaid.js';

/** Sent with every /view response. */
const ALWAYS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/**
 * The sandbox for everything a link serves but a PDF (spec 2026-10-07-viewer):
 * scripts run, but in an opaque origin; loads from https, data:, blob: and the
 * link's own folder; network to https and wss only. With Grunt itself on
 * HTTPS (sign-in mode) that no longer keeps a page off Grunt's API; what does
 * is the sandbox's opaque origin: its requests carry no cookie,
 * `Sec-Fetch-Site: cross-site` and `Origin: null`, which the auth gate and the
 * cross-site check refuse. Forms too: `form-action`
 * doesn't fall back to `default-src`, and without it a page could post a
 * form to Grunt's API, which takes a text/plain body as JSON.
 */
export function sandboxPolicy(folderUrl: string): string {
  return `sandbox allow-scripts allow-forms; default-src https: data: blob: 'unsafe-inline' 'unsafe-eval' ${folderUrl}; connect-src https: wss:; form-action https:`;
}

function refuse(c: Context, status: 404 | 415, text: string): Response {
  return c.text(text, status, { ...ALWAYS, 'Content-Security-Policy': "default-src 'none'; sandbox" });
}

/**
 * The path after `/<id>/` (wherever the routes are mounted), decoded segment
 * by segment; null for none, an encoded separator, a dot segment or NUL, and
 * for a segment Windows would read as a different file from its name: one
 * with `:` (a hidden stream) or ending in `.` or a space (dropped).
 */
export function relativeOf(pathname: string, id: string): string | null {
  const marker = `/${id}/`;
  const at = pathname.indexOf(marker);
  if (at === -1) return null;
  const out: string[] = [];
  for (const raw of pathname.slice(at + marker.length).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '' || /[\\/\0:]/.test(segment) || /[. ]$/.test(segment)) return null;
    out.push(segment);
  }
  return out.length > 0 ? out.join('/') : null;
}

/** One `bytes=` range within `size`: null for none (or several, served whole); 'bad' when it can't be satisfied. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, from = '', to = ''] = m;
  if (from === '' && to === '') return 'bad';
  let start: number;
  let end: number;
  if (from === '') {
    const n = Number(to);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return { start, end };
}

/**
 * `GET /view/<id>/…` (Deck #826): what a viewer link serves, with no token --
 * the id is the capability. Each request checks containment again and opens
 * the file the way fs-tools does, so a file swapped after the link was made
 * is refused, and `allowed` is asked whether the link still applies (its
 * folder still the chat's), so removing a folder or deleting the chat ends
 * its links at once. The type is always from view/kinds.ts. Not on the peer
 * listener.
 */
export function viewServeRoutes(
  links: ViewLinks,
  allowed: (link: ViewLink) => boolean = () => true,
  artifacts?: Pick<ArtifactRepo, 'get' | 'getVersion'>,
  clientOf?: (c: Context) => string
): Hono {
  const app = new Hono();

  app.get('/:id/*', async (c) => {
    const id = c.req.param('id');
    const link = links.get(id);
    if (!link || !allowed(link) || (clientOf !== undefined && link.client !== clientOf(c))) return refuse(c, 404, 'This link has expired. Open the file again.');
    const url = new URL(c.req.url);
    const rel = relativeOf(url.pathname, id);
    if (rel === null) return refuse(c, 404, 'Not found.');

    // An artifact version (Deck #896): its own file name only, or a Mermaid
    // diagram's page and Grunt's copy of Mermaid; all in the sandbox.
    if (link.scope === 'artifact') {
      const version = artifacts?.getVersion(link.versionId);
      const artifact = version ? artifacts?.get(version.artifactId) : null;
      if (!version || !artifact) return refuse(c, 404, 'Not found.');
      const policy = sandboxPolicy(`${url.origin}/view/${id}/`);
      const send = (body: string | Buffer, mime: string): Response =>
        c.body(typeof body === 'string' ? body : new Uint8Array(body), 200, { ...ALWAYS, 'Content-Type': mime, 'Content-Disposition': 'inline', 'Content-Security-Policy': policy });
      if (version.kind === 'mermaid') {
        if (rel === 'diagram.html') return send(mermaidPage(version.content), 'text/html; charset=utf-8');
        if (rel === 'mermaid.min.js') return send(await mermaidScript(), 'text/javascript; charset=utf-8');
        return refuse(c, 404, 'Not found.');
      }
      if (rel !== versionFileName(artifact, version)) return refuse(c, 404, 'Not found.');
      if (version.kind === 'html') return send(version.content, 'text/html; charset=utf-8');
      if (version.kind === 'svg') return send(version.content, 'image/svg+xml');
      return refuse(c, 415, "Can't preview this.");
    }

    let candidate: string;
    if (link.scope === 'file') {
      if (rel !== basename(link.target)) return refuse(c, 404, 'Not found.');
      candidate = link.target;
    } else {
      try {
        candidate = containPath(dirname(link.target), rel);
      } catch {
        return refuse(c, 404, 'Not found.');
      }
    }
    const type = servedType(candidate);
    if (!type || (link.scope === 'file' && type.kind === 'asset')) return refuse(c, 415, "Can't preview this.");

    let opened: Awaited<ReturnType<typeof openVerified>>;
    try {
      opened = await openVerified(link.root, candidate, fsConstants.O_RDONLY);
    } catch {
      return refuse(c, 404, 'Not found.');
    }
    const { handle } = opened;
    let size: number;
    try {
      const st = await handle.stat();
      if (st.isDirectory()) throw new Error('directory');
      size = st.size;
    } catch {
      await handle.close();
      return refuse(c, 404, 'Not found.');
    }

    const range = parseRange(c.req.header('Range'), size);
    if (range === 'bad') {
      await handle.close();
      return c.body(null, 416, { ...ALWAYS, 'Content-Range': `bytes */${size}` });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const headers: Record<string, string> = {
      ...ALWAYS,
      'Content-Type': type.mime,
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size === 0 ? 0 : end - start + 1),
    };
    if (type.kind !== 'pdf') headers['Content-Security-Policy'] = sandboxPolicy(`${url.origin}/view/${id}/`);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (size === 0) {
      await handle.close();
      return c.body(null, 200, headers);
    }
    const body = Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as unknown as ReadableStream;
    return c.body(body, range ? 206 : 200, headers);
  });

  return app;
}
