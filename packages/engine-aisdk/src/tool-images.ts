import type { JSONValue, ToolResultPart } from 'ai';
import { isInlineToolImage, isToolImageRef, MAX_TOOL_IMAGE_BYTES, sniffToolImageMime } from '@grunt/core/domain/tool-images.js';
import type { ToolImageLoader } from '@grunt/core/ports/chat-engine.js';
import type { ConnectionKind } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';

/**
 * Images in tool results, on the way to a model (spec
 * 2026-10-12-computer-use-design sections 5-6). Live, inside one turn, a
 * tool's output still carries base64 (`liveToolOutput`); replayed from
 * history it carries attachment references. A reference is only ever turned
 * back into bytes through a `ToolImageLoader` that checks it was stored for
 * THIS chat and the message that holds it (never by a raw read of an id that
 * came from history), and what is sent is bounded: the last
 * `REPLAYED_TOOL_IMAGES` distinct images, none over `REPLAYED_IMAGE_MAX_BYTES`
 * and no more than `REPLAYED_IMAGES_MAX_TOTAL_BYTES` together, oldest dropped
 * first. The type the model is told comes from the bytes (png, jpeg, gif or
 * webp), never from a label. This also stops MCP tools' images reaching the
 * model as base64 inside JSON.
 */

export const IMAGE_OMITTED_NOTE = "[image omitted: this model can't take images]";
export const EARLIER_SCREENSHOT_NOTE = '[earlier screenshot omitted]';
export const IMAGE_UNAVAILABLE_NOTE = '[image not available]';
export const IMAGE_NOT_YOURS_NOTE = "[image omitted: it doesn't belong to this chat]";
export const IMAGE_TOO_LARGE_NOTE = '[image omitted: too large to send]';
export const IMAGE_UNSUPPORTED_NOTE = '[image omitted: not a PNG, JPEG, GIF or WebP image]';
export const REPLAYED_TOOL_IMAGES = 3;
/** One replayed (or live) image: the same cap as storing one. */
export const REPLAYED_IMAGE_MAX_BYTES = MAX_TOOL_IMAGE_BYTES;
/** All images replayed in one request together. */
export const REPLAYED_IMAGES_MAX_TOTAL_BYTES = 2 * MAX_TOOL_IMAGE_BYTES;

/** The longest base64 text that can decode to `REPLAYED_IMAGE_MAX_BYTES`. */
const MAX_IMAGE_BASE64 = Math.ceil(REPLAYED_IMAGE_MAX_BYTES / 3) * 4;

type Output = ToolResultPart['output'];
type ContentItem = Extract<Output, { type: 'content' }>['value'][number];

function isTextItem(value: unknown): value is { type: 'text'; text: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'text' && typeof (value as { text?: unknown }).text === 'string';
}

/**
 * Whether a provider takes images inside tool results: only the families whose
 * AI SDK provider turns `image-data` in a tool result into an image
 * (Anthropic, OpenAI, Google). Anything else, `@ai-sdk/openai-compatible`
 * and Ollama included, gets a text note.
 */
export function toolImagesSupported(kind: ConnectionKind): boolean {
  return kind === 'anthropic' || kind === 'openai' || kind === 'google';
}

/** The raster type of a live tool image, from its own bytes, or null (too big, or not a supported image). */
function liveImageType(data: string): string | null {
  if (data.length > MAX_IMAGE_BASE64) return null;
  return sniffToolImageMime(Buffer.from(data.slice(0, 32), 'base64'));
}

/** A tool's live output as the model gets it; anything without an inline image goes as the SDK would send it. */
export function liveToolOutput(output: unknown, imagesOk: boolean): Output {
  if (Array.isArray(output) && output.some(isInlineToolImage)) {
    return {
      type: 'content',
      value: output.map((item): ContentItem => {
        if (isInlineToolImage(item)) {
          if (!imagesOk) return { type: 'text', text: IMAGE_OMITTED_NOTE };
          if (item.data.length > MAX_IMAGE_BASE64) return { type: 'text', text: IMAGE_TOO_LARGE_NOTE };
          const mediaType = liveImageType(item.data);
          return mediaType ? { type: 'image-data', data: item.data, mediaType } : { type: 'text', text: IMAGE_UNSUPPORTED_NOTE };
        }
        if (isTextItem(item)) return { type: 'text', text: item.text };
        return { type: 'text', text: JSON.stringify(item) };
      }),
    };
  }
  return typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: (output ?? null) as JSONValue };
}

/** A stored tool image the history names, and where. */
export interface ReplayCandidate {
  attachmentId: string;
  messageId: string;
  /** The chat of the message that holds it. */
  chatId: string;
}

/** What the model is given for a candidate: the image, or the reason it isn't. */
export type ReplayImage = { type: 'image'; data: string; mediaType: string } | { type: 'note'; text: string };

/** Where stored tool images come from: always scoped to a chat. */
export interface ToolImageSource {
  chatId: string;
  load: ToolImageLoader;
}

