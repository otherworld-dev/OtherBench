import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { MAX_HISTORY_ATTACHMENT_BYTES } from '@otherbench/core/domain/attachment-binding.js';
import { sniffToolImageMime } from '@otherbench/core/domain/tool-images.js';
import {
  ATTACHMENT_BUDGET_NOTE,
  ATTACHMENT_TOO_LARGE_NOTE,
  ATTACHMENT_UNAVAILABLE_NOTE,
  MAX_REQUEST_ATTACHMENT_BYTES,
  MAX_REQUEST_ATTACHMENTS,
  omissionNote,
  selectWithinBudget,
  withinAfterLoad,
  type Verdict,
} from '@otherbench/core/domain/request-budget.js';
import { IMAGE_UNSUPPORTED_NOTE, loadReplayImages, replayCandidates, replayedBytes, replayToolOutput, type ReplayImage, type ToolImageSource } from './tool-images.js';

// The notes for an attachment left out are core's (one wording for every engine); they are exported from here as before.
export { ATTACHMENT_BUDGET_NOTE, ATTACHMENT_TOO_LARGE_NOTE, ATTACHMENT_UNAVAILABLE_NOTE, MAX_REQUEST_ATTACHMENT_BYTES, MAX_REQUEST_ATTACHMENTS };
export const ATTACHMENT_REPEAT_NOTE = '[attachment omitted: it appears again later in this conversation]';

/** How one occurrence of an attachment in the history is treated: loaded, or a note. */
type Placement = Verdict | 'repeat';

/**
 * What a part gets: the bytes, or the note that stands in for them. `cap` is
 * set when the note is for one of the two caps (too large, or the request is
 * full): those are the notes that name the file when its part carries a name.
 */
type Taken = { bytes: Buffer } | { note: string; cap?: 'too-large' | 'over-budget' };
type Take = (messageId: string, index: number, attachmentId: string) => Promise<Taken>;

function placeId(messageId: string, index: number): string {
  return `${messageId}\u0000${index}`;
}

/**
 * Decides, from the references alone and before any bytes are read, which
 * attachments of the user's (`image` parts for a model with vision, every
 * `file` part) the request carries. The history is walked once, newest first
 * (parts too); an attachment named more than once is one, kept where it is
 * newest; the distinct ones are then picked by `selectWithinBudget` against
 * the sizes their rows state: at most `MAX_REQUEST_ATTACHMENTS`, none over the
 * upload cap, and together within what the request has left after its tool
 * images (`reservedBytes`). Everything not picked is a note.
 */
export function planAttachments(
  messages: CanonMessage[],
  caps: { vision: boolean },
  size: ((id: string) => number | null) | undefined,
  reservedBytes = 0
): Map<string, Placement> {
  const placements = new Map<string, Placement>();
  const seen = new Set<string>();
  const picks: { key: string; size: number | null | undefined }[] = [];
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role === 'system') continue;
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]!;
      if (part.type === 'file' || (part.type === 'image' && caps.vision)) {
        const key = placeId(message.id, i);
        if (seen.has(part.attachmentId)) {
          placements.set(key, 'repeat');
          continue;
        }
        seen.add(part.attachmentId);
        picks.push({ key, size: size ? size(part.attachmentId) : undefined });
      }
    }
  }
  const verdicts = selectWithinBudget(picks, {
    maxCount: MAX_REQUEST_ATTACHMENTS,
    maxEach: MAX_HISTORY_ATTACHMENT_BYTES,
    maxTotal: Math.max(0, MAX_REQUEST_ATTACHMENT_BYTES - reservedBytes),
  });
  for (const [key, verdict] of verdicts) placements.set(key, verdict);
  return placements;
}

/**
 * The loader for a request: only a part the plan picked is read, each distinct
 * attachment once, and what is really read is checked again against the same
 * caps (`withinAfterLoad`). Anything else is the note for its verdict. A read
 * that fails is the caller's, as before.
 */
