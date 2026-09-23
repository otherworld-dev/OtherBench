import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Attachment, PublicAttachment } from '@grunt/core/ports/store.js';
import { gcBlobIfOrphaned, withPinnedSha } from '@grunt/store-sqlite/blob-gc.js';
import { sha256Of } from '@grunt/store-sqlite/blob-store.js';
import type { Container } from '../container.js';
import { extractAttachmentText } from '../attachment-text.js';

/**
 * 25MB per-file cap (task 21 decision #1). Enforced twice below: once
 * against the `File` object's self-reported `.size` (a fast rejection
 * before reading the body at all), and again against the actual byte
 * length after reading -- the first check trusts the multipart parser/
 * client, the second does not.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function getChatOrThrow(container: Container, chatId: string): void {
  if (!container.store.chats.get(chatId)) {
    throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
  }
}

function getAttachmentOrThrow(container: Container, id: string): Attachment {
  const attachment = container.store.attachments.get(id);
  if (!attachment) throw new HTTPException(404, { message: `Attachment "${id}" not found.` });
  return attachment;
}

/**
 * Strips `storagePath` -- a raw SERVER filesystem path -- before an
 * `Attachment` row ever reaches `c.json()` (task 32 decision #3). Applied at
 * every response site in this file; the full row (with `storagePath`) is
 * still what every INTERNAL call in this route uses (e.g. `GET .../content`
 * reads `attachment.sha256` off it to load the blob).
 */
function toPublicAttachment(a: Attachment): PublicAttachment {
  const { storagePath, ...rest } = a;
  return rest;
}

function tooLarge(name: string, size: number): HTTPException {
  return new HTTPException(413, {
    message: `"${name}" is ${size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte (25MB) per-file cap.`,
  });
}

/**
 * MIME types that are safe to serve with `Content-Disposition: inline` --
 * i.e. rendering them directly, in this origin, cannot execute script.
 * Everything else is served as `application/octet-stream` with `attachment`
 * disposition (a forced download) regardless of what the caller uploaded it
 * as. This is a strict ALLOWLIST, not a denylist, and it is checked against
 * a normalised copy of the stored MIME, never trusted verbatim -- see this
 * route's module doc for why the stored value can't be trusted at all.
 *
 * `image/svg+xml` is deliberately NOT here even though it superficially
 * looks like "just another image type": SVG is an XML document format that
 * can carry `<script>`, `onload=`, and other script-executing content, and
 * a script that runs in this origin can call this server's own `/api/...`
 * as the user -- including the shell tool. Every type below is a raster
 * format with no comparable script surface, so an attacker who mislabels
 * arbitrary bytes with one of these MIME types gets, at worst, a broken
 * image (the browser tries to decode it as that raster format and fails),
 * never script execution -- and `X-Content-Type-Options: nosniff` below
 * closes off the one remaining route to that (the browser sniffing the
 * bytes and rendering them as something other than what Content-Type says).
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/avif',
]);

/** Strips any `;charset=...`-style parameter and normalises case/whitespace, so a stored MIME value like `"Image/PNG ; foo=bar"` still matches the allowlist by its base type. */
function baseMimeType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Builds a `Content-Disposition` header value that cannot be used to inject
 * a second header or break out of the quoted filename, from a filename that
 * is attacker-controlled upload metadata (see this route's module doc) --
 * see blob-store.ts for the broader path-containment rule this filename is
 * never used for: the STORAGE path is always derived from the content hash,
 * never from this string.
 *
 * Two defences, both required:
 *   - Control characters (CR, LF, and friends) are stripped outright -- a
 *     filename containing a raw CRLF pair could otherwise split the
 *     response into two headers (response splitting / header injection).
 *   - The legacy, quoted `filename="..."` fallback has its `"` and `\`
 *     characters removed so it can never terminate the quoted string early
 *     (a lone trailing backslash would otherwise escape the closing quote
 *     under the HTTP quoted-string grammar, leaving the value ambiguous to
 *     a strict parser). The real, EXACT filename -- including any
 *     originally-quote-or-backslash-bearing or non-ASCII content -- travels
 *     in the RFC 5987 `filename*=UTF-8''...` extended parameter instead,
 *     which is percent-encoded and therefore cannot contain a literal
 *     quote, backslash, CR, LF, or any other header-breaking byte.
 */
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const stripped = filename.replace(/[\x00-\x1f\x7f]/g, '');
  const asciiFallback = stripped.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(stripped) || 'download';
  return `${kind}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * `packages/server/src/routes/attachments.ts` (task 21): upload, list, and
 * fetch attachments. Storage is content-addressed on disk via
 * `Container.blobStore` (packages/store-sqlite/src/blob-store.ts); this
 * route owns the metadata row (`AttachmentRepo`), the 25MB cap, and text
 * extraction (attachment-text.ts) for the capability-fallback column
 * `extracted_text` that `TurnRunner.degradeImagesForVision` reads later.
 *
 * The uploaded file's ORIGINAL filename is stored as metadata only
 * (`Attachment.filename`) and is never joined into any filesystem path --
 * `BlobStore.put()` doesn't even accept one, by construction.
 *
 * **`GET /attachments/:id/content` serves attacker-controlled bytes from
 * this app's OWN origin, which also hosts an API that can run shell
 * commands (the `run_command` tool) and, when configured, holds the bearer
 * token.** A response that renders as HTML or SVG in the browser is
 * therefore not "an alert box in a sandboxed viewer" -- script executing in
 * this origin can call `/api/...` as the user, including the shell tool.
 * Both the attachment's stored MIME type (`file.type` off the multipart
 * upload -- fully attacker-controlled) and its original filename are
 * treated as such throughout this route: the response `Content-Type` is
 * NEVER the stored value verbatim, only ever a literal from
 * `INLINE_SAFE_MIME_TYPES` or the fixed fallback `application/octet-stream`
 * (see that constant's doc for why SVG is deliberately excluded even though
 * it looks like "just another image type"), `Content-Disposition` defaults
 * to `attachment` (forces a download) and is only ever `inline` for that
 * same narrow allowlist, and the filename is run through
 * `contentDisposition()` rather than interpolated directly, so it can
 * neither inject a header nor break out of the quoted value.
 */
