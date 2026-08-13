/**
 * Text extraction for uploaded attachments (task 21 decision #2). Runs once,
 * synchronously with the upload request, and its result is stored in
 * `Attachment.extractedText` -- that column is what `TurnRunner` falls back
 * to when a message's `image` part has to be degraded for a model that
 * doesn't declare vision support (packages/core/src/domain/turn.ts,
 * `degradeImagesForVision`).
 *
 * Covers exactly what the brief asks for: `text/*`, `.md`, `.csv`, and PDF.
 * Anything else (including every ordinary image format -- no OCR is
 * performed here) yields `null`, which is an entirely normal, expected
 * result, not a failure: `degradeImagesForVision` falls back to a generic
 * "not supported, no extracted text available" placeholder in that case.
 */

/** Hard cap on how many characters of extracted text are kept. A pathological multi-megabyte `.csv` (still under the 25MB attachment cap) would otherwise dump its entire content into every vision-fallback placeholder sent to a model -- plausibly blowing past its context window on its own. Generous enough that this never bites a realistic document. */
export const MAX_EXTRACTED_TEXT_CHARS = 100_000;

const PLAIN_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.csv']);

export type ExtractionKind = 'plain-text' | 'pdf' | null;

/** Classifies an upload by MIME type first, falling back to a small fixed extension allowlist for the two named-by-extension cases in the brief (`.md`, `.csv`) whose MIME type a browser/client may report generically (e.g. `text/markdown` isn't universally sent; a bare `.csv` sometimes arrives as `application/vnd.ms-excel` or even `application/octet-stream`). */
export function classifyForExtraction(mime: string, filename: string): ExtractionKind {
  if (mime.startsWith('text/')) return 'plain-text';
  if (mime === 'application/pdf') return 'pdf';

  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) return 'plain-text';
  return null;
}

function truncate(text: string): string {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n[...truncated at ${MAX_EXTRACTED_TEXT_CHARS} characters]`;
}

/**
 * PDF extraction is isolated behind a dynamic `import()` (rather than a
 * top-level import of `unpdf`) so that a plain-text or image upload -- the
 * overwhelming majority of uploads -- never pays for loading PDF.js at all.
 *
 * `unpdf` (not `pdf-parse`) was chosen after checking both on npm: `pdf-parse`
 * 2.4.5 depends on `pdfjs-dist` AND `@napi-rs/canvas` (a native addon), which
 * is exactly the "heavy/unreliable" risk the task brief warned about --
 * a native compile dependency for a text-only extraction is a lot of surface
 * area to fail on an arbitrary host. `unpdf` 1.8.0 ships PDF.js's own
 * "serverless" build (pure JS, no canvas, no native bindings) specifically
 * for this use case, so it was pinned instead. Verified empirically against
 * a hand-written minimal PDF before wiring this in (see task-21-report.md).
 */
async function extractPdfText(data: Buffer): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(doc, { mergePages: true });
    return text.trim().length > 0 ? text : null;
  } catch (err) {
    // Malformed/encrypted/unsupported PDF, or any other extraction failure:
    // degrade to "no extracted text" rather than fail the whole upload.
    // Uploading the FILE must still succeed -- extraction is a best-effort
    // enhancement, not a precondition -- so the attachment is still created,
    // just with `extractedText: null` (the same outcome as a genuine image).
    console.error('[grunt-server] PDF text extraction failed; storing the attachment with no extracted text:', err);
    return null;
  }
}

/** Extracts text from `data` for the fallback column, or `null` if this MIME/filename isn't one of the extractable kinds, or nothing came out of it. */
export async function extractAttachmentText(data: Buffer, mime: string, filename: string): Promise<string | null> {
  const kind = classifyForExtraction(mime, filename);
  if (kind === null) return null;

  if (kind === 'plain-text') {
    const text = data.toString('utf8');
    return text.length > 0 ? truncate(text) : null;
  }

  const pdfText = await extractPdfText(data);
  return pdfText ? truncate(pdfText) : null;
}
