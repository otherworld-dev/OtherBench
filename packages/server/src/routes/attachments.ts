import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Attachment } from '@grunt/core/ports/store.js';
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

function tooLarge(name: string, size: number): HTTPException {
  return new HTTPException(413, {
    message: `"${name}" is ${size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte (25MB) per-file cap.`,
  });
}

/**
 * Strips characters that would make an invalid or ambiguous HTTP header
 * value out of a filename that is otherwise pure display metadata -- see
 * this route's module doc (and blob-store.ts) for the broader
 * path-containment rule this filename is never used for: the STORAGE path
 * is always derived from the content hash, never from this string.
 */
function safeHeaderFilename(filename: string): string {
  return filename.replace(/[\r\n"]/g, '');
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
    const blob = await container.blobStore.put(data);
    const extractedText = await extractAttachmentText(data, mime, file.name);

    const created = container.store.attachments.create({
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

    return c.json(created, 201);
  });

  app.get('/chats/:id/attachments', (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);
    return c.json(container.store.attachments.list(chatId));
  });

  app.get('/attachments/:id', (c) => c.json(getAttachmentOrThrow(container, c.req.param('id'))));

  app.get('/attachments/:id/content', async (c) => {
    const attachment = getAttachmentOrThrow(container, c.req.param('id'));

    let data: Buffer;
    try {
      data = await container.blobStore.get(attachment.sha256);
    } catch {
      throw new HTTPException(404, { message: `Attachment "${attachment.id}"'s blob is missing on disk.` });
    }

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': attachment.mime,
        'Content-Disposition': `inline; filename="${safeHeaderFilename(attachment.filename)}"`,
        'Content-Length': String(data.length),
      },
    });
  });

  return app;
}