function takeFrom(plan: Map<string, Placement>, load: (id: string) => Promise<Buffer>, reservedBytes: number): Take {
  const loaded = new Map<string, Promise<Buffer>>();
  const real = { bytes: 0 };
  const limits = { maxCount: MAX_REQUEST_ATTACHMENTS, maxEach: MAX_HISTORY_ATTACHMENT_BYTES, maxTotal: Math.max(0, MAX_REQUEST_ATTACHMENT_BYTES - reservedBytes) };
  return async (messageId, index, attachmentId) => {
    const placement = plan.get(placeId(messageId, index));
    switch (placement) {
      case 'load': {
        let pending = loaded.get(attachmentId);
        if (!pending) {
          pending = load(attachmentId);
          loaded.set(attachmentId, pending);
        }
        const bytes = await pending;
        if (withinAfterLoad(bytes.length, real, limits)) return { bytes };
        return bytes.length > limits.maxEach ? { note: ATTACHMENT_TOO_LARGE_NOTE, cap: 'too-large' } : { note: ATTACHMENT_BUDGET_NOTE, cap: 'over-budget' };
      }
      case 'repeat':
        return { note: ATTACHMENT_REPEAT_NOTE };
      case 'too-large':
        return { note: ATTACHMENT_TOO_LARGE_NOTE, cap: 'too-large' };
      case 'over-budget':
        return { note: ATTACHMENT_BUDGET_NOTE, cap: 'over-budget' };
      default:
        return { note: ATTACHMENT_UNAVAILABLE_NOTE };
    }
  };
}

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  /** The model takes images inside tool results (vision AND a provider that supports it). Absent = false. */
  toolImages?: boolean;
}

type AssistantBlock = TextPart | FilePart | ToolCallPart;
type UserBlock = TextPart | ImagePart | FilePart;

/**
 * Derives a stand-in display name for an image attachment. `Part`'s
 * `image` variant carries only an opaque `attachmentId` and a MIME type --
 * no original filename -- and `loadAttachment` returns raw bytes, not
 * metadata, so there is no real filename available to this function by
 * construction. This builds a plausible one (id + extension guessed from
 * the MIME subtype) purely for the placeholder text shown to a model
 * without vision support; it is never treated as an actual stored name.
 */
function extensionFromMime(mime: string): string {
  const subtype = mime.split('/')[1] ?? '';
  const base = (subtype.split('+')[0] ?? '').replace(/[^a-zA-Z0-9]/g, '');
  return base || 'bin';
}

function imagePlaceholder(attachmentId: string, mime: string): string {
  return `[image: ${attachmentId}.${extensionFromMime(mime)} not supported by this model]`;
}

/**
 * A tool name as providers accept one in a replayed history (letters, digits,
 * `_` and `-`, at most 64). OtherBench's own tools already are; a chat imported
 * from claude.ai holds names such as "Home Assistant:ha_get_state", which are
 * kept as they are in OtherBench and only changed on the way to the model.
 */
export function replayToolName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || 'tool';
}

/**
 * Converts a canonical (provider-agnostic) message list into the `ai`
 * package's `ModelMessage[]` shape for a specific model's capabilities.
 *
 * Rules (see task 12 brief):
 *  - `reasoning` parts are dropped entirely -- a model's chain of thought is
 *    not safe or meaningful to replay into a *different* model.
 *  - `image` parts become a real image/file content block when `caps.vision`
 *    is true, or a text placeholder naming the (attachment-id-derived) file
 *    when it is false.
 *  - `tool-call`/`tool-result` parts are dropped entirely when `caps.tools`
 *    is false.
 *  - A `tool-result` with no matching `tool-call` anywhere earlier in the
 *    conversation is an orphan and is dropped rather than sent, regardless
 *    of `caps.tools` -- a model has no context to make sense of a result
 *    for a call it never made.
 *  - `CanonMessage` has no dedicated "tool" role: a call and its result can
 *    live as sibling parts of the same assistant message (or the call can
 *    be in an earlier message than its result). The `ai` package's
 *    `ModelMessage`, however, requires the result to be a *separate*
 *    message with role `'tool'`. So one assistant `CanonMessage` can expand
 *    into an `assistant` `ModelMessage` (text/tool-call content) followed
 *    by a `tool` `ModelMessage` (the matched tool-result content).
 *  - A `CanonMessage` that converts to no content at all (e.g. it held only
 *    a reasoning part, or only tool activity that got dropped) contributes
 *    no `ModelMessage` -- providers reject empty message content.
 *
 * Stored bytes (the user's images and files, the last few tool images) are
 * budgeted from references alone BEFORE anything is read: the tool images by
 * `loadReplayImages`, the attachments by `planAttachments`, and the second
 * takes what the first has used. Only what is picked is loaded, each file once.
 */