/** The key a candidate is known by: an image is placed at one spot, not wherever its id repeats. */
function placeKey(messageId: string, attachmentId: string): string {
  return `${messageId}\u0000${attachmentId}`;
}

/**
 * The stored images that may be replayed: the last `keep` DISTINCT attachment
 * ids among the tool results that will actually be sent (a call seen earlier,
 * not an error, tools on), oldest first. An id that appears more than once is
 * one image, placed where it appears last.
 */
export function replayCandidates(messages: CanonMessage[], toolsOn: boolean, keep = REPLAYED_TOOL_IMAGES): ReplayCandidate[] {
  if (!toolsOn) return [];
  const seenCalls = new Set<string>();
  const byId = new Map<string, ReplayCandidate>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool-call') seenCalls.add(part.id);
      if (part.type !== 'tool-result' || part.isError || !seenCalls.has(part.id) || !Array.isArray(part.result)) continue;
      for (const item of part.result) {
        if (!isToolImageRef(item)) continue;
        byId.delete(item.attachmentId); // moves it to the end: the newest place wins
        byId.set(item.attachmentId, { attachmentId: item.attachmentId, messageId: message.id, chatId: message.chatId });
      }
    }
  }
  return [...byId.values()].slice(-keep);
}

/** The attachment ids of the last `keep` distinct image references in tool results. */
export function replayedImageIds(messages: CanonMessage[], keep = REPLAYED_TOOL_IMAGES): Set<string> {
  return new Set(replayCandidates(messages, true, keep).map((c) => c.attachmentId));
}

/**
 * Loads the candidates, newest first, through `source`. Nothing is read for a
 * message of another chat, and the loader itself answers null for anything not
 * stored for this chat and that message. An image is kept only if its own
 * bytes are a supported raster, it is within `maxEach`, and it fits in what is
 * left of `maxTotal`; the oldest are the ones left out. Base64 is only built
 * for an image that is kept.
 */
export async function loadReplayImages(
  candidates: ReplayCandidate[],
  source: ToolImageSource | undefined,
  maxEach = REPLAYED_IMAGE_MAX_BYTES,
  maxTotal = REPLAYED_IMAGES_MAX_TOTAL_BYTES
): Promise<Map<string, ReplayImage>> {
  const out = new Map<string, ReplayImage>();
  let total = 0;
  for (const cand of [...candidates].reverse()) {
    const key = placeKey(cand.messageId, cand.attachmentId);
    const note = (text: string): void => {
      out.set(key, { type: 'note', text });
    };
    if (!source) {
      note(IMAGE_UNAVAILABLE_NOTE);
      continue;
    }
    if (cand.chatId !== source.chatId) {
      note(IMAGE_NOT_YOURS_NOTE);
      continue;
    }
    let bytes: Buffer | null;
    try {
      bytes = await source.load({ chatId: source.chatId, messageId: cand.messageId, attachmentId: cand.attachmentId });
    } catch {
      note(IMAGE_UNAVAILABLE_NOTE);
      continue;
    }
    if (bytes === null) note(IMAGE_NOT_YOURS_NOTE);
    else if (bytes.length > maxEach || total + bytes.length > maxTotal) note(IMAGE_TOO_LARGE_NOTE);
    else {
      const mediaType = sniffToolImageMime(bytes);
      if (!mediaType) note(IMAGE_UNSUPPORTED_NOTE);
      else {
        total += bytes.length;
        out.set(key, { type: 'image', data: bytes.toString('base64'), mediaType });
      }
    }
  }
  return out;
}

/**
 * A stored tool result as the model gets it on a later turn. `replay` holds
 * the images chosen for this request; each is used once, at the place it was
 * chosen for (`messageId`), and any other mention of a reference is the
 * earlier-screenshot note.
 */
export function replayToolOutput(result: unknown, isError: boolean, messageId: string, replay: Map<string, ReplayImage>, imagesOk: boolean): Output {
  if (!isError && Array.isArray(result) && result.some(isToolImageRef)) {
    const value: ContentItem[] = [];
    for (const item of result) {
      if (isToolImageRef(item)) {
        const key = placeKey(messageId, item.attachmentId);
        const chosen = imagesOk ? replay.get(key) : undefined;
        replay.delete(key);
        if (!imagesOk) value.push({ type: 'text', text: IMAGE_OMITTED_NOTE });
        else if (!chosen) value.push({ type: 'text', text: EARLIER_SCREENSHOT_NOTE });
        else if (chosen.type === 'note') value.push({ type: 'text', text: chosen.text });
        else value.push({ type: 'image-data', data: chosen.data, mediaType: chosen.mediaType });
      } else if (isTextItem(item)) value.push({ type: 'text', text: item.text });
      else value.push({ type: 'text', text: JSON.stringify(item) });
    }
    return { type: 'content', value };
  }
  const value = (result ?? null) as JSONValue;
  return isError ? { type: 'error-json', value } : { type: 'json', value };
}
