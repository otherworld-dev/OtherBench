import { describe, expect, it } from 'vitest';
import { extractOfficeText } from '../../src/office/extract.js';
import { makeZip } from '../import/make-zip.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const p = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const r = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
function docx(body: string, styles?: string): Buffer {
  return makeZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'word/document.xml', content: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>` },
    ...(styles ? [{ name: 'word/styles.xml', content: `<w:styles ${W}>${styles}</w:styles>` }] : []),
  ]);
}

describe('reading Word files', () => {
  it('takes heading levels from style names, so a localised style id still counts', () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style>';
    const body =
      p(r('Report'), '<w:pStyle w:val="Titel"/>') +
      p(r('Intro'), '<w:pStyle w:val="Heading1"/>') +
      p(r('Detail'), '<w:pStyle w:val="berschrift2"/>') +
      p(r('Body text'));
    expect(extractOfficeText(docx(body, styles))).toBe('# Report\n# Intro\n## Detail\nBody text');
  });

  it('falls back to a HeadingN style id when there is no styles part', () => {
    expect(extractOfficeText(docx(p(r('Plain heading'), '<w:pStyle w:val="Heading3"/>')))).toBe('### Plain heading');
  });

  it('reads list levels, tabs and breaks, but not tab-stop definitions or numId 0', () => {
    const body =
      p(r('First'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
      p(r('Nested'), '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>') +
      p('<w:r><w:t>Name</w:t><w:tab/><w:t>Value</w:t><w:br/><w:t>Next line</w:t></w:r>', '<w:tabs><w:tab w:val="left" w:pos="2880"/></w:tabs>') +
      p(r('Not a list'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>');
    expect(extractOfficeText(docx(body))).toBe('- First\n  - Nested\nName\tValue\nNext line\nNot a list');
  });

  it('reads a table as a Markdown table between blank lines', () => {
    const table = `<w:tbl><w:tr><w:tc>${p(r('Item'))}</w:tc><w:tc>${p(r('Cost'))}</w:tc></w:tr><w:tr><w:tc>${p(r('A|B'))}</w:tc><w:tc>${p(r('12'))}</w:tc></w:tr></w:tbl>`;
    expect(extractOfficeText(docx(p(r('Before')) + table + p(r('After'))))).toBe('Before\n\n| Item | Cost |\n| --- | --- |\n| A\\|B | 12 |\n\nAfter');
  });

  it('leaves out deleted text, field codes and moved-away text, and reads a text box once', () => {
    const body =
      p(`${r('Kept')}<w:del><w:r><w:delText>Gone</w:delText></w:r></w:del><w:r><w:instrText> PAGE </w:instrText></w:r><w:moveFrom><w:r><w:t>Moved away</w:t></w:r></w:moveFrom>`) +
      p(`<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${p(r('In a box'))}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p(r('In a box'))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>${r('Outer')}`);
    expect(extractOfficeText(docx(body))).toBe('Kept\nIn a box\nOuter');
  });

  it('collapses runs of empty paragraphs to one blank line', () => {
    expect(extractOfficeText(docx(p(r('One')) + '<w:p/><w:p/><w:p/>' + p(r('Two'))))).toBe('One\n\nTwo');
  });

  it('stops at the character cap', () => {
    const body = Array.from({ length: 50 }, (_, i) => p(r(`Paragraph ${i} `.repeat(10)))).join('');
    const text = extractOfficeText(docx(body), { maxChars: 500 })!;
    expect(text.length).toBeLessThan(800);
    expect(text).toContain('Paragraph 0');
    expect(text).not.toContain('Paragraph 49');
  });

  it('gives null for a ZIP with no Office main part', () => {
    expect(extractOfficeText(makeZip([{ name: 'readme.txt', content: 'hi' }]))).toBeNull();
  });

  it('clamps a hostile list level instead of losing the document', () => {
    const body =
      p(r('Negative'), '<w:numPr><w:ilvl w:val="-1"/><w:numId w:val="1"/></w:numPr>') +
      p(r('Huge'), '<w:numPr><w:ilvl w:val="99999999"/><w:numId w:val="1"/></w:numPr>') +
      p(r('Odd'), '<w:numPr><w:ilvl w:val="x"/><w:numId w:val="1"/></w:numPr>');
    expect(extractOfficeText(docx(body))).toBe(`- Negative\n${'  '.repeat(8)}- Huge\n- Odd`);
  });

  it('ignores a tracked formatting change, which would otherwise override the paragraph style and list', () => {
    const change = '<w:pPrChange><w:pPr><w:pStyle w:val="Normal"/><w:numPr><w:ilvl w:val="3"/><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange>';
    expect(extractOfficeText(docx(p(r('Title'), `<w:pStyle w:val="Heading1"/>${change}`)))).toBe('# Title');
  });

  it('does not read a tab stop in a text-box paragraph as a tab character', () => {
    const box = p(r('Boxed'), '<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>');
    const body = p(`<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${box}</w:txbxContent></w:drawing></mc:Choice></mc:AlternateContent></w:r>${r('Outer')}`);
    expect(extractOfficeText(docx(body))).toBe('Boxed\nOuter');
  });
});

// Hostile input: linear time, and text that stops at the cap however the file is built.
describe('reading hostile Word files', () => {
  const FAST_MS = 5000;
  const cell = (text: string) => `<w:tc>${p(r(text))}</w:tc>`;
  /** Runs `fn`, checks it was fast, and reports the time when OTHERBENCH_TIMINGS is set. */
  function timed<T>(label: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const ms = performance.now() - start;
    if (process.env['OTHERBENCH_TIMINGS']) console.log(`[timing] ${label}: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(FAST_MS);
    return result;
  }

  it('reads a paragraph of millions of spaces between two characters in linear time', () => {
    const file = docx(p(`<w:r><w:t xml:space="preserve">a${' '.repeat(5_000_000)}b</w:t></w:r>`));
    const text = timed('5 MB of spaces', () => extractOfficeText(file))!;
    expect(text.startsWith('a')).toBe(true);
    expect(text.length).toBeLessThan(200);
  });

  it('reads 300 thousand empty paragraphs and a wide run of spaces in linear time', () => {
    const file = docx('<w:p/>'.repeat(300_000) + p(r('End')) + `<w:p><w:r><w:t xml:space="preserve">${' '.repeat(2_000_000)}</w:t></w:r></w:p>`);
    // Whitespace past the cap is still dropped as text that didn't fit, so the reading stops with a note.
    expect(timed('300k empty paragraphs', () => extractOfficeText(file))).toMatch(/^End\n\n\[OtherBench stopped reading here/);
  });

  it('reads a table of 200 thousand rows in linear time and cuts it at the cap', () => {
    const file = docx(`<w:tbl>${`<w:tr>${cell('x')}</w:tr>`.repeat(200_000)}</w:tbl>`);
    const text = timed('200k table rows', () => extractOfficeText(file, { maxChars: 20_000 }))!;
    // Past the cap by one character, so attachment-text's truncate() adds its marker.
    expect(text.length).toBe(20_001);
  });

  it.each([
    ['4 million <w:tr/>', '<w:tr/>'.repeat(4_000_000)],
    ['1 million <w:tr></w:tr>', '<w:tr></w:tr>'.repeat(1_000_000)],
  ])('reads %s (rows with no cells) in linear time and cuts the table at the cap', (label, rows) => {
    const file = docx(`<w:tbl>${rows}</w:tbl>${p(r('After'))}`);
    const text = timed(label, () => extractOfficeText(file, { maxChars: 20_000 }))!;
    // The table is cut at the cap with the stop note inside it; the paragraph after the table is never read.
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toMatch(/limit\.\]$/);
    expect(text).not.toContain('After');
  });

  it('keeps the stop note inside the cap, so truncate() has nothing to cut', () => {
    const file = docx(`<w:tbl>${`<w:tr>${cell('x')}</w:tr>`.repeat(2000)}<w:tr>${'<w:tc/>'.repeat(1_000_000)}</w:tr></w:tbl>`);
    const text = extractOfficeText(file, { maxChars: 20_000 })!;
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toMatch(/limit\.\]$/);
    const nearCap = extractOfficeText(docx(p(r('x'.repeat(19_990)) ) + p(r(' ')) + `<w:p><w:r><w:t xml:space="preserve">${' '.repeat(50_000)}</w:t></w:r></w:p>`), { maxChars: 20_000 })!;
    expect(nearCap.length).toBeLessThanOrEqual(20_000);
    expect(nearCap).toMatch(/limit\.\]$/);
  });

  it('reads a table row of a million cells under rows of one cell without building the padded table', () => {
    const file = docx(`<w:tbl>${`<w:tr>${cell('x')}</w:tr>`.repeat(2000)}<w:tr>${'<w:tc/>'.repeat(1_000_000)}</w:tr></w:tbl>${p(r('After'))}`);
    const text = timed('wide row', () => extractOfficeText(file, { maxChars: 20_000 }))!;
    expect(text.length).toBeLessThan(20_000 + 200);
    expect(text).toContain('left out the rest of this table');
  });

  it('reads tables nested 20 thousand deep in linear time, flattened into the outer cell', () => {
    const depth = 20_000;
    const file = docx('<w:tbl><w:tr><w:tc>'.repeat(depth) + p(r('Deep')) + '</w:tc></w:tr></w:tbl>'.repeat(depth));
    expect(timed('20k nested tables', () => extractOfficeText(file))).toBe('| Deep |\n| --- |');
  });

  it('reads paragraphs nested 100 thousand deep in linear time', () => {
    const depth = 100_000;
    const file = docx('<w:p><w:r><w:txbxContent>'.repeat(depth) + p(r('Deep')) + '</w:txbxContent></w:r></w:p>'.repeat(depth));
    expect(timed('100k nested paragraphs', () => extractOfficeText(file))).toBe('Deep');
  });

  it('cuts one huge paragraph at the cap', () => {
    const file = docx(p(Array.from({ length: 60 }, () => r('word '.repeat(10_000))).join('')));
    const text = timed('3 MB paragraph', () => extractOfficeText(file, { maxChars: 1000 }))!;
    // One character past the cap, so attachment-text's truncate() adds its marker.
    expect(text.length).toBe(1000 + 1);
    expect(text).toContain('word word');
  });

  it('cuts one huge table cell and one huge table at the cap', () => {
    const bigCell = docx(`<w:tbl><w:tr><w:tc>${Array.from({ length: 5000 }, () => p(r('word word'))).join('')}</w:tc></w:tr></w:tbl>${p(r('After'))}`);
    const cellText = timed('huge cell', () => extractOfficeText(bigCell, { maxChars: 1000 }))!;
    expect(cellText.length).toBeLessThanOrEqual(1000 + 1 + 100);
    expect(cellText).not.toContain('After');

    const bigTable = docx(`<w:tbl>${`<w:tr>${cell('word')}${cell('word')}</w:tr>`.repeat(5000)}</w:tbl>${p(r('After'))}`);
    const tableText = timed('huge table', () => extractOfficeText(bigTable, { maxChars: 1000 }))!;
    expect(tableText.length).toBeLessThanOrEqual(1000 + 1 + 100);
    expect(tableText).toContain('| word | word |');
    expect(tableText).not.toContain('After');
  });
});
