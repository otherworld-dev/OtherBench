import { describe, expect, it, vi } from 'vitest';
import { classifyForExtraction, extractAttachmentText, MAX_EXTRACTED_TEXT_CHARS } from '../src/attachment-text.js';
import { makeZip } from './import/make-zip.js';

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

  it('reads a PDF sent with an empty or generic MIME type, by its .pdf extension', async () => {
    expect(classifyForExtraction('', 'report.pdf')).toBe('pdf');
    expect(classifyForExtraction('application/octet-stream', 'REPORT.PDF')).toBe('pdf');
    expect(await extractAttachmentText(MINIMAL_PDF, 'application/octet-stream', 'report.pdf')).toContain('Hello PDF world');
  });

  it('degrades to null (not a thrown error) for bytes that are not actually a valid PDF', async () => {
    const text = await extractAttachmentText(Buffer.from('not a pdf at all'), 'application/pdf', 'fake.pdf');
    expect(text).toBeNull();
  });
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const memoDocx = (doc = `<w:document ${WORD_NS}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`) =>
  makeZip([{ name: 'word/document.xml', content: doc }]);

describe('classifyForExtraction: Office and more plain text', () => {
  it('classifies the three OOXML types by MIME and by extension, macro-enabled ones included', () => {
    expect(classifyForExtraction(DOCX_MIME, 'a.bin')).toBe('office');
    expect(classifyForExtraction('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a')).toBe('office');
    expect(classifyForExtraction('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a')).toBe('office');
    for (const name of ['a.DOCX', 'a.docm', 'b.xlsx', 'b.xlsm', 'c.pptx', 'c.pptm']) expect(classifyForExtraction('application/octet-stream', name)).toBe('office');
  });

  it('reads .tsv, .txt, .json and .log, and application/json, as plain text', () => {
    for (const name of ['a.tsv', 'a.txt', 'a.json', 'a.log']) expect(classifyForExtraction('application/octet-stream', name)).toBe('plain-text');
    expect(classifyForExtraction('application/json', 'data')).toBe('plain-text');
  });

  it('leaves legacy .doc and plain ZIPs alone', () => {
    expect(classifyForExtraction('application/msword', 'old.doc')).toBeNull();
    expect(classifyForExtraction('application/zip', 'a.zip')).toBeNull();
  });
});

describe('extractAttachmentText: Office files', () => {
  it("reads a Word file's text", async () => {
    expect(await extractAttachmentText(memoDocx(), DOCX_MIME, 'memo.docx')).toBe('# Intro\nBody');
  });

  it('gives null, without failing the upload, for a non-ZIP called .docx or a part with a DOCTYPE', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await extractAttachmentText(Buffer.from('not a zip at all, honestly'), DOCX_MIME, 'fake.docx')).toBeNull();
      expect(await extractAttachmentText(memoDocx(`<!DOCTYPE w:document [<!ENTITY x "y">]><w:document ${WORD_NS}/>`), DOCX_MIME, 'evil.docx')).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });

  it('stops at the character cap and says so', async () => {
    const big = `<w:document ${WORD_NS}><w:body>${Array.from({ length: 3000 }, () => `<w:p><w:r><w:t>${'word '.repeat(20)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
    const text = (await extractAttachmentText(memoDocx(big), DOCX_MIME, 'big.docx'))!;
    expect(text).toMatch(/\[\.\.\.truncated at 100000 characters\]$/);
  });
});

describe('extractAttachmentText: what the file really is decides', () => {
  const workbook = () =>
    makeZip([
      { name: 'xl/workbook.xml', content: '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>' },
    ]);

  it('reads an .xlsx sent as application/octet-stream', async () => {
    expect(await extractAttachmentText(workbook(), 'application/octet-stream', 'book.xlsx')).toBe('Sheet "S" (A1:A1) as CSV:\n7');
  });

  it('reads a .docx that is really a workbook as a workbook', async () => {
    expect(await extractAttachmentText(workbook(), DOCX_MIME, 'misnamed.docx')).toBe('Sheet "S" (A1:A1) as CSV:\n7');
  });

  it('reads a PowerPoint file by its MIME type', async () => {
    const deck = makeZip([
      { name: 'ppt/presentation.xml', content: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>' },
      { name: 'ppt/_rels/presentation.xml.rels', content: '<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>' },
      { name: 'ppt/slides/slide1.xml', content: '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Hello deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
    ]);
    expect(await extractAttachmentText(deck, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'd.pptx')).toBe('Slide 1: Hello deck');
  });
});
