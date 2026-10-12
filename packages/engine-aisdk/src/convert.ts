import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { replayedImageIds, replayToolOutput } from './tool-images.js';

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
 * `_` and `-`, at most 64). Grunt's own tools already are; a chat imported
 * from claude.ai holds names such as "Home Assistant:ha_get_state", which are
 * kept as they are in Grunt and only changed on the way to the model.
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
 */
export async function toModelMessages(
  messages: CanonMessage[],
  caps: ModelCapabilities,
  loadAttachment: (id: string) => Promise<Buffer>
): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  // Tool-call ids seen so far, across the whole conversation in order --
  // not scoped to one message -- so a result can match a call from an
  // earlier turn, not only one made in the same CanonMessage.
  const seenToolCallIds = new Set<string>();
  // The images of the last few tool results are the only ones loaded; earlier
  // ones are replayed as a note.
  const replay = caps.toolImages === true ? replayedImageIds(messages) : new Set<string>();

  for (const message of messages) {
    if (message.role === 'system') {
      const text = await systemTextFromParts(message.parts, loadAttachment);
      if (text.length > 0) result.push({ role: 'system', content: text });
      continue;
    }

    if (message.role === 'user') {
      const content = await userContentFromParts(message.parts, caps, loadAttachment);
      if (content.length > 0) result.push({ role: 'user', content });
      continue;
    }

    const { assistantContent, toolResults } = await assistantContentFromParts(
      message.parts,
      caps,
      loadAttachment,
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
 * meaning as system instructions.
 */
async function systemTextFromParts(parts: Part[], loadAttachment: (id: string) => Promise<Buffer>): Promise<string> {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.length > 0) {
      chunks.push(part.text);
    } else if (part.type === 'image') {
      void loadAttachment; // never loaded for a system message -- see docstring
      chunks.push(imagePlaceholder(part.attachmentId, part.mime));
    }
    // reasoning, file, tool-call, tool-result, notice: dropped from system content.
  }
  return chunks.join('\n\n');
}

async function userContentFromParts(
  parts: Part[],
  caps: ModelCapabilities,
  loadAttachment: (id: string) => Promise<Buffer>
): Promise<UserBlock[]> {
  const content: UserBlock[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text.length > 0) content.push({ type: 'text', text: part.text });
        break;
      case 'image':
        content.push(await convertImagePart(part, caps, loadAttachment));
        break;
      case 'file':
        content.push(await convertFilePart(part, loadAttachment));
        break;
      case 'reasoning':
      case 'tool-call':
      case 'tool-result':
      case 'notice':
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
  parts: Part[],
  caps: ModelCapabilities,
  loadAttachment: (id: string) => Promise<Buffer>,
  seenToolCallIds: Set<string>,
  replay: Set<string>
): Promise<{ assistantContent: AssistantBlock[]; toolResults: ToolResultPart[] }> {
  const assistantContent: AssistantBlock[] = [];
  const toolResults: ToolResultPart[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text.length > 0) assistantContent.push({ type: 'text', text: part.text });
        break;
      case 'reasoning':
        // Dropped entirely -- not replayable across providers/models.
        break;
      case 'notice':
        // Dropped entirely, same reasoning as `reasoning`: a capability-
        // fallback disclosure describes what GRUNT did, not something the
        // model said, so replaying it as this message's own content in a
        // later turn would misattribute it as assistant output.
        break;
      case 'image':
        // AssistantContent has no ImagePart variant; a model-authored
        // image is represented as a file part instead.
        assistantContent.push(await convertImagePartAsAssistantBlock(part, caps, loadAttachment));
        break;
      case 'file':
        assistantContent.push(await convertFilePart(part, loadAttachment));
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
          output: await replayToolOutput(part.result, part.isError, replay, caps.toolImages === true, loadAttachment),
        });
        break;
    }
  }

  return { assistantContent, toolResults };
}

/**
 * Shared placeholder-or-bytes decision behind both image-part converters:
 * without vision support, a caption naming the (attachment-id-derived) file
 * stands in for the image; with it, the real bytes are loaded. Each caller
 * (user-turn image vs. assistant-authored image) still owns the final
 * object shape, since `ai`'s `ImagePart` and `FilePart` differ in field
 * names (`image` vs. `data`) and only one of the two is valid per role.
 */
async function resolveImageContent(
  part: Extract<Part, { type: 'image' }>,
  caps: ModelCapabilities,
  loadAttachment: (id: string) => Promise<Buffer>
): Promise<{ type: 'placeholder'; text: string } | { type: 'bytes'; data: Buffer; mediaType: string }> {
  if (!caps.vision) {
    return { type: 'placeholder', text: imagePlaceholder(part.attachmentId, part.mime) };
  }
  const data = await loadAttachment(part.attachmentId);
  return { type: 'bytes', data, mediaType: part.mime };
}

async function convertImagePart(
  part: Extract<Part, { type: 'image' }>,
  caps: ModelCapabilities,
  loadAttachment: (id: string) => Promise<Buffer>
): Promise<TextPart | ImagePart> {
  const resolved = await resolveImageContent(part, caps, loadAttachment);
  if (resolved.type === 'placeholder') {
    return { type: 'text', text: resolved.text };
  }
  return { type: 'image', image: resolved.data, mediaType: resolved.mediaType };
}

async function convertImagePartAsAssistantBlock(
  part: Extract<Part, { type: 'image' }>,
  caps: ModelCapabilities,
  loadAttachment: (id: string) => Promise<Buffer>
): Promise<TextPart | FilePart> {
  const resolved = await resolveImageContent(part, caps, loadAttachment);
  if (resolved.type === 'placeholder') {
    return { type: 'text', text: resolved.text };
  }
  return { type: 'file', data: resolved.data, mediaType: resolved.mediaType };
}

async function convertFilePart(
  part: Extract<Part, { type: 'file' }>,
  loadAttachment: (id: string) => Promise<Buffer>
): Promise<FilePart> {
  const data = await loadAttachment(part.attachmentId);
  return { type: 'file', data, mediaType: part.mime, filename: part.filename };
}
