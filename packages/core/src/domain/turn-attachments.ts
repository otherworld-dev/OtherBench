import type { Store } from '../ports/store.js';
import type { CanonMessage, Part } from '../types/messages.js';
import { defuse } from './global-memory.js';
import { MAX_REQUEST_ATTACHMENTS, omissionNote } from './request-budget.js';

/** Every `attachmentId` an `image`/`file` part in `parts` names, deduplicated. */
export function attachmentIdsIn(parts: Part[]): string[] {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.type === 'image' || part.type === 'file') ids.add(part.attachmentId);
  }
  return [...ids];
}

/**
 * The honest, human-readable disclosure text for `degradeImagesForVision`'s
 * result -- task 21 decision #3 ("the user must be told which happened, not
 * silently downgraded"). Lists every degraded attachment's real filename
 * (from the `AttachmentRepo` row, not any guess derived from the id) so the
 * note is actually useful, not just "something was changed".
 */
export function degradedAttachmentsNotice(degraded: { filename: string }[], modelId: string): string {
  const names = degraded.map((d) => `"${d.filename}"`).join(', ');
  const noun = degraded.length === 1 ? 'image attachment' : 'image attachments';
  return `${degraded.length} ${noun} (${names}) sent as text to "${modelId}" because this model does not support image input.`;
}

/**
 * A file name as one plain line for a fence, a placeholder or a notice: control
 * characters and line separators (U+0085, U+2028, U+2029) become spaces, double
 * quotes single ones, `<`, `>` and `&` underscores, and bidirectional controls
 * (U+202A-202E, U+2066-2069) are dropped, so nothing in it can close the fence,
 * open a tag or reorder the text around it.
 */
function fileLabel(filename: string): string {
  const plain = filename
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/"/g, "'")
    .replace(/[<>&]/g, '_')
    .trim();
  return defuse(plain, 'attached-file');
}

/**
 * An attached file's text as the model gets it (spec 2026-10-12-office-files
 * §2): fenced and named, with anything inside that would close the fence
 * early defused. It's the user's file, so it may carry instructions; the
 * fence says where it starts and ends.
 */
export function fencedFileText(filename: string, text: string): string {
  return `<attached-file name="${fileLabel(filename)}">\n${defuse(text, 'attached-file')}\n</attached-file>`;
}

/** The notice's sentence for attached files OtherBench had no text for. */
export function unreadFilesNotice(unread: { filename: string }[], modelId: string): string {
  const names = unread.map((u) => `"${fileLabel(u.filename)}"`).join(', ');
  return `OtherBench couldn't read ${names} as text, so ${modelId} didn't get ${unread.length === 1 ? 'it' : 'them'}.`;
}

/**
 * Task 21's capability fallback, hoisted up to THIS layer rather than left
 * solely inside `toModelMessages` (engine-aisdk/convert.ts, which already
 * has an equivalent `caps.vision` branch): `AiSdkChatEngine` only ever
 * calls `toModelMessages` for a REAL (non-mock) connection -- a `mock`-kind
 * connection (and therefore `FakeChatEngine` in every test) is handed the
 * request as-is, bypassing convert.ts entirely. Doing the degrade here
 * instead means every `ChatEngine` implementation -- mock or real --
 * receives the same already-degraded `messages`, which is what makes it
 * possible to assert the fallback happened by inspecting
 * `FakeChatEngine.requests` (see packages/core/test/turn.test.ts).
 *
 * Returns a NEW array (and new per-message objects where changed);
 * `messages` itself is never mutated, so a sibling variant with a
 * vision-capable model still sees the original `image` parts untouched.
 *
 * `vision: true` is a no-op (bytes are loaded later, inside convert.ts,
 * via `EngineRequest.loadAttachment`). `vision: false` replaces every
 * `image` part with a `text` part: the attachment's own `extractedText`
 * (task 21 decision #2) when the store has one -- populated on upload for
 * `text/*`, `.md`, `.csv` and PDF, never for a genuine photo, so this is
 * the common case only for a document that happened to be sent as an
 * `image` part -- or else a generic placeholder naming the file when there
 * is no extracted text (the overwhelmingly common case for an actual
 * image: nothing here does OCR).
 */
