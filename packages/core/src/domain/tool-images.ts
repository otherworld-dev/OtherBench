/**
 * Images in tool results (spec 2026-10-12-computer-use-design section 6). A
 * tool may answer with MCP-style content items, `{ type: 'image', data,
 * mimeType }` among them (a computer screenshot, an MCP server's image).
 * Before such a result is broadcast or stored, each image goes to the blob
 * store and is replaced by a reference, so base64 never reaches an SSE client
 * or a message row. The web app imports the type guards, so nothing here may
 * use a Node API at module load.
 */

export const TOOL_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_TOOL_IMAGES_PER_MESSAGE = 50;
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_NOT_KEPT = '[image not kept]';
export const IMAGE_NOT_KEPT_LIMIT = '[image not kept: too many or too large]';

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

/**
 * `result` with every inline image stored through `save` and replaced by a
 * reference. A result with no inline image comes back as the same object.
 * An image of another type, or with nowhere to store it, or that fails to
 * store, becomes `[image not kept]`; past `MAX_TOOL_IMAGES_PER_MESSAGE` for
 * the message (`budget` counts them across the reply) or over
 * `MAX_TOOL_IMAGE_BYTES`, `[image not kept: too many or too large]`.
 */
export async function keepToolImages(
  result: unknown,
  save: SaveToolImage | undefined,
  chatId: string,
  messageId: string,
  budget: { kept: number }
): Promise<unknown> {
  if (!Array.isArray(result) || !result.some(isInlineToolImage)) return result;
  const out: unknown[] = [];
  for (const item of result) {
    if (!isInlineToolImage(item)) {
      out.push(item);
      continue;
    }
    const mime = item.mimeType.toLowerCase().split(';')[0]!.trim();
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
    try {
      const attachmentId = await save(chatId, messageId, bytes, mime);
      budget.kept += 1;
      out.push({ type: 'image', attachmentId, mimeType: mime });
    } catch (err) {
      console.error(`[TurnRunner] couldn't keep a tool image for message ${messageId}:`, err);
      out.push({ type: 'text', text: IMAGE_NOT_KEPT });
    }
  }
  return out;
}
