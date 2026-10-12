import { describe, expect, it } from 'vitest';
import { listZipEntries, readZipEntry } from '../../src/import/zip.js';
import { extractOfficeText } from '../../src/office/extract.js';
import { renderOfficeFile } from '../../src/office/render.js';

/** One part of a made file, as text. */
function part(zip: Buffer, name: string): string {
  const entry = listZipEntries(zip).find((e) => e.name === name);
  if (!entry) throw new Error(`${name} isn't in the file: ${listZipEntries(zip).map((e) => e.name).join(', ')}`);
  return readZipEntry(zip, entry, 64 * 1024 * 1024).toString('utf8');
}

describe('renderOfficeFile: document', () => {
  it('makes a .docx that reads back with its headings, lists, table, code and links, without HTML or fetched images', async () => {
    const md = [
      '# Quarterly memo',
      '',
      'Sales are **up** and ~~down~~, see [the site](https://example.com) or [a file](file:///C:/secret.txt).',
      '',
      '- First',
      '  - Nested',
      '- [x] Done',
      '',
      '| Item | Cost |',
      '| --- | ---: |',
      '| Widgets | 12 |',
      '',
      '```',
      'const a = 1;',
      '```',
      '',
      '> Quoted',
      '',
      '![chart](https://example.com/c.png)',
      '',
      '<script>alert(1)</script>',
    ].join('\n');
    const bytes = await renderOfficeFile('document', md, 'Memo');
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    const text = extractOfficeText(bytes)!;
    for (const line of ['# Quarterly memo', '- First', '  - Nested', '- ☒ Done', '| Item | Cost |', '| Widgets | 12 |', 'const a = 1;', 'Quoted', '[Image: chart]']) expect(text, line).toContain(line);
    expect(text).not.toContain('alert(1)');
    const rels = part(bytes, 'word/_rels/document.xml.rels');
    expect(rels).toContain('https://example.com');
    expect(rels).not.toContain('file:///');
    expect(rels).not.toContain('c.png');
    expect(part(bytes, 'docProps/core.xml')).toContain('Memo');
  });

  it('restarts the numbering for each numbered list', async () => {
    const doc = part(await renderOfficeFile('document', '1. One\n2. Two\n\nBetween\n\n1. Again', 'N'), 'word/document.xml');
    expect(new Set(doc.match(/<w:numId w:val="\d+"\/>/g)).size).toBe(2);
  });

  it('is A4 with 2.54 cm margins, in Calibri 11', async () => {
    const bytes = await renderOfficeFile('document', 'Text', 'Page');
    const doc = part(bytes, 'word/document.xml');
    expect(doc).toContain('w:w="11906"');
    expect(doc).toContain('w:h="16838"');
    expect(doc).toContain('w:top="1440"');
    const styles = part(bytes, 'word/styles.xml');
    expect(styles).toContain('Calibri');
    expect(styles).toContain('w:val="22"');
  });

  it('strips characters XML cannot hold, and keeps emoji and accents', async () => {
    const doc = part(await renderOfficeFile('document', 'Bad \u0001 char, Café 😀', 'T\u0002itle'), 'word/document.xml');
    expect(doc).not.toMatch(/[\u0001\u0002]/);
    expect(doc).toContain('Café 😀');
  });
});
