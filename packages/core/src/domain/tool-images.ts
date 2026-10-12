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

/** What one inline image comes to: the bytes and the canonical form of them, or the note that stands in for it. */
export type ValidatedToolImage = { ok: true; bytes: Buffer; mime: string; data: string } | { ok: false; note: string };

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The ONE test an inline image from a tool has to pass, used both for what is
 * stored and for what the model is shown, so the two can't disagree. The size
 * is checked on the base64 text before anything is decoded; the text must be
 * strict base64; the type comes from the bytes (png, jpeg, gif or webp), never
 * from the tool's label; and `data` is the canonical base64 of those bytes,
 * which is what goes on. A failure is the note that replaces the image.
 */
export function validateToolImage(item: InlineToolImage): ValidatedToolImage {
  const text = item.data;
  if (text.length > MAX_TOOL_IMAGE_BASE64) return { ok: false, note: IMAGE_NOT_KEPT_LIMIT };
  if (text.length === 0 || text.length % 4 !== 0 || !STRICT_BASE64.test(text)) return { ok: false, note: IMAGE_NOT_KEPT };
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) return { ok: false, note: IMAGE_NOT_KEPT_LIMIT };
  const mime = sniffToolImageMime(bytes);
  if (mime === null) return { ok: false, note: IMAGE_NOT_KEPT };
  return { ok: true, bytes, mime, data: bytes.toString('base64') };
}

/** How many images and bytes a stream of tool results has used so far. */
export interface ToolImageBudget {
  images: number;
  bytes: number;
}

export interface ToolImageLimits {
  maxImages: number;
  maxBytes: number;
}

/** What is stored: up to 50 images per reply, each within 5 MB. */
export const STORED_IMAGE_LIMITS: ToolImageLimits = { maxImages: MAX_TOOL_IMAGES_PER_MESSAGE, maxBytes: Number.POSITIVE_INFINITY };
/** What one reply may show a model live: the same count, and 20 MB together (every later step sends them again). */
export const LIVE_IMAGE_LIMITS: ToolImageLimits = { maxImages: MAX_TOOL_IMAGES_PER_MESSAGE, maxBytes: 4 * MAX_TOOL_IMAGE_BYTES };

function sizeText(base64Length: number): string {
  const bytes = Math.floor((base64Length * 3) / 4);
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** An MCP item that carries binary data as base64 and is not an image: audio, or a resource with a blob. */
function binaryItemNote(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const v = item as Record<string, unknown>;
  if (v['type'] === 'audio' && typeof v['data'] === 'string') return `[audio omitted: ${sizeText(v['data'].length)}]`;
  if (v['type'] === 'resource' && typeof v['resource'] === 'object' && v['resource'] !== null) {
    const blob = (v['resource'] as Record<string, unknown>)['blob'];
    if (typeof blob === 'string') return `[resource omitted: ${sizeText(blob.length)} of binary data]`;
  }
  return null;
}

/**
 * A tool result with everything that can carry bulk base64 made safe, the same
 * way wherever it is used (the engine before the model sees it, the runner
 * before it is stored): each inline image is validated (`validateToolImage`)
 * and rewritten in canonical form, or replaced by its note; one past the
 * budget is `[image not kept: too many or too large]`; an image item that is
 * not inline (a reference to a stored image) is a forgery and becomes
 * `TOOL_IMAGE_REF_REMOVED`; audio and resource blobs become a short note with
 * their size. `budget` is advanced for every image let through. A result with
 * none of these comes back as the same object.
 */
export function screenToolResult(result: unknown, budget: ToolImageBudget, limits: ToolImageLimits): { result: unknown; forged: boolean } {
  if (!Array.isArray(result)) return { result, forged: false };
  let changed = false;
  let forged = false;
  const out = result.map((item): unknown => {
    if (isImageItem(item)) {
      changed = true;
      if (!isInlineToolImage(item)) {
        forged = true;
        return { type: 'text', text: TOOL_IMAGE_REF_REMOVED };
      }
      // Past the budget (by count, or by the least the text can decode to) an image is never decoded.
      const leastBytes = Math.max(0, Math.floor(item.data.length / 4) * 3 - 2);
      if (budget.images >= limits.maxImages || budget.bytes + leastBytes > limits.maxBytes) return { type: 'text', text: IMAGE_NOT_KEPT_LIMIT };
      const checked = validateToolImage(item);
      if (!checked.ok) return { type: 'text', text: checked.note };
      if (budget.bytes + checked.bytes.length > limits.maxBytes) return { type: 'text', text: IMAGE_NOT_KEPT_LIMIT };
      budget.images += 1;
      budget.bytes += checked.bytes.length;
      return { type: 'image', data: checked.data, mimeType: checked.mime };
    }
    const note = binaryItemNote(item);
    if (note !== null) {
      changed = true;
      return { type: 'text', text: note };
    }
    return item;
  });
  return { result: changed ? out : result, forged };
}

/**
 * `result` screened (see `screenToolResult`, stored limits) with every image
 * that is let through stored through `save` and replaced by a reference. A
 * result with nothing to screen comes back as the same object. An image that
 * has nowhere to go, or fails to store, becomes `[image not kept]`. `budget`
 * counts the images kept across the reply. `toolName` is all that is logged
 * about a forged reference.
 */
export async function keepToolImages(
  result: unknown,
  save: SaveToolImage | undefined,
  chatId: string,
  messageId: string,
  budget: { kept: number },
  toolName?: string
): Promise<unknown> {
  const used: ToolImageBudget = { images: budget.kept, bytes: 0 };
  const screened = screenToolResult(result, used, STORED_IMAGE_LIMITS);
  if (screened.forged) console.warn(`[TurnRunner] a "${toolName ?? 'tool'}" result carried a reference to a stored image; removed.`);
  if (!Array.isArray(screened.result) || !screened.result.some(isInlineToolImage)) {
    budget.kept = used.images;
    return screened.result;
  }
  const out: unknown[] = [];
  for (const item of screened.result) {
    if (!isInlineToolImage(item)) {
      out.push(item);
      continue;
    }
    if (!save) {
      used.images -= 1;
      out.push({ type: 'text', text: IMAGE_NOT_KEPT });
      continue;
    }
    try {
      const attachmentId = await save(chatId, messageId, Buffer.from(item.data, 'base64'), item.mimeType);
      out.push({ type: 'image', attachmentId, mimeType: item.mimeType });
    } catch (err) {
      used.images -= 1;
      console.error(`[TurnRunner] couldn't keep a tool image for message ${messageId}:`, err);
      out.push({ type: 'text', text: IMAGE_NOT_KEPT });
    }
  }
  budget.kept = used.images;
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