export async function toModelMessages(
  messages: CanonMessage[],
  caps: ModelCapabilities,
  loadAttachment: (id: string) => Promise<Buffer>,
  /**
   * Where stored tool images come from, scoped to the chat the request is for.
   * `loadAttachment` is never used for them. Without it every stored tool
   * image is replayed as a text note.
   */
  toolImages?: ToolImageSource,
  /** The size a user's attachment has in this chat, or null when it isn't available here (the same job as `ToolImageSource.size`). */
  attachmentSize?: (id: string) => number | null
): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  // Tool-call ids seen so far, across the whole conversation in order --
  // not scoped to one message -- so a result can match a call from an
  // earlier turn, not only one made in the same CanonMessage.
  const seenToolCallIds = new Set<string>();
  // Only the last few distinct stored tool images are loaded, within a size
  // cap each and together; earlier ones are replayed as a note.
  const replay = caps.toolImages === true ? await loadReplayImages(replayCandidates(messages, caps.tools), toolImages) : new Map<string, ReplayImage>();
  const reserved = replayedBytes(replay);
  const take = takeFrom(planAttachments(messages, caps, attachmentSize, reserved), loadAttachment, reserved);

  for (const message of messages) {
    if (message.role === 'system') {
      const text = systemTextFromParts(message.parts);
      if (text.length > 0) result.push({ role: 'system', content: text });
      continue;
    }

    if (message.role === 'user') {
      const content = await userContentFromParts(message.id, message.parts, caps, take);
      if (content.length > 0) result.push({ role: 'user', content });
      continue;
    }

    const { assistantContent, toolResults } = await assistantContentFromParts(
      message.id,
      message.parts,
      caps,
      take,
      seenToolCallIds,
      replay
    );
    if (assistantContent.length > 0) {
      result.push({ role: 'assistant', content: assistantContent });
    }
    if (toolResults.length > 0) {
      result.push({ role: 'tool', content: toolResults });
    }
  }

  return result;
}

/**
 * `SystemModelMessage.content` is a plain string, so every part collapses
 * into text; an image part still gets its placeholder (there is no way to
 * embed a real image content block in a system message in this format,
 * regardless of `caps.vision`), and tool activity is dropped -- it has no
 * meaning as system instructions. Nothing is ever loaded for a system message.
 */
function systemTextFromParts(parts: Part[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.length > 0) {
      chunks.push(part.text);
    } else if (part.type === 'image') {
      chunks.push(imagePlaceholder(part.attachmentId, part.mime));
    }
    // reasoning, file, tool-call, tool-result, notice: dropped from system content.
  }
  return chunks.join('\n\n');
}

async function userContentFromParts(messageId: string, parts: Part[], caps: ModelCapabilities, take: Take): Promise<UserBlock[]> {
  const content: UserBlock[] = [];
  for (const [index, part] of parts.entries()) {
    switch (part.type) {
      case 'text':
        if (part.text.length > 0) content.push({ type: 'text', text: part.text });
        break;
      case 'image':
        content.push(await convertImagePart(part, caps, () => take(messageId, index, part.attachmentId)));
        break;
      case 'file':
        content.push(await convertFilePart(part, () => take(messageId, index, part.attachmentId)));
        break;
      case 'reasoning':
      case 'tool-call':
      case 'tool-result':
      case 'notice':
      case 'context':
      case 'context-summary':
      case 'subagent':
        // Not valid content for a user turn; defensively dropped rather
        // than forwarded to the model. `notice` also never legitimately
        // appears on a user message in practice (TurnRunner only ever adds
        // one to an assistant message's own parts) -- handled here anyway
        // for exhaustiveness.
        break;
    }
  }
  return content;
}

