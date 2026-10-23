import type { JSONValue, ToolResultPart } from 'ai';
import { isInlineToolImage, isToolImageRef, MAX_TOOL_IMAGE_BYTES, sniffToolImageMime, validateToolImage, type InlineToolImage, type ValidatedToolImage } from '@otherbench/core/domain/tool-images.js';
import type { ToolImageLoader, ToolImageSizer } from '@otherbench/core/ports/chat-engine.js';
import { IMAGE_UNSUPPORTED_NOTE, selectWithinBudget, withinAfterLoad } from '@otherbench/core/domain/request-budget.js';
import type { ConnectionKind } from '@otherbench/core/types/config.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';

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
 *
 * A video (inline or stored) is never sent to a model, on any provider: it is
 * `VIDEO_FOR_USER_NOTE` in its place, live and replayed, and a stored video
 * reference is neither a replay candidate nor ever shown as an attachment id.
 */

export const IMAGE_OMITTED_NOTE = "[image omitted: this model can't take images]";
export const EARLIER_SCREENSHOT_NOTE = '[earlier screenshot omitted]';
export const IMAGE_UNAVAILABLE_NOTE = '[image not available]';
export const IMAGE_NOT_YOURS_NOTE = "[image omitted: it doesn't belong to this chat]";
export const IMAGE_TOO_LARGE_NOTE = '[image omitted: too large to send]';
export const IMAGE_NOT_SHOWN_NOTE = '[image omitted]';
/** What a model gets in place of a video a tool made: the person sees it, a model never receives one. */
export const VIDEO_FOR_USER_NOTE = "[video shown to the user; you can't watch it]";
/** Core's wording, shared with the Claude Code engine; exported from here as before. */
export { IMAGE_UNSUPPORTED_NOTE };
export const REPLAYED_TOOL_IMAGES = 3;
/** One replayed (or live) image: the same cap as storing one. */
export const REPLAYED_IMAGE_MAX_BYTES = MAX_TOOL_IMAGE_BYTES;
/** All images replayed in one request together. */
export const REPLAYED_IMAGES_MAX_TOTAL_BYTES = 2 * MAX_TOOL_IMAGE_BYTES;

type Output = ToolResultPart['output'];
type ContentItem = Extract<Output, { type: 'content' }>['value'][number];

function isVideoItem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'video';
}

function isTextItem(value: unknown): value is { type: 'text'; text: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'text' && typeof (value as { text?: unknown }).text === 'string';
}

/**
 * Whether an image a tool returned is sent to this model as an image: only
 * when the AI SDK's provider puts it INSIDE the tool result. A tool's image is
 * content from outside (a screenshot shows whatever a page or a document put
 * on the screen), so it may never go out as a block of the user's turn, where
 * it would read as something the person showed the model. Anything else gets
 * a text note inside the tool result, and the image stays for the transcript.
 *
 *   - Anthropic: an `image` block inside the `tool_result`.
 *   - OpenAI (the Responses API, which is what the registry's provider
 *     uses): an `input_image` inside the `function_call_output`.
 *   - Google: inside the `functionResponse` (its `parts`) only for the models
 *     the SDK treats as Gemini 3 or later. For every earlier one (2.5, 2.0,
 *     1.5, `gemini-pro`) and anything that is not a Gemini model, the SDK
 *     writes the image as a part of its own in the user's turn, next to the
 *     function response, so those get the note. The rule here is narrower
 *     than the SDK's: the id has exactly ONE `gemini-` segment (at its start
 *     or after a `/`), and it is `gemini-<number>` with a number of 3 or
 *     more. The SDK treats an id as older when ANY of its segments names an
 *     older Gemini (`gemini-3-pro/gemini-1.5`), so an id with two segments
 *     gets the note, as does any model the two rules disagree about.
 *   - `@ai-sdk/openai-compatible` and Ollama: tool messages are text only.
 */
