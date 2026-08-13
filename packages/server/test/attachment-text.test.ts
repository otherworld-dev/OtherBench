import { describe, expect, it } from 'vitest';
import { classifyForExtraction, extractAttachmentText, MAX_EXTRACTED_TEXT_CHARS } from '../src/attachment-text.js';

// A minimal, hand-written PDF containing the literal text "Hello PDF world"
// via a bare content stream -- verified against `unpdf` directly while
// choosing the extraction dependency for task 21 (see task-21-report.md).
// Its xref table is deliberately not byte-accurate; PDF.js falls back to
// scanning the file for objects when that happens, which is exactly the
// lenient, real-world behaviour this is meant to exercise.
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 200 200]/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 44>>
stream
BT /F1 24 Tf 20 100 Td (Hello PDF world) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`,
  'utf8'
);

describe('classifyForExtraction', () => {
  it('classifies text/* MIME types as plain-text', () => {
    expect(classifyForExtraction('text/plain', 'a.txt')).toBe('plain-text');
    expect(classifyForExtraction('text/markdown', 'a.md')).toBe('plain-text');
    expect(classifyForExtraction('text/csv', 'a.csv')).toBe('plain-text');
  });

  it('classifies application/pdf as pdf', () => {
    expect(classifyForExtraction('application/pdf', 'report.pdf')).toBe('pdf');
  });

  it('falls back to the .md/.csv extension when the MIME type is generic', () => {
    expect(classifyForExtraction('application/octet-stream', 'notes.md')).toBe('plain-text');
    expect(classifyForExtraction('application/octet-stream', 'data.csv')).toBe('plain-text');
    expect(classifyForExtraction('application/vnd.ms-excel', 'data.CSV')).toBe('plain-text');
  });

  it('returns null for images and other non-extractable types', () => {
    expect(classifyForExtraction('image/png', 'photo.png')).toBeNull();
    expect(classifyForExtraction('application/octet-stream', 'archive.zip')).toBeNull();
  });
});

describe('extractAttachmentText', () => {
  it('extracts plain text verbatim', async () => {
    const text = await extractAttachmentText(Buffer.from('hello world'), 'text/plain', 'a.txt');
    expect(text).toBe('hello world');
  });

  it('returns null for an empty text file rather than an empty string', async () => {
    const text = await extractAttachmentText(Buffer.alloc(0), 'text/plain', 'empty.txt');
    expect(text).toBeNull();
  });

  it('returns null for a non-extractable MIME/filename (e.g. an image) without attempting anything', async () => {
    const text = await extractAttachmentText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'photo.png');
    expect(text).toBeNull();
  });

  it('truncates text exceeding the character cap, appending a truncation marker', async () => {
    const huge = 'x'.repeat(MAX_EXTRACTED_TEXT_CHARS + 500);
    const text = await extractAttachmentText(Buffer.from(huge), 'text/plain', 'huge.txt');
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(huge.length);
    expect(text).toContain('truncated');
  });

  it('extracts real text out of a PDF via unpdf', async () => {
    const text = await extractAttachmentText(MINIMAL_PDF, 'application/pdf', 'report.pdf');
    expect(text).toContain('Hello PDF world');
  });

  it('degrades to null (not a thrown error) for bytes that are not actually a valid PDF', async () => {
    const text = await extractAttachmentText(Buffer.from('not a pdf at all'), 'application/pdf', 'fake.pdf');
    expect(text).toBeNull();
  });
});