async function assistantContentFromParts(
  messageId: string,
  parts: Part[],
  caps: ModelCapabilities,
  take: Take,
  seenToolCallIds: Set<string>,
  replay: Map<string, ReplayImage>
): Promise<{ assistantContent: AssistantBlock[]; toolResults: ToolResultPart[] }> {
  const assistantContent: AssistantBlock[] = [];
  const toolResults: ToolResultPart[] = [];

  for (const [index, part] of parts.entries()) {
    switch (part.type) {
      case 'text':
        if (part.text.length > 0) assistantContent.push({ type: 'text', text: part.text });
        break;
      case 'reasoning':
        // Dropped entirely -- not replayable across providers/models.
        break;
      case 'context':
      case 'context-summary':
      case 'notice':
        // Dropped entirely, same reasoning as `reasoning`: a capability-
        // fallback disclosure describes what OTHERBENCH did, not something the
        // model said, so replaying it as this message's own content in a
        // later turn would misattribute it as assistant output.
        break;
      case 'subagent':
        // A sub-agent's transcript is OtherBench's record of what it did. The
        // parent model only ever sees its own `subagent` tool call and the
        // result (the sub-agent's answer), so this is never replayed.
        break;
      case 'image':
        // AssistantContent has no ImagePart variant; a model-authored
        // image is represented as a file part instead.
        assistantContent.push(await convertImagePartAsAssistantBlock(part, caps, () => take(messageId, index, part.attachmentId)));
        break;
      case 'file':
        assistantContent.push(await convertFilePart(part, () => take(messageId, index, part.attachmentId)));
        break;
      case 'tool-call':
        if (!caps.tools) break;
        assistantContent.push({ type: 'tool-call', toolCallId: part.id, toolName: replayToolName(part.name), input: part.args });
        seenToolCallIds.add(part.id);
        break;
      case 'tool-result':
        if (!caps.tools) break;
        if (!seenToolCallIds.has(part.id)) break; // orphaned: no matching call anywhere before it
        toolResults.push({
          type: 'tool-result',
          toolCallId: part.id,
          toolName: replayToolName(part.name),
          output: replayToolOutput(part.result, part.isError, messageId, replay, caps.toolImages === true),
        });
        break;
    }
  }

  return { assistantContent, toolResults };
}

/**
 * Shared placeholder-or-bytes decision behind both image-part converters:
 * without vision support, a caption naming the (attachment-id-derived) file
 * stands in for the image; with it, the planned bytes are taken (or the note
 * for why not). Each caller (user-turn image vs. assistant-authored image) still
 * owns the final object shape, since `ai`'s `ImagePart` and `FilePart` differ in
 * field names (`image` vs. `data`) and only one of the two is valid per role.
 */
async function resolveImageContent(
  part: Extract<Part, { type: 'image' }>,
  caps: ModelCapabilities,
  take: () => Promise<Taken>
): Promise<{ type: 'placeholder'; text: string } | { type: 'bytes'; data: Buffer; mediaType: string }> {
  if (!caps.vision) {
    return { type: 'placeholder', text: imagePlaceholder(part.attachmentId, part.mime) };
  }
  const taken = await take();
  if ('note' in taken) return { type: 'placeholder', text: taken.note };
  // The type the model is told comes from the bytes, never from the part's own label.
  const mediaType = sniffToolImageMime(taken.bytes);
  return mediaType ? { type: 'bytes', data: taken.bytes, mediaType } : { type: 'placeholder', text: IMAGE_UNSUPPORTED_NOTE };
}

async function convertImagePart(part: Extract<Part, { type: 'image' }>, caps: ModelCapabilities, take: () => Promise<Taken>): Promise<TextPart | ImagePart> {
  const resolved = await resolveImageContent(part, caps, take);
  if (resolved.type === 'placeholder') {
    return { type: 'text', text: resolved.text };
  }
  return { type: 'image', image: resolved.data, mediaType: resolved.mediaType };
}

async function convertImagePartAsAssistantBlock(part: Extract<Part, { type: 'image' }>, caps: ModelCapabilities, take: () => Promise<Taken>): Promise<TextPart | FilePart> {
  const resolved = await resolveImageContent(part, caps, take);
  if (resolved.type === 'placeholder') {
    return { type: 'text', text: resolved.text };
  }
  return { type: 'file', data: resolved.data, mediaType: resolved.mediaType };
}

async function convertFilePart(part: Extract<Part, { type: 'file' }>, take: () => Promise<Taken>): Promise<FilePart | TextPart> {
  const taken = await take();
  // A file left out for a cap is named (the name cleaned first), so the model can say which one it did not get.
  if ('note' in taken) return { type: 'text', text: taken.cap ? omissionNote(taken.cap, part.filename) : taken.note };
  // A file keeps the type it was sent with: providers need it (a PDF, a text file), and it is not an image.
  return { type: 'file', data: taken.bytes, mediaType: part.mime, filename: part.filename };
}