export function toolImagesSupported(kind: ConnectionKind, modelId: string): boolean {
  if (kind === 'anthropic' || kind === 'openai') return true;
  if (kind !== 'google' || typeof modelId !== 'string') return false;
  if ((modelId.match(/(?:^|\/)gemini-/gi) ?? []).length !== 1) return false;
  const generation = /(?:^|\/)gemini-(\d+)(?:[.-]|$)/i.exec(modelId)?.[1];
  return generation !== undefined && generation.length <= 3 && Number(generation) >= 3;
}

const validated = new WeakMap<object, ValidatedToolImage>();

/** `validateToolImage`, remembered per item: the SDK may ask for the same output on every later step. */
function checkLive(item: InlineToolImage): ValidatedToolImage {
  let v = validated.get(item);
  if (!v) {
    v = validateToolImage(item);
    validated.set(item, v);
  }
  return v;
}

/**
 * A result's items as the output a provider is handed. `content` only when an
 * image is actually sent: it is the one shape that carries one. A result left
 * with text alone (no image, or a note in place of each) is ONE `text`
 * output, its items joined by a line break in their order, so the line that
 * says whose words they are stays first. Sent as `content`, such a result
 * would be several function responses for one call on Google's models before
 * Gemini 3 (the SDK writes one per text item) and a JSON dump of the parts on
 * chat-completions providers; as `text` it is one response and one string
 * everywhere.
 */
function contentOrText(value: ContentItem[]): Output {
  if (value.some((item) => item.type !== 'text')) return { type: 'content', value };
  return { type: 'text', value: value.map((item) => (item.type === 'text' ? item.text : '')).join('\n') };
}

/**
 * A tool's live output as the model gets it. An inline image goes through the
 * same validator that decides what is stored (`validateToolImage`): the type
 * comes from its bytes and the base64 sent is the canonical form of them, and
 * what fails is the same note the stored copy gets. (The engine has already
 * screened the output against its budget, see `screenToolResult`; this is the
 * check at the point of use.) Anything without an inline image goes as the SDK
 * would send it.
 */
