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
});
