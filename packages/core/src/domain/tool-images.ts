import { isAttachmentId } from './attachment-binding.js';
import type { CanonMessage, Part, PendingMark } from '../types/messages.js';

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
 *
 * Video (mp4, webm) travels the same way, as `{ type: 'video', ... }` items,
 * with the same guarantees and its own limits: at most
 * `MAX_TOOL_VIDEOS_PER_MESSAGE` per reply, each within
 * `MAX_TOOL_VIDEO_BYTES`, counted apart from images so a clip never uses up
 * the image budget. A model is never shown a video (the engine puts a text
 * note in its place); the person sees it through the scoped route. Screening a
 * video reads only its first bytes: the base64 text is not decoded until it is
 * stored.
 */

export const TOOL_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_TOOL_IMAGES_PER_MESSAGE = 50;
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_NOT_KEPT = '[image not kept]';
export const IMAGE_NOT_KEPT_LIMIT = '[image not kept: too many or too large]';
export const TOOL_IMAGE_REF_REMOVED = "[image reference removed: tools can't refer to stored images]";
export const TOOL_IMAGE_NOT_BOUND = '[image omitted: it is not stored with this chat]';

export const TOOL_VIDEO_MIMES: readonly string[] = ['video/mp4', 'video/webm'];
export const MAX_TOOL_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_TOOL_VIDEOS_PER_MESSAGE = 4;
export const VIDEO_NOT_KEPT = '[video not kept]';
export const VIDEO_NOT_KEPT_LIMIT = '[video not kept: too many or too large]';
export const TOOL_VIDEO_REF_REMOVED = "[video reference removed: tools can't refer to stored videos]";
export const TOOL_VIDEO_NOT_BOUND = '[video omitted: it is not stored with this chat]';

/** The longest base64 text that can still decode to `MAX_TOOL_VIDEO_BYTES` (padding included). */
const MAX_TOOL_VIDEO_BASE64 = Math.ceil(MAX_TOOL_VIDEO_BYTES / 3) * 4;

/** The longest base64 text that can still decode to `MAX_TOOL_IMAGE_BYTES` (padding included). */
const MAX_TOOL_IMAGE_BASE64 = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4;

/** Stores one image for a reply and returns the attachment id (server/src/tool-images.ts). */
export type SaveToolImage = (chatId: string, messageId: string, bytes: Buffer, mime: string) => Promise<string>;

export interface InlineToolImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolImageRef extends PendingMark {
  type: 'image';
  attachmentId: string;
  mimeType: string;
}

export interface InlineToolVideo {
  type: 'video';
  data: string;
  mimeType: string;
}

export interface ToolVideoRef extends PendingMark {
  type: 'video';
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

export function isInlineToolVideo(value: unknown): value is InlineToolVideo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['type'] === 'video' && typeof v['data'] === 'string' && typeof v['mimeType'] === 'string';
}

export function isToolVideoRef(value: unknown): value is ToolVideoRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['type'] === 'video' && typeof v['attachmentId'] === 'string' && typeof v['mimeType'] === 'string';
}

/** An item that claims to be a video, whatever else it carries. */
function isVideoItem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'video';
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
 * The video type `data` really is (mp4: an `ftyp` box at offset 4; webm: the
 * EBML magic with a `webm` DocType in the first 64 bytes), or null. Only the
 * leading bytes are read.
 */
