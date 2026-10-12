import type { CanonMessage, Part } from '../types/messages.js';

/**
 * Images in tool results (spec 2026-10-12-computer-use-design section 6). A
 * tool may answer with MCP-style content items, `{ type: 'image', data,
 * mimeType }` among them (a computer screenshot, an MCP server's image).
 * Before such a result is broadcast or stored, each image goes to the blob
 * store and is replaced by a reference, so base64 never reaches an SSE client
 * or a message row. The web app imports the type guards, so nothing here may
 * use a Node API at module load.
 *
 * A reference is minted in exactly one place: `keepToolImages`, from bytes
 * the tool handed over in THIS call, stored by `TurnRunner` for this chat and
 * this reply (the attachment row carries both). A reference that a tool, a
 * synced message or an old row supplies is never trusted: `keepToolImages`
 * removes it, and `bindToolImageParts` / `bindToolImages` keep one only while
 * its attachment row is bound to the chat and the message that holds it.
 */

export const TOOL_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_TOOL_IMAGES_PER_MESSAGE = 50;
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_NOT_KEPT = '[image not kept]';
export const IMAGE_NOT_KEPT_LIMIT = '[image not kept: too many or too large]';
export const TOOL_IMAGE_REF_REMOVED = "[image reference removed: tools can't refer to stored images]";
export const TOOL_IMAGE_NOT_BOUND = '[image omitted: it is not stored with this chat]';

/** The longest base64 text that can still decode to `MAX_TOOL_IMAGE_BYTES` (padding included). */
const MAX_TOOL_IMAGE_BASE64 = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4;

/** Stores one image for a reply and returns the attachment id (server/src/tool-images.ts). */
export type SaveToolImage = (chatId: string, messageId: string, bytes: Buffer, mime: string) => Promise<string>;

export interface InlineToolImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolImageRef {
  type: 'image';
  attachmentId: string;
  mimeType: string;
}

/** The part of an attachment row the binding check reads. */
export interface ToolImageRow {
  chatId: string;
  messageId: string | null;
  mime: string;
  /** Stored size in bytes, when known; over `MAX_TOOL_IMAGE_BYTES` never counts as bound. */
  size?: number;
}

export type ToolImageLookup = (attachmentId: string) => ToolImageRow | null;

export function isInlineToolImage(value: unknown): value is InlineToolImage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['type'] === 'image' && typeof v['data'] === 'string' && typeof v['mimeType'] === 'string';
}

export function isToolImageRef(value: unknown): value is ToolImageRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['type'] === 'image' && typeof v['attachmentId'] === 'string' && typeof v['mimeType'] === 'string';
}

/** An item that claims to be an image, whatever else it carries. */
function isImageItem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'image';
}

function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** True when `data` starts with the signature of the raster type `mime` names (png, jpeg, gif, webp). */
export function hasToolImageSignature(data: Buffer, mime: string): boolean {
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
    default:
      return false;
  }
}

/**
 * The raster type `data` really is (png, jpeg, gif or webp, by its leading
 * bytes), or null. What a model is told an image is comes from here, never
 * from a stored row or a tool's own label.
 */
export function sniffToolImageMime(data: Buffer): string | null {
  for (const mime of TOOL_IMAGE_MIMES) if (hasToolImageSignature(data, mime)) return mime;
  return null;
}

/**
 * Whether an attachment row is a tool image stored for exactly this chat and
 * this message: the one test a reference has to pass, wherever it is read.
 * The row's size is held to the same cap as a stored image.
 */
export function toolImageBound(row: ToolImageRow, chatId: string, messageId: string): boolean {
  return (
    row.chatId === chatId &&
    row.messageId === messageId &&
    TOOL_IMAGE_MIMES.includes(baseMime(row.mime)) &&
    (row.size === undefined || (row.size >= 0 && row.size <= MAX_TOOL_IMAGE_BYTES))
  );
}

/**
 * `result` with every inline image stored through `save` and replaced by a
 * reference. A result with no image item comes back as the same object.
 * An image of another type (or whose bytes aren't that type), or with nowhere
 * to store it, or that fails to store, becomes `[image not kept]`; past
 * `MAX_TOOL_IMAGES_PER_MESSAGE` for the message (`budget` counts them across
 * the reply) or over `MAX_TOOL_IMAGE_BYTES`, `[image not kept: too many or
 * too large]`.
 *
 * An image item that is NOT an inline image (a reference to a stored image,
 * or anything else shaped like one) is a forgery: a tool can't make a
 * reference, only this function can. It becomes `TOOL_IMAGE_REF_REMOVED` and
 * the rest of the result stays. `toolName` is all that is logged about it.
 */
