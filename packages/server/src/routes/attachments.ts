import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { attachmentBound } from '@otherbench/core/domain/attachment-binding.js';
import { sniffToolImageMime, toolImageBound } from '@otherbench/core/domain/tool-images.js';
import type { Attachment, PublicAttachment } from '@otherbench/core/ports/store.js';
import { gcBlobIfOrphaned, withPinnedSha } from '@otherbench/store-sqlite/blob-gc.js';
import { sha256Of } from '@otherbench/store-sqlite/blob-store.js';
import type { Container } from '../container.js';
import { extractAttachmentText } from '../attachment-text.js';
import { requireNonEmptyString } from '../validation.js';

/**
 * 25MB per-file cap (task 21 decision #1). Enforced twice below: once
 * against the `File` object's self-reported `.size` (a fast rejection
 * before reading the body at all), and again against the actual byte
 * length after reading -- the first check trusts the multipart parser/
 * client, the second does not.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Cap on the whole multipart REQUEST body: the per-file cap plus allowance for
 * the multipart framing (boundaries, part headers, any small extra fields).
 * Enforced by `bodyLimit` BEFORE the body is parsed, so an oversized upload is
 * rejected from its Content-Length up front, or aborted mid-stream, instead of
 * being buffered whole by `parseBody()` and only then size-checked. The exact
 * per-file check in the handler stays as the precise backstop.
 */