export function attachmentsRoutes(container: Container): Hono {
  const app = new Hono();

  app.post('/chats/:id/attachments', async (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);

    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      throw new HTTPException(400, { message: 'Expected multipart/form-data with a "file" field.' });
    }

    const file = body['file'];
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: 'Missing "file" field (expected multipart/form-data).' });
    }
    if (file.size > MAX_ATTACHMENT_BYTES) throw tooLarge(file.name, file.size);

    const data = Buffer.from(await file.arrayBuffer());
    // Re-checked against the bytes actually read, not just the File API's
    // self-reported `.size` -- see MAX_ATTACHMENT_BYTES's doc.
    if (data.length > MAX_ATTACHMENT_BYTES) throw tooLarge(file.name, data.length);

    const mime = file.type || 'application/octet-stream';

    // Pinned from BEFORE the blob is written until AFTER the attachment row
    // exists (Important #3, task 32 fix round 1): closes the window where
    // the blob is on disk but nothing references it yet, which a concurrent
    // GC pass (`gcBlobIfOrphaned`/`sweepOrphanedBlobs`, both consult
    // `isPinned`) would otherwise -- correctly, by its own point-in-time
    // view -- see as garbage and remove out from under this upload. Hashed
    // here (not read off `blob.sha256`) because pinning has to start BEFORE
    // `blobStore.put()` is even called.
    const sha256 = sha256Of(data);
    const created = await withPinnedSha(sha256, async () => {
      const blob = await container.blobStore.put(data);
      const extractedText = await extractAttachmentText(data, mime, file.name);

      return container.store.attachments.create({
        id: randomUUID(),
        chatId,
        messageId: null,
        filename: file.name,
        mime,
        size: blob.size,
        sha256: blob.sha256,
        storagePath: blob.path,
        extractedText,
      });
    });

    return c.json(toPublicAttachment(created), 201);
  });

  app.get('/chats/:id/attachments', (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);
    return c.json(container.store.attachments.list(chatId).map(toPublicAttachment));
  });

  app.get('/attachments/:id', (c) => c.json(toPublicAttachment(getAttachmentOrThrow(container, c.req.param('id')))));

  /**
   * Deletes an UNSENT attachment (task 32 decision #1): `messageId === null`
   * means it was uploaded but never sent as part of a message. An
   * already-sent attachment is part of that message's history -- deleting
   * it would make the transcript misrepresent what was actually sent to the
   * model, and its image/file part would 404 on next render -- so that case
   * is refused with 409 rather than allowed. Unknown id is a 404, same as
   * every other attachment route.
   *
   * Removes the row first, then GCs its blob (a no-op if some OTHER
   * attachment row -- upload dedupes by content hash, possibly in a
   * different chat entirely -- still references the same sha256): see
   * `gcBlobIfOrphaned` (@grunt/store-sqlite/blob-gc.js). GC failures are
   * logged and swallowed by that function itself, never surfaced as a
   * failure of this DELETE.
   */
  app.delete('/attachments/:id', async (c) => {
    const attachment = getAttachmentOrThrow(container, c.req.param('id'));
    if (attachment.messageId !== null) {
      throw new HTTPException(409, {
        message: `Attachment "${attachment.id}" has already been sent as part of a message and cannot be deleted.`,
      });
    }

    container.store.attachments.delete(attachment.id);
    await gcBlobIfOrphaned(container.store, container.blobStore, attachment.sha256);

    return c.body(null, 204);
  });

  app.get('/attachments/:id/content', async (c) => {
    const attachment = getAttachmentOrThrow(container, c.req.param('id'));

    let data: Buffer;
    try {
      data = await container.blobStore.get(attachment.sha256);
    } catch {
      throw new HTTPException(404, { message: `Attachment "${attachment.id}"'s blob is missing on disk.` });
    }

    // Never trust the stored MIME for the response Content-Type -- it's
    // attacker-controlled upload metadata (see the module doc above). Only
    // a strict allowlist of inert raster image types is served with its
    // real type and `inline` disposition; everything else -- including
    // SVG, which CAN carry script -- is served as an opaque, forced
    // download. `servedType` is always a literal from the allowlist itself
    // (never the raw stored string), so even a byte-for-byte match can't
    // smuggle anything extra through.
    const inlineSafe = INLINE_SAFE_MIME_TYPES.has(baseMimeType(attachment.mime));
    const servedType = inlineSafe ? baseMimeType(attachment.mime) : 'application/octet-stream';
    const disposition = inlineSafe ? 'inline' : 'attachment';

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': servedType,
        'Content-Disposition': contentDisposition(disposition, attachment.filename),
        'Content-Length': String(data.length),
        // Belt-and-braces alongside the allowlist above: even if a browser
        // would otherwise sniff these bytes as something more dangerous
        // than `servedType` claims, this forbids that outright.
        'X-Content-Type-Options': 'nosniff',
        // Defence in depth: even for an `inline` (raster-image) response,
        // this forbids the response from loading anything else or being
        // treated as an active document, in browsers that honour CSP on a
        // directly-navigated resource.
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });

  return app;
}