export function liveToolOutput(output: unknown, imagesOk: boolean): Output {
  if (Array.isArray(output) && output.some((i) => isInlineToolImage(i) || isVideoItem(i))) {
    return contentOrText(
      output.map((item): ContentItem => {
        if (isVideoItem(item)) return { type: 'text', text: VIDEO_FOR_USER_NOTE };
        if (isInlineToolImage(item)) {
          if (!imagesOk) return { type: 'text', text: IMAGE_OMITTED_NOTE };
          const checked = checkLive(item);
          return checked.ok ? { type: 'image-data', data: checked.data, mediaType: checked.mime } : { type: 'text', text: checked.note };
        }
        if (isTextItem(item)) return { type: 'text', text: item.text };
        return { type: 'text', text: JSON.stringify(item) };
      })
    );
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
  /** The size a row states for a reference (see `ToolImageSizer`); absent = not known, the real bytes are checked after loading. */
  size?: ToolImageSizer;
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
    // Only an assistant message's tool results are sent as tool results (the converter's own rule): a result in a user message takes no place.
    if (message.role !== 'assistant') continue;
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
 * Picks, then loads. The candidates, newest first, are first decided from their
 * REFERENCES AND THE SIZES THEIR ROWS STATE (`selectWithinBudget`): a candidate
 * of another chat, one the row says is not stored for this chat and message,
 * one over `maxEach` and one that would pass `maxTotal` are notes and are never
 * loaded. Only the survivors are read, each once, and what was really read is
 * checked again against the same caps (a row can state a smaller size than its
 * file has). An image is kept only if its own bytes are a supported raster;
 * base64 is only built for an image that is kept.
 */
export async function loadReplayImages(
  candidates: ReplayCandidate[],
  source: ToolImageSource | undefined,
  maxEach = REPLAYED_IMAGE_MAX_BYTES,
  maxTotal = REPLAYED_IMAGES_MAX_TOTAL_BYTES
): Promise<Map<string, ReplayImage>> {
  const out = new Map<string, ReplayImage>();
  const newestFirst = [...candidates].reverse();
  const note = (cand: ReplayCandidate, text: string): void => {
    out.set(placeKey(cand.messageId, cand.attachmentId), { type: 'note', text });
  };
  if (!source) {
    for (const cand of newestFirst) note(cand, IMAGE_UNAVAILABLE_NOTE);
    return out;
  }
  const eligible: ReplayCandidate[] = [];
  for (const cand of newestFirst) {
    if (cand.chatId !== source.chatId) note(cand, IMAGE_NOT_YOURS_NOTE);
    else eligible.push(cand);
  }
  const limits = { maxCount: Number.POSITIVE_INFINITY, maxEach, maxTotal };
  const verdicts = selectWithinBudget(
    eligible.map((cand) => ({ key: placeKey(cand.messageId, cand.attachmentId), size: source.size ? source.size({ chatId: source.chatId, messageId: cand.messageId, attachmentId: cand.attachmentId }) : undefined })),
    limits
  );
  const loaded = { bytes: 0 };
  for (const cand of eligible) {
    const key = placeKey(cand.messageId, cand.attachmentId);
    const verdict = verdicts.get(key);
    if (verdict === 'unknown') {
      note(cand, IMAGE_NOT_YOURS_NOTE);
      continue;
    }
    if (verdict !== 'load') {
      note(cand, IMAGE_TOO_LARGE_NOTE);
      continue;
    }
    let bytes: Buffer | null;
    try {
      bytes = await source.load({ chatId: source.chatId, messageId: cand.messageId, attachmentId: cand.attachmentId });
    } catch {
      note(cand, IMAGE_UNAVAILABLE_NOTE);
      continue;
    }
    if (bytes === null) note(cand, IMAGE_NOT_YOURS_NOTE);
    else if (!withinAfterLoad(bytes.length, loaded, limits)) note(cand, IMAGE_TOO_LARGE_NOTE);
    else {
      const mediaType = sniffToolImageMime(bytes);
      if (!mediaType) {
        loaded.bytes -= bytes.length;
        note(cand, IMAGE_UNSUPPORTED_NOTE);
      } else out.set(key, { type: 'image', data: bytes.toString('base64'), mediaType });
    }
  }
  return out;
}

/** The bytes of the images chosen in `loadReplayImages`'s result. */
export function replayedBytes(images: Map<string, ReplayImage>): number {
  let total = 0;
  for (const image of images.values()) if (image.type === 'image') total += Buffer.byteLength(image.data, 'base64');
  return total;
}

/**
 * A stored tool result as the model gets it on a later turn. `replay` holds
 * the images chosen for this request; each is used once, at the place it was
 * chosen for (`messageId`), and any other mention of a reference is the
 * earlier-screenshot note.
 */
export function replayToolOutput(result: unknown, isError: boolean, messageId: string, replay: Map<string, ReplayImage>, imagesOk: boolean): Output {
  if (!isError && Array.isArray(result) && result.some((i) => isToolImageRef(i) || isVideoItem(i))) {
    const value: ContentItem[] = [];
    for (const item of result) {
      if (isVideoItem(item)) value.push({ type: 'text', text: VIDEO_FOR_USER_NOTE });
      else if (isToolImageRef(item)) {
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
    return contentOrText(value);
  }
  // An error result goes as JSON, so a reference in it would put an attachment id in front of the model: it is a note instead.
  const plain = isError && Array.isArray(result) ? result.map((item) => (isVideoItem(item) ? { type: 'text', text: VIDEO_FOR_USER_NOTE } : isToolImageRef(item) || isInlineToolImage(item) ? { type: 'text', text: IMAGE_NOT_SHOWN_NOTE } : item)) : result;
  const value = (plain ?? null) as JSONValue;
  return isError ? { type: 'error-json', value } : { type: 'json', value };
}