export const MAX_UPLOAD_BODY_BYTES = MAX_ATTACHMENT_BYTES + 1024 * 1024;

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
 * `getAttachmentOrThrow` for the routes that show a file by its id alone (its
 * details, its bytes). An unsent upload (a preview before sending) has no
 * message and is shown as before. A SENT file is shown only if it is bound the
 * way sync and the turn runner require (`attachmentBound`: its message exists in
 * the file's own chat); a row that fails that is a 404, the same as no row. An
 * edit-and-resend keeps the first message it was sent with, which is in the
 * same chat, so it still passes.
 */
function getShownAttachmentOrThrow(container: Container, id: string): Attachment {
  const attachment = getAttachmentOrThrow(container, id);
  if (attachment.messageId !== null) {
    const message = container.store.messages.get(attachment.messageId);
    if (!attachmentBound(attachment, message?.chatId ?? null)) {
      throw new HTTPException(404, { message: `Attachment "${id}" not found.` });
    }
  }
  return attachment;
}

const TOOL_IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

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
/**
 * What `POST /chats/:id/attachments/from-path` accepts, by extension, and the
 * type each is stored as: inert raster images only, all in
 * INLINE_SAFE_MIME_TYPES, so nothing read off disk this way is ever served
 * as anything active (v2 plan, Task 39).
 */
const FROM_PATH_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** True when `data` starts with the signature of the image type `mime` claims. */
function hasImageSignature(data: Buffer, mime: string): boolean {
  const at = (offset: number, bytes: number[] | string): boolean => {
    const expected = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
    return data.length >= offset + expected.length && data.subarray(offset, offset + expected.length).equals(expected);
  };
  switch (mime) {
    case 'image/png':
      return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return at(0, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'image/webp':
      return at(0, 'RIFF') && at(8, 'WEBP');
    case 'image/bmp':
      return at(0, 'BM');
    case 'image/x-icon':
      return at(0, [0x00, 0x00, 0x01, 0x00]);
    case 'image/avif':
      return at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'));
    default:
      return false;
  }
}

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
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
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
/**
 * Stores `data` as a new unsent attachment on `chatId`. The blob is pinned
 * from before it is written until the row referencing it exists
 * (Important #3, task 32 fix round 1): closes the window where the blob is on
 * disk but nothing references it yet, which a concurrent GC pass
 * (`gcBlobIfOrphaned`/`sweepOrphanedBlobs`, both consult `isPinned`) would
 * otherwise -- correctly, by its own point-in-time view -- see as garbage and
 * remove out from under this upload. Hashed here (not read off
 * `blob.sha256`) because pinning has to start BEFORE `blobStore.put()` is
 * even called.
 */
async function storeAttachment(container: Container, chatId: string, data: Buffer, filename: string, mime: string): Promise<Attachment> {
  const sha256 = sha256Of(data);
  return withPinnedSha(sha256, async () => {
    const blob = await container.blobStore.put(data);
    const extractedText = await extractAttachmentText(data, mime, filename);

    return container.store.attachments.create({
      id: randomUUID(),
      chatId,
      messageId: null,
      filename,
      mime,
      size: blob.size,
      sha256: blob.sha256,
      storagePath: blob.path,
      extractedText,
    });
  });
}

export function attachmentsRoutes(container: Container): Hono {
  const app = new Hono();

  const limitUploadBody = bodyLimit({
    maxSize: MAX_UPLOAD_BODY_BYTES,
    // Thrown (not returned) so the app-wide onError renders the usual `{ error }` JSON.
    onError: () => {
      throw new HTTPException(413, { message: 'That upload is too large. Attachments are limited to 25MB per file.' });
    },
  });

  app.post('/chats/:id/attachments', limitUploadBody, async (c) => {
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
    const created = await storeAttachment(container, chatId, data, file.name, mime);
    return c.json(toPublicAttachment(created), 201);
  });

  /**
   * Attaches an image straight from a path on this machine (v2 plan, Task
   * 39): the desktop app's "Send to OtherBench" verb and `--send <file>`. Images
   * only (FROM_PATH_IMAGE_TYPES): the extension, the real file behind any
   * link, and the file's own leading bytes must all agree, under the same
   * 25MB cap as an upload. It reads a file the caller names, so it only ever
   * belongs on the local listener: the peer listener (Task 46, #783) must
   * mount its own router without it. JSON only: a cross-site
   * form can't send that without a CORS preflight this server never grants.
   */
  app.post('/chats/:id/attachments/from-path', async (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      throw new HTTPException(415, { message: 'Expected a JSON body: {"path": "<absolute path>"}.' });
    }
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
    const path = requireNonEmptyString(body.path, 'path');
    if (!isAbsolute(path)) throw new HTTPException(400, { message: `"path" must be an absolute path; got "${path}".` });
    const mime = FROM_PATH_IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mime) {
      throw new HTTPException(415, { message: `Only images can be attached from a path (${Object.keys(FROM_PATH_IMAGE_TYPES).join(', ')}).` });
    }

    const name = basename(path);
    // A link named like an image must lead to an image: the real file's
    // extension has to be an image type too, and that file is what's read.
    let real: string;
    let size: number;
    try {
      real = await realpath(path);
      const info = await stat(real);
      if (!info.isFile()) throw new HTTPException(400, { message: `"${path}" is not a file.` });
      size = info.size;
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      throw new HTTPException(404, { message: `Couldn't read "${path}".` });
    }
    if (FROM_PATH_IMAGE_TYPES[extname(real).toLowerCase()] !== mime) {
      throw new HTTPException(415, { message: `"${path}" leads to a file that isn't the same kind of image.` });
    }
    if (size > MAX_ATTACHMENT_BYTES) throw tooLarge(name, size);
    const data = await readFile(real);
    // The file may have grown since the stat.
    if (data.length > MAX_ATTACHMENT_BYTES) throw tooLarge(name, data.length);
    // And it has to actually be one: the name alone proves nothing.
    if (!hasImageSignature(data, mime)) {
      throw new HTTPException(415, { message: `"${name}" doesn't look like a ${mime.slice('image/'.length).toUpperCase()} image.` });
    }

    const created = await storeAttachment(container, chatId, data, name, mime);
    return c.json(toPublicAttachment(created), 201);
  });

  app.get('/chats/:id/attachments', (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);
    // An attachment on a message waiting to be sent isn't the composer's to offer again.
    const held = new Set(container.notes?.heldAttachmentIds(chatId) ?? []);
    return c.json(container.store.attachments.list(chatId).filter((a) => !held.has(a.id)).map(toPublicAttachment));
  });

  app.get('/attachments/:id', (c) => c.json(toPublicAttachment(getShownAttachmentOrThrow(container, c.req.param('id')))));

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
   * `gcBlobIfOrphaned` (@otherbench/store-sqlite/blob-gc.js). A filesystem-level
   * GC failure (a locked file, a permissions error, ...) is logged and
   * swallowed by that function itself, never surfaced as a failure of this
   * DELETE -- but a programming/wiring error is NOT swallowed (see that
   * function's own doc) and propagates as a 500 on purpose.
   */
  app.delete('/attachments/:id', async (c) => {
    const attachment = getAttachmentOrThrow(container, c.req.param('id'));
    if (attachment.messageId !== null) {
      throw new HTTPException(409, {
        message: `Attachment "${attachment.id}" has already been sent as part of a message and cannot be deleted.`,
      });
    }
    // Unsent, but on a message waiting to be sent: it goes with that message (or back to the box with it).
    if (container.notes?.heldAttachmentIds(attachment.chatId).includes(attachment.id)) {
      throw new HTTPException(409, { message: 'This attachment is on a message waiting to be sent.' });
    }

    container.store.attachments.delete(attachment.id);
    await gcBlobIfOrphaned(container.store, container.blobStore, attachment.sha256);

    return c.body(null, 204);
  });

  /**
   * An image a tool returned (a screenshot), by the chat and the reply that hold
   * it. The bytes are served only if the file was stored for exactly this chat and
   * this message (`toolImageBound`, the test the model's own replay uses), the
   * message is in the chat, and the bytes really are a png, jpeg, gif or webp: the
   * type is read from them, never from the stored row. Anything else, whatever
   * the reason (no such chat, message or file, another chat's file, another
   * reply's, a type that isn't an image), is the same 404, so the answer says
   * nothing about what exists.
   */
  app.get('/chats/:chatId/messages/:messageId/tool-images/:attachmentId', async (c) => {
    const { chatId, messageId, attachmentId } = c.req.param();
    const notFound = (): HTTPException => new HTTPException(404, { message: 'Image not found.' });
    const message = container.store.messages.get(messageId);
    const row = container.store.attachments.get(attachmentId);
    if (!message || message.chatId !== chatId || !row || !toolImageBound(row, chatId, messageId)) throw notFound();
    const data = await container.blobStore.get(row.sha256).catch(() => null);
    const type = data === null ? null : sniffToolImageMime(data);
    if (data === null || type === null) throw notFound();
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Disposition': contentDisposition('inline', `image.${TOOL_IMAGE_EXTENSIONS[type] ?? 'bin'}`),
        'Content-Length': String(data.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });

  app.get('/attachments/:id/content', async (c) => {
    const attachment = getShownAttachmentOrThrow(container, c.req.param('id'));

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