export async function keepToolImages(
  result: unknown,
  save: SaveToolImage | undefined,
  chatId: string,
  messageId: string,
  budget: { kept: number },
  toolName?: string
): Promise<unknown> {
  if (!Array.isArray(result) || !result.some(isImageItem)) return result;
  const out: unknown[] = [];
  let forged = false;
  for (const item of result) {
    if (!isImageItem(item)) {
      out.push(item);
      continue;
    }
    if (!isInlineToolImage(item)) {
      forged = true;
      out.push({ type: 'text', text: TOOL_IMAGE_REF_REMOVED });
      continue;
    }
    const mime = baseMime(item.mimeType);
    if (!save || !TOOL_IMAGE_MIMES.includes(mime)) {
      out.push({ type: 'text', text: IMAGE_NOT_KEPT });
      continue;
    }
    // Checked on the text first, so an oversized image is never decoded.
    if (budget.kept >= MAX_TOOL_IMAGES_PER_MESSAGE || item.data.length > MAX_TOOL_IMAGE_BASE64) {
      out.push({ type: 'text', text: IMAGE_NOT_KEPT_LIMIT });
      continue;
    }
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.length > MAX_TOOL_IMAGE_BYTES) {
      out.push({ type: 'text', text: IMAGE_NOT_KEPT_LIMIT });
      continue;
    }
    // What is stored, and later served as an image, has to be one.
    if (!hasToolImageSignature(bytes, mime)) {
      out.push({ type: 'text', text: IMAGE_NOT_KEPT });
      continue;
    }
    try {
      const attachmentId = await save(chatId, messageId, bytes, mime);
      budget.kept += 1;
      out.push({ type: 'image', attachmentId, mimeType: mime });
    } catch (err) {
      console.error(`[TurnRunner] couldn't keep a tool image for message ${messageId}:`, err);
      out.push({ type: 'text', text: IMAGE_NOT_KEPT });
    }
  }
  if (forged) console.warn(`[TurnRunner] a "${toolName ?? 'tool'}" result carried a reference to a stored image; removed.`);
  return out;
}

/**
 * The parts of ONE message (`messageId`, in `chatId`) with every image item
 * checked against the attachment rows. A reference stays only while its row
 * exists, belongs to this chat and this very message, and is an allowlisted
 * raster type; its mime is then the row's, never the part's. Any other image
 * item (a reference that fails, an inline image, anything image-shaped) is
 * replaced by a text note. `missing` says what a reference whose row isn't
 * here (yet) becomes: `'drop'` a note, `'keep'` itself (a synced message can
 * arrive before its attachment; the same check runs again at every read).
 * Returns `parts` itself when nothing changed.
 */
export function bindToolImageParts(parts: Part[], chatId: string, messageId: string, lookup: ToolImageLookup, missing: 'keep' | 'drop'): Part[] {
  let changed = false;
  const next = parts.map((part): Part => {
    if (part.type !== 'tool-result' || !Array.isArray(part.result) || !part.result.some(isImageItem)) return part;
    const result = part.result.map((item): unknown => {
      if (!isImageItem(item)) return item;
      if (!isToolImageRef(item)) return { type: 'text', text: IMAGE_NOT_KEPT };
      let row: ToolImageRow | null = null;
      try {
        row = lookup(item.attachmentId);
      } catch {
        row = null;
      }
      if (row === null) {
        return missing === 'keep' ? { type: 'image', attachmentId: item.attachmentId, mimeType: baseMime(item.mimeType) } : { type: 'text', text: TOOL_IMAGE_NOT_BOUND };
      }
      if (!toolImageBound(row, chatId, messageId)) return { type: 'text', text: TOOL_IMAGE_NOT_BOUND };
      return { type: 'image', attachmentId: item.attachmentId, mimeType: baseMime(row.mime) };
    });
    changed = true;
    return { ...part, result };
  });
  return changed ? next : parts;
}

/**
 * A request's history with every tool image bound to `chatId` (see
 * `bindToolImageParts`, missing rows dropped): what the model, and any engine,
 * is ever handed to replay. A message with no image item is returned as it is.
 */
export function bindToolImages(messages: CanonMessage[], chatId: string, lookup: ToolImageLookup): CanonMessage[] {
  return messages.map((message) => {
    const parts = bindToolImageParts(message.parts, chatId, message.id, lookup, 'drop');
    return parts === message.parts ? message : { ...message, parts };
  });
}