export function sniffToolVideoMime(data: Buffer): 'video/mp4' | 'video/webm' | null {
  if (data.length >= 12 && data.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (data.length >= 8 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3 && data.subarray(0, 64).includes('webm', 4, 'latin1')) return 'video/webm';
  return null;
}

/** The image or video type of the bytes themselves, or null: the one allowlist the scoped route serves from. */
export function sniffToolMediaMime(data: Buffer): string | null {
  return sniffToolImageMime(data) ?? sniffToolVideoMime(data);
}

/**
 * Whether an attachment row is a tool image stored for exactly this chat and
 * this message: the one test a reference has to pass, wherever it is read.
 * The row's size is held to the same cap as a stored image.
 */
/** Whether `mime` (as a row or a reference states it) is one of the raster types a tool image may have. */
export function isToolImageMime(mime: unknown): boolean {
  return typeof mime === 'string' && TOOL_IMAGE_MIMES.includes(baseMime(mime));
}

export function toolImageBound(row: { chatId: unknown; messageId: unknown; mime: unknown; size?: unknown }, chatId: string, messageId: string): boolean {
  return rowBound(row, chatId, messageId, TOOL_IMAGE_MIMES, MAX_TOOL_IMAGE_BYTES);
}

/** The same test for a stored tool video: an allowlisted video type and a size within `MAX_TOOL_VIDEO_BYTES`. */
export function toolVideoBound(row: { chatId: unknown; messageId: unknown; mime: unknown; size?: unknown }, chatId: string, messageId: string): boolean {
  return rowBound(row, chatId, messageId, TOOL_VIDEO_MIMES, MAX_TOOL_VIDEO_BYTES);
}

/** Whether `mime` (as a row or a reference states it) is one of the video types a tool video may have. */
export function isToolVideoMime(mime: unknown): boolean {
  return typeof mime === 'string' && TOOL_VIDEO_MIMES.includes(baseMime(mime));
}

function rowBound(row: { chatId: unknown; messageId: unknown; mime: unknown; size?: unknown }, chatId: string, messageId: string, mimes: readonly string[], maxBytes: number): boolean {
  return (
    typeof row.chatId === 'string' &&
    row.chatId !== '' &&
    row.chatId === chatId &&
    typeof row.messageId === 'string' &&
    row.messageId !== '' &&
    row.messageId === messageId &&
    typeof row.mime === 'string' &&
    mimes.includes(baseMime(row.mime)) &&
    (row.size === undefined || (typeof row.size === 'number' && Number.isFinite(row.size) && row.size >= 0 && row.size <= maxBytes))
  );
}

/**
 * Whether a row from another machine has the shape of a file OtherBench itself
 * makes: an id as the saver and the upload route make it, a name of sane
 * length with no control characters, a mime that is a plain type string, a
 * size that is a whole number from 0 to `maxBytes`. (The caller adds the rules
 * for what the file is used as, e.g. a tool image is a raster of at most
 * `MAX_TOOL_IMAGE_BYTES`.) Anything else, null and a wrong type included, is no.
 */
export function attachmentRowShapeOk(row: { id: unknown; filename: unknown; mime: unknown; size: unknown }, maxBytes: number): boolean {
  return (
    isAttachmentId(row.id) &&
    typeof row.filename === 'string' &&
    row.filename.length > 0 &&
    row.filename.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(row.filename) &&
    typeof row.mime === 'string' &&
    row.mime.length > 0 &&
    row.mime.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(row.mime) &&
    typeof row.size === 'number' &&
    Number.isInteger(row.size) &&
    row.size >= 0 &&
    row.size <= maxBytes
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

/** What one inline video comes to: its size and type read from the bytes, or the note that stands in for it. */
export type ValidatedToolVideo = { ok: true; mime: 'video/mp4' | 'video/webm'; size: number } | { ok: false; note: string };

/**
 * The test an inline video from a tool has to pass, for what is stored and for
 * what is let through alike. The base64 text is checked for length and strict
 * form first, its size follows from its length, and the type comes from the
 * first bytes alone (a prefix is decoded, never the whole clip), never from
 * the tool's label. `item.data` itself is what goes on.
 */
export function validateToolVideo(item: InlineToolVideo): ValidatedToolVideo {
  const text = item.data;
  if (text.length > MAX_TOOL_VIDEO_BASE64) return { ok: false, note: VIDEO_NOT_KEPT_LIMIT };
  if (text.length === 0 || text.length % 4 !== 0 || !STRICT_BASE64.test(text)) return { ok: false, note: VIDEO_NOT_KEPT };
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const size = (text.length / 4) * 3 - padding;
  if (size > MAX_TOOL_VIDEO_BYTES) return { ok: false, note: VIDEO_NOT_KEPT_LIMIT };
  // 96 base64 characters are 72 bytes: enough for both signatures.
  const mime = sniffToolVideoMime(Buffer.from(text.length > 96 ? text.slice(0, 96) : text, 'base64'));
  if (mime === null) return { ok: false, note: VIDEO_NOT_KEPT };
  return { ok: true, mime, size };
}

/** How many images and bytes a stream of tool results has used so far; `videos` counts the videos, apart from them. */
export interface ToolImageBudget {
  images: number;
  bytes: number;
  videos?: number;
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
 * `TOOL_IMAGE_REF_REMOVED`; video items are screened the same way against
 * their own count and size (`validateToolVideo`, `TOOL_VIDEO_REF_REMOVED`);
 * audio and resource blobs become a short note with
 * their size. `budget` is advanced for every image let through. A result with
 * none of these comes back as the same object.
 */
export function screenToolResult(result: unknown, budget: ToolImageBudget, limits: ToolImageLimits): { result: unknown; forged: boolean } {
  if (!Array.isArray(result)) return { result, forged: false };
  let changed = false;
  let forged = false;
  const out = result.map((item): unknown => {
    if (isVideoItem(item)) {
      changed = true;
      if (!isInlineToolVideo(item)) {
        forged = true;
        return { type: 'text', text: TOOL_VIDEO_REF_REMOVED };
      }
      // Videos have a count and a size of their own; the image budget is not touched.
      if ((budget.videos ?? 0) >= MAX_TOOL_VIDEOS_PER_MESSAGE) return { type: 'text', text: VIDEO_NOT_KEPT_LIMIT };
      const checked = validateToolVideo(item);
      if (!checked.ok) return { type: 'text', text: checked.note };
      budget.videos = (budget.videos ?? 0) + 1;
      return { type: 'video', data: item.data, mimeType: checked.mime };
    }
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
 * What differs between the two kinds of stored media, so the checks that keep
 * and bind them are one body of code, not two copies that could drift.
 */
interface MediaKind {
  type: 'image' | 'video';
  isRef: (value: unknown) => boolean;
  mimes: readonly string[];
  bound: (row: ToolImageRow, chatId: string, messageId: string) => boolean;
  notKept: string;
  limitNote: string;
  notBound: string;
  max: number;
  /** Gives back the place an inline item took in a budget, when it turns out not to be kept. */
  release: (budget: ToolImageBudget) => void;
}

const IMAGE_KIND: MediaKind = {
  type: 'image',
  isRef: isToolImageRef,
  mimes: TOOL_IMAGE_MIMES,
  bound: toolImageBound,
  notKept: IMAGE_NOT_KEPT,
  limitNote: IMAGE_NOT_KEPT_LIMIT,
  notBound: TOOL_IMAGE_NOT_BOUND,
  max: MAX_TOOL_IMAGES_PER_MESSAGE,
  release: (b) => {
    b.images -= 1;
  },
};

const VIDEO_KIND: MediaKind = {
  type: 'video',
  isRef: isToolVideoRef,
  mimes: TOOL_VIDEO_MIMES,
  bound: toolVideoBound,
  notKept: VIDEO_NOT_KEPT,
  limitNote: VIDEO_NOT_KEPT_LIMIT,
  notBound: TOOL_VIDEO_NOT_BOUND,
  max: MAX_TOOL_VIDEOS_PER_MESSAGE,
  release: (b) => {
    b.videos = (b.videos ?? 1) - 1;
  },
};

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
  budget: { kept: number; keptVideos?: number },
  toolName?: string
): Promise<unknown> {
  const used: ToolImageBudget = { images: budget.kept, bytes: 0, videos: budget.keptVideos ?? 0 };
  const screened = screenToolResult(result, used, STORED_IMAGE_LIMITS);
  if (screened.forged) console.warn(`[TurnRunner] a "${toolName ?? 'tool'}" result carried a reference to a stored image or video; removed.`);
  if (!Array.isArray(screened.result) || !screened.result.some((i) => isInlineToolImage(i) || isInlineToolVideo(i))) {
    budget.kept = used.images;
    budget.keptVideos = used.videos ?? 0;
    return screened.result;
  }
  const out: unknown[] = [];
  for (const item of screened.result) {
    const kind = isInlineToolVideo(item) ? VIDEO_KIND : isInlineToolImage(item) ? IMAGE_KIND : null;
    if (kind === null) {
      out.push(item);
      continue;
    }
    const inline = item as InlineToolImage | InlineToolVideo;
    if (!save) {
      kind.release(used);
      out.push({ type: 'text', text: kind.notKept });
      continue;
    }
    try {
      const attachmentId = await save(chatId, messageId, Buffer.from(inline.data, 'base64'), inline.mimeType);
      out.push({ type: kind.type, attachmentId, mimeType: inline.mimeType });
    } catch (err) {
      kind.release(used);
      console.error(`[TurnRunner] couldn't keep a tool ${kind.type} for message ${messageId}:`, err);
      out.push({ type: 'text', text: kind.notKept });
    }
  }
  budget.kept = used.images;
  budget.keptVideos = used.videos ?? 0;
  return out;
}

/**
 * The parts of ONE message (`messageId`, in `chatId`) with every item that can
 * carry an image or bulk data made safe.
 *
 * A tool image reference stays only if it is exactly what `TurnRunner` mints
 * (type, an attachment id of the shape OtherBench makes, an allowlisted raster
 * type; nothing else is kept from the item) AND its attachment row is here AND
 * is bound to this chat and this very message (`toolImageBound`); its mime is
 * then the row's, never the part's. At most `MAX_TOOL_IMAGES_PER_MESSAGE` stay
 * in one message; the surplus is `[image not kept: too many or too large]`.
 * Any other image item (a reference that fails, an inline image, anything
 * image-shaped) and any audio or resource blob is a text note, so no base64
 * survives in a stored message.
 *
 * `missing` says what a well-formed reference whose row isn't here (yet)
 * becomes. `'drop'`: a note. `'hold'`: the reference stays with `pending: true`,
 * an explicit "not verified" that no read path treats as an image (every read
 * runs this again with `'drop'`, and a reference whose row isn't bound is a
 * note then). Nothing ever passes because a row is missing or a field is null.
 * Returns `parts` itself when nothing changed.
 */
export function bindToolImageParts(parts: Part[], chatId: string, messageId: string, lookup: ToolImageLookup, missing: 'hold' | 'drop'): Part[] {
  let changed = false;
  const kept = { image: 0, video: 0 };
  const note = (text: string): { type: 'text'; text: string } => ({ type: 'text', text });
  const next = parts.map((part): Part => {
    if (part.type !== 'tool-result' || !Array.isArray(part.result)) return part;
    const result = part.result.map((item): unknown => {
      const binary = binaryItemNote(item);
      if (binary !== null) return note(binary);
      const kind = isVideoItem(item) ? VIDEO_KIND : isImageItem(item) ? IMAGE_KIND : null;
      if (kind === null) return item;
      if (!kind.isRef(item)) return note(kind.notKept);
      const ref = item as unknown as Record<string, unknown>;
      if (!isAttachmentId(ref['attachmentId'])) return note(kind.notKept);
      const claimed = baseMime(String(ref['mimeType']));
      if (!kind.mimes.includes(claimed)) return note(kind.notKept);
      if (kept[kind.type] >= kind.max) return note(kind.limitNote);
      let row: ToolImageRow | null = null;
      try {
        row = lookup(ref['attachmentId']);
      } catch {
        row = null;
      }
      if (row === null || row === undefined) {
        if (missing === 'drop') return note(kind.notBound);
        kept[kind.type] += 1;
        return { type: kind.type, attachmentId: ref['attachmentId'], mimeType: claimed, pending: true };
      }
      if (!kind.bound(row, chatId, messageId)) return note(kind.notBound);
      kept[kind.type] += 1;
      return { type: kind.type, attachmentId: ref['attachmentId'], mimeType: baseMime(row.mime) };
    });
    if (result.some((r, i) => r !== (part.result as unknown[])[i])) changed = true;
    return changed ? { ...part, result } : part;
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
