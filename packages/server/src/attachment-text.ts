/**
 * Text extraction for uploaded attachments (task 21 decision #2). Runs once,
 * synchronously with the upload request, and its result is stored in
 * `Attachment.extractedText` -- that column is what `TurnRunner` falls back
 * to when a message's `image` part has to be degraded for a model that
 * doesn't declare vision support (packages/core/src/domain/turn.ts,
 * `degradeImagesForVision`).
 *
 * Covers `text/*`, `application/json`, `.md .markdown .csv .tsv .txt .json
 * .log`, PDF, and Word, Excel and PowerPoint (.docx/.docm, .xlsx/.xlsm,
 * .pptx/.pptm: spec 2026-10-12-office-files §1, read by office/extract.ts).
 * Every attached file that isn't a PDF reaches the model as this text
 * (TurnRunner.filesForModel), so it's what the model reads. Anything else
 * (including every ordinary image format -- no OCR is performed here)
 * yields `null`, an expected result, not a failure: the model gets a
 * placeholder naming the file and the reply a notice.
 */

import { extractOfficeText } from './office/extract.js';

/** Hard cap on how many characters of extracted text are kept. A pathological multi-megabyte `.csv` (still under the 25MB attachment cap) would otherwise dump its entire content into every vision-fallback placeholder sent to a model -- plausibly blowing past its context window on its own. Generous enough that this never bites a realistic document. */
export const MAX_EXTRACTED_TEXT_CHARS = 100_000;

const PLAIN_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.csv', '.tsv', '.txt', '.json', '.log']);
/** Read as text only: Grunt never makes a macro-enabled file. */
const OFFICE_EXTENSIONS = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm']);
const OFFICE_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export type ExtractionKind = 'plain-text' | 'pdf' | 'office' | null;

/** Classifies an upload by MIME type first, then by a fixed extension allowlist, since a browser may send a generic type (a .csv as application/vnd.ms-excel, an .xlsx as application/octet-stream). An Office file's main part decides what it really is (office/extract.ts). */
export function classifyForExtraction(mime: string, filename: string): ExtractionKind {
  if (mime.startsWith('text/') || mime === 'application/json') return 'plain-text';
  if (mime === 'application/pdf') return 'pdf';
  if (OFFICE_MIME.has(mime)) return 'office';

  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) return 'plain-text';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  return null;
}

/** An Office file's text, or null; a file that can't be read never fails the upload. */
function extractOffice(data: Buffer): string | null {
  try {
    return extractOfficeText(data, { maxChars: MAX_EXTRACTED_TEXT_CHARS });
  } catch (err) {
    // Any error, not only ZipError/XmlError: a hostile part can also throw a RangeError.
    console.error('[grunt-server] Office text extraction failed; storing the attachment with no extracted text:', err);
    return null;
  }
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

  if (kind === 'office') {
    const officeText = extractOffice(data);
    return officeText ? truncate(officeText) : null;
  }

  const pdfText = await extractPdfText(data);
  return pdfText ? truncate(pdfText) : null;
}
