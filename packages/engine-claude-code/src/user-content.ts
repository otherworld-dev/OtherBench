import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MAX_HISTORY_ATTACHMENT_BYTES } from '@otherbench/core/domain/attachment-binding.js';
import { contextLineOf, isClearName } from '@otherbench/core/domain/context-lines.js';
import { HANDOVER_PROMPT } from '@otherbench/core/domain/handover.js';
import { listedName, MAX_REQUEST_ATTACHMENT_BYTES, MAX_REQUEST_ATTACHMENTS, OMISSION_REASONS, omissionNote, selectWithinBudget, withinAfterLoad, type Omission } from '@otherbench/core/domain/request-budget.js';
import { sniffToolImageMime } from '@otherbench/core/domain/tool-images.js';
import type { EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { CanonMessage, NoteAttachment, Part } from '@otherbench/core/types/messages.js';
import { renderHistory } from './history.js';

export type ContentBlock ={ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** A message to Claude Code; `uuid` lets the reply find the result of its own turn. */
export const userMessage = (content: ContentBlock[], uuid?: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' }, ...(uuid ? { uuid } : {}) }) as unknown as SDKUserMessage;

/** A message that starts with a slash command (`/name`, `/plugin:name args`): Claude Code runs it as that command. */
const COMMAND = /^\/([A-Za-z0-9][\w:.-]*)(\s|$)/;

/** The focus of the /compact the new message is ('' for none), or null when it isn't one. */
export function compactFocus(req: EngineRequest): string | null {
  const last = req.messages[req.messages.length - 1];
  const line = last ? contextLineOf(last) : null;
  return line?.kind === 'compact' ? (line.focus ?? '') : null;
}

/**
 * Whether the new message starts with Claude Code's own /clear (or /reset,
 * /new) in any case. It is never sent: OtherBench would still think the
 * session holds the whole chat. The turns route refuses it first; this is the backstop.
 */
export function sendsClear(req: EngineRequest): boolean {
  const first = req.messages[req.messages.length - 1]?.parts.find((p) => p.type === 'text');
  const name = first?.type === 'text' ? COMMAND.exec(first.text)?.[1] : undefined;
  return name !== undefined && isClearName(name);
}

export const textOf = (m: CanonMessage | undefined): string => (m?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');

/**
 * The names of the new message's non-image attachments, which Claude Code
 * turns do not receive, as they go into the transcript's notice and into the
 * prompt: each cleaned by core's `listedName` (one line, no control or hidden
 * character, at most 80 characters, no quote, no bracket that could close a
 * note, no comma that could pass for two names). A name with nothing left in
 * it is still listed, so the file is not dropped from the count.
 */
export const skippedFiles = (m: CanonMessage | undefined): string[] => (m?.parts ?? []).flatMap((p) => (p.type === 'file' ? [listedName(p.filename) || 'unnamed file'] : []));

/** The transcript's line about the new message's images that were not sent (how many, and each reason once), or null when all were. */
export function omittedImagesNotice(omitted: Omission[]): string | null {
  if (omitted.length === 0) return null;
  const reasons = [...new Set(omitted.map((why) => OMISSION_REASONS[why]))];
  return `Not sent to Claude Code: ${omitted.length} ${omitted.length === 1 ? 'image' : 'images'} (${reasons.join('; ')}).`;
}

/**
 * A note as content blocks: its text, then its images. A file, or an image
 * over the per-file cap or whose bytes aren't an image, becomes a line in
 * the text instead: Claude Code turns only take images.
 */
export async function noteContent(req: EngineRequest, note: { text: string; attachments: NoteAttachment[] }): Promise<ContentBlock[]> {
  const lines = note.text ? [note.text] : [];
  const images: ContentBlock[] = [];
  const notSent = (a: NoteAttachment): void => {
    lines.push(`(${listedName(a.filename) || 'unnamed file'} wasn't sent: Claude Code only takes images.)`);
  };
  for (const a of note.attachments) {
    const size = req.attachmentSize?.(a.attachmentId);
    if (!a.mime.startsWith('image/') || !req.loadAttachment || (typeof size === 'number' && size > MAX_REQUEST_ATTACHMENT_BYTES)) {
      notSent(a);
      continue;
    }
    const bytes = await req.loadAttachment(a.attachmentId);
    const mediaType = bytes.length > MAX_REQUEST_ATTACHMENT_BYTES ? null : sniffToolImageMime(bytes);
    if (mediaType === null) notSent(a);
    else images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
  }
  return [...(lines.length > 0 ? [{ type: 'text' as const, text: lines.join('\n') }] : []), ...images];
}

/**
 * The new message's images, when the model takes them, as what goes to
 * Claude Code in their place: an image block, or the note for one left out
 * (the notes the API engine writes), in the order of the parts. They are
 * picked from the references and the sizes their rows state before any is
 * read (the same selector the API engine uses): the newest few, each within
 * the upload cap and all together within the request's room, each file once;
 * the type sent is the one the bytes have. Nothing is left out silently:
 * `omitted` says why for each, for the transcript's notice.
 */
export async function newImages(req: EngineRequest): Promise<{ blocks: ContentBlock[]; omitted: Omission[] }> {
  const last = req.messages[req.messages.length - 1];
  const blocks: ContentBlock[] = [];
  const omitted: Omission[] = [];
  const images = (last?.parts ?? []).filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image');
  if (images.length === 0 || !req.loadAttachment || !(req.profile.model?.supportsVision ?? true)) return { blocks, omitted };
  const leaveOut = (why: Omission): void => {
    omitted.push(why);
    blocks.push({ type: 'text', text: omissionNote(why) });
  };
  const distinct = [...new Map(images.map((p) => [p.attachmentId, p])).values()];
  const limits = { maxCount: MAX_REQUEST_ATTACHMENTS, maxEach: MAX_HISTORY_ATTACHMENT_BYTES, maxTotal: MAX_REQUEST_ATTACHMENT_BYTES };
  const newestFirst = [...distinct].reverse().map((p) => ({ key: p.attachmentId, size: req.attachmentSize ? req.attachmentSize(p.attachmentId) : undefined }));
  const verdicts = selectWithinBudget(newestFirst, limits);
  const loaded = { bytes: 0 };
  for (const part of distinct) {
    const verdict = verdicts.get(part.attachmentId) ?? 'unknown';
    if (verdict !== 'load') {
      leaveOut(verdict);
      continue;
    }
    const bytes = await req.loadAttachment(part.attachmentId);
    if (!withinAfterLoad(bytes.length, loaded, limits)) {
      leaveOut(bytes.length > limits.maxEach ? 'too-large' : 'over-budget');
      continue;
    }
    const mediaType = sniffToolImageMime(bytes);
    if (mediaType === null) leaveOut('not-image');
    else blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
  }
  return { blocks, omitted };
}

/**
 * The new user message as content blocks: seeded history for a fresh
 * session, text, then its images (see `newImages`). A /compact is the
 * command alone. A message starting with any other slash command sends only
 * that first text part (later ones, such as the artifacts note, would become
 * its arguments), with a fresh session's history after it: the command still
 * runs and the model sees the history (live probe, test/fixtures/README.md).
 */
export function userContent(req: EngineRequest, fresh: boolean, images: ContentBlock[]): ContentBlock[] {
  const focus = compactFocus(req);
  if (focus !== null) return [{ type: 'text', text: focus ? `/compact ${focus}` : '/compact' }];
  if (req.handover === true) return [{ type: 'text', text: HANDOVER_PROMPT }];
  const last = req.messages[req.messages.length - 1];
  const history = fresh ? renderHistory(req.messages) : '';
  const first = last?.parts.find((p) => p.type === 'text');
  if (first?.type === 'text' && COMMAND.test(first.text)) return [{ type: 'text', text: history ? `${first.text}\n\n${history}` : first.text }, ...images];
  const skipped = skippedFiles(last);
  const note = skipped.length > 0 ? `\n\n(Attached files not sent, because Claude Code turns in OtherBench only receive images: ${skipped.join(', ')}.)` : '';
  const text = [history, textOf(last)].filter((s) => s.length > 0).join('\n\n') + note;
  return [{ type: 'text', text }, ...images];
}