export function degradeImagesForVision(
  store: Store,
  messages: CanonMessage[],
  vision: boolean
): { messages: CanonMessage[]; degraded: { attachmentId: string; filename: string }[] } {
  if (vision) return { messages, degraded: [] };

  const degraded: { attachmentId: string; filename: string }[] = [];
  const seen = new Set<string>();

  const next = messages.map((message) => {
    if (!message.parts.some((p) => p.type === 'image')) return message;

    const parts = message.parts.map((part): Part => {
      if (part.type !== 'image') return part;

      const attachment = store.attachments.get(part.attachmentId);
      const filename = attachment?.filename ?? part.attachmentId;
      if (!seen.has(part.attachmentId)) {
        seen.add(part.attachmentId);
        degraded.push({ attachmentId: part.attachmentId, filename });
      }

      const text = attachment?.extractedText
        ? `[Image "${filename}" is not supported by this model; showing its extracted text instead.]\n\n${attachment.extractedText}`
        : `[Image "${filename}" (${part.mime}) is not supported by this model, and no extracted text is available for it.]`;
      return { type: 'text', text };
    });

    return { ...message, parts };
  });

  return { messages: next, degraded };
}

/**
 * Attached files as the model gets them (spec 2026-10-12-office-files §2),
 * on this variant's own copy of the messages. A PDF stays a file for an
 * engine that takes PDFs (`pdfNative`: every connection but Claude Code).
 * Every other file part becomes its attachment's extracted text, fenced and
 * named, or a placeholder naming it when there is none: providers refuse
 * most file types outright, which used to fail the whole turn. The stored
 * messages are untouched.
 */
export function filesForModel(
  store: Store,
  messages: CanonMessage[],
  pdfNative: boolean
): { messages: CanonMessage[]; unread: { attachmentId: string; filename: string }[] } {
  const unread: { attachmentId: string; filename: string }[] = [];
  const seen = new Set<string>();
  // The request's attachment count cap (computer use's ruling 17: at most
  // MAX_REQUEST_ATTACHMENTS, the newest kept) counts the user's images and
  // files as the engines will, newest first, each attachment once. A file
  // sent as its text is held to it too: one that isn't among the newest is
  // left out with the same note the engines give, not sent as text instead.
  // The other way round as well: once a file is text the engines no longer
  // count it, so an image or a PDF past the window is left out here too,
  // or older images would ride on the slots the newer files' text took.
  const counted = new Set<string>();
  for (let m = messages.length - 1; m >= 0 && counted.size < MAX_REQUEST_ATTACHMENTS; m--) {
    const parts = messages[m]!.role === 'system' ? [] : messages[m]!.parts;
    for (let i = parts.length - 1; i >= 0 && counted.size < MAX_REQUEST_ATTACHMENTS; i--) {
      const part = parts[i]!;
      if (part.type === 'file' || part.type === 'image') counted.add(part.attachmentId);
    }
  }
  const next = messages.map((message) => {
    if (message.role === 'system' || !message.parts.some((p) => p.type === 'file' || p.type === 'image')) return message;
    const parts = message.parts.map((part): Part => {
      if (part.type === 'image') return counted.has(part.attachmentId) ? part : { type: 'text', text: omissionNote('over-budget') };
      if (part.type !== 'file') return part;
      const attachment = store.attachments.get(part.attachmentId);
      const filename = attachment?.filename ?? part.filename;
      if (!counted.has(part.attachmentId)) return { type: 'text', text: omissionNote('over-budget', filename) };
      if (pdfNative && part.mime === 'application/pdf') return part;
      if (attachment?.extractedText) return { type: 'text', text: fencedFileText(filename, attachment.extractedText) };
      if (!seen.has(part.attachmentId)) {
        seen.add(part.attachmentId);
        unread.push({ attachmentId: part.attachmentId, filename });
      }
      const mime = part.mime.replace(/[^\w.+/-]/g, '');
      return { type: 'text', text: `[Attached file "${fileLabel(filename)}" (${mime}) couldn't be read as text, so it wasn't sent.]` };
    });
    return { ...message, parts };
  });
  return { messages: next, unread };
}
