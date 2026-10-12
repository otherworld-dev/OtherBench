import type { JSONValue, ToolResultPart } from 'ai';
import { isInlineToolImage, isToolImageRef } from '@grunt/core/domain/tool-images.js';
import type { ConnectionKind } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';

/**
 * Images in tool results, on the way to a model (spec
 * 2026-10-12-computer-use-design sections 5-6). Live, inside one turn, a
 * tool's output still carries base64 (`liveToolOutput`); replayed from
 * history it carries attachment references, and only the last
 * `REPLAYED_TOOL_IMAGES` are loaded (`replayToolOutput`). This also stops MCP
 * tools' images reaching the model as base64 inside JSON.
 */

export const IMAGE_OMITTED_NOTE = "[image omitted: this model can't take images]";
export const EARLIER_SCREENSHOT_NOTE = '[earlier screenshot omitted]';
export const IMAGE_UNAVAILABLE_NOTE = '[image not available]';
export const REPLAYED_TOOL_IMAGES = 3;

type Output = ToolResultPart['output'];
type ContentItem = Extract<Output, { type: 'content' }>['value'][number];

function isTextItem(value: unknown): value is { type: 'text'; text: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'text' && typeof (value as { text?: unknown }).text === 'string';
}

/** Whether a provider takes images inside tool results. `@ai-sdk/openai-compatible` (Ollama too) doesn't. */
export function toolImagesSupported(kind: ConnectionKind): boolean {
  return kind !== 'openai_compatible' && kind !== 'ollama';
}

/** A tool's live output as the model gets it; anything without an inline image goes as the SDK would send it. */
export function liveToolOutput(output: unknown, imagesOk: boolean): Output {
  if (Array.isArray(output) && output.some(isInlineToolImage)) {
    return {
      type: 'content',
      value: output.map((item): ContentItem => {
        if (isInlineToolImage(item)) return imagesOk ? { type: 'image-data', data: item.data, mediaType: item.mimeType } : { type: 'text', text: IMAGE_OMITTED_NOTE };
        if (isTextItem(item)) return { type: 'text', text: item.text };
        return { type: 'text', text: JSON.stringify(item) };
      }),
    };
  }
  return typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: (output ?? null) as JSONValue };
}

/** The attachment ids of the last `keep` image references in tool results, across the whole history. */
export function replayedImageIds(messages: CanonMessage[], keep = REPLAYED_TOOL_IMAGES): Set<string> {
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool-result' || !Array.isArray(part.result)) continue;
      for (const item of part.result) if (isToolImageRef(item)) ids.push(item.attachmentId);
    }
  }
  return new Set(ids.slice(-keep));
}

/** A stored tool result as the model gets it on a later turn. */
export async function replayToolOutput(
  result: unknown,
  isError: boolean,
  replay: Set<string>,
  imagesOk: boolean,
  load: (id: string) => Promise<Buffer>
): Promise<Output> {
  if (!isError && Array.isArray(result) && result.some(isToolImageRef)) {
    const value: ContentItem[] = [];
    for (const item of result) {
      if (isToolImageRef(item)) {
        if (!imagesOk) value.push({ type: 'text', text: IMAGE_OMITTED_NOTE });
        else if (!replay.has(item.attachmentId)) value.push({ type: 'text', text: EARLIER_SCREENSHOT_NOTE });
        else {
          try {
            value.push({ type: 'image-data', data: (await load(item.attachmentId)).toString('base64'), mediaType: item.mimeType });
          } catch {
            value.push({ type: 'text', text: IMAGE_UNAVAILABLE_NOTE });
          }
        }
      } else if (isTextItem(item)) value.push({ type: 'text', text: item.text });
      else value.push({ type: 'text', text: JSON.stringify(item) });
    }
    return { type: 'content', value };
  }
  const value = (result ?? null) as JSONValue;
  return isError ? { type: 'error-json', value } : { type: 'json', value };
}
