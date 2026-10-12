import { describe, expect, it } from 'vitest';
import { checkOfficeContent, MAX_DOCUMENT_CHARS, MAX_DOCUMENT_INDENT, MAX_DOCUMENT_LINES, MAX_DOCUMENT_MARKS, MAX_DOCUMENT_QUOTE_DEPTH, MAX_DOCUMENT_TABLE_ROWS } from '@grunt/core/domain/office-spec.js';
import { listZipEntries, readZipEntry } from '../../src/import/zip.js';
import { extractOfficeText } from '../../src/office/extract.js';
import { OfficeRenderError, renderOfficeFile } from '../../src/office/render.js';

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

describe('renderOfficeFile: document links, titles and size limits', () => {
  it('writes javascript: and relative links as plain text, with no relationship', async () => {
    const bytes = await renderOfficeFile('document', '[js](javascript:alert(1)) [rel](/etc/passwd) [frag](#top) [mail](mailto:a@example.com)', 'L');
    const doc = part(bytes, 'word/document.xml');
    const rels = part(bytes, 'word/_rels/document.xml.rels');
    expect(extractOfficeText(bytes)).toContain('js rel frag');
    expect(rels).not.toContain('javascript');
    expect(rels).not.toContain('/etc/passwd');
    expect(rels).not.toContain('#top');
    expect(rels).toContain('mailto:a@example.com');
    expect(doc.match(/<w:hyperlink /g)).toHaveLength(1);
  });

  it('escapes a title with markup characters in the file properties', async () => {
    const core = part(await renderOfficeFile('document', 'Text', 'A <b> & "c"'), 'docProps/core.xml');
    expect(core).toContain('A &lt;b&gt; &amp; &quot;c&quot;');
    expect(core).not.toContain('<b>');
  });

  it('refuses 10,000 nested quotes as an OfficeRenderError', async () => {
    await expect(renderOfficeFile('document', `${'>'.repeat(10_000)} q`, 'Q')).rejects.toBeInstanceOf(OfficeRenderError);
    await expect(renderOfficeFile('document', `${'>'.repeat(10_000)} q`, 'Q')).rejects.toThrow(/quoted 10,000 levels deep/);
  });

  /** Content that sits just under every limit at once (about 100 KB). */
  function worstCase(): string {
    const table = ['| a | b | c |', '|---|---|---|', ...Array.from({ length: 997 }, (_, r) => `| row ${r} | ${r} | **x** |`)].join('\n');
    const list = Array.from({ length: 800 }, (_, i) => `${' '.repeat((i % 13) * 2)}- item ${i}`).join('\n');
    const quote = Array.from({ length: 800 }, (_, i) => `${'> '.repeat(MAX_DOCUMENT_QUOTE_DEPTH)}quoted ${i}`).join('\n');
    const paras = Array.from({ length: 500 }, (_, i) => `Paragraph ${i} with *emphasis* and a [link](https://example.com/${i}).`).join('\n\n');
    return [table, list, quote, paras].join('\n\n');
  }

  it('makes a document just under every limit at once, in a few seconds at most', async () => {
    const md = worstCase();
    expect(checkOfficeContent('document', md)).toBeNull();
    expect(md.length).toBeLessThanOrEqual(MAX_DOCUMENT_CHARS);
    const start = Date.now();
    const bytes = await renderOfficeFile('document', md, 'Big');
    expect(Date.now() - start).toBeLessThan(5000);
    expect(extractOfficeText(bytes)).toContain('Paragraph 499');
  });

  it.each([
    ['lines', Array.from({ length: MAX_DOCUMENT_LINES + 1 }, () => 'x').join('\n'), /6,001 lines.*at most 6,000 lines/],
    ['characters', 'a'.repeat(MAX_DOCUMENT_CHARS + 1), /characters.*at most 120,000 characters/],
    ['table rows', ['| a |', '|---|', ...Array.from({ length: MAX_DOCUMENT_TABLE_ROWS }, () => '| x |')].join('\n'), /table of more than 1,000 rows/],
    ['indent', `${' '.repeat(MAX_DOCUMENT_INDENT + 1)}- deep`, /indented 25 columns.*at most 24 columns/],
    ['quote depth', `${'>'.repeat(MAX_DOCUMENT_QUOTE_DEPTH + 1)} q`, /quoted 9 levels deep.*at most 8 levels deep/],
    ['marks', '*'.repeat(MAX_DOCUMENT_MARKS + 1), /more than 10,000 formatting marks/],
  ])('refuses a document over the %s limit with an OfficeRenderError that names it', async (_name, md, message) => {
    const error = await renderOfficeFile('document', md, 'Over').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfficeRenderError);
    expect((error as Error).message).toMatch(message);
  });

  it('refuses hostile tables and paragraph floods promptly, before parsing', async () => {
    const rows = Array.from({ length: 8000 }, (_, r) => `| a${r} | b | c | d | e |`);
    const table = ['| h | h | h | h | h |', '|---|---|---|---|---|', ...rows].join('\n');
    const paragraphs = Array.from({ length: 160_000 }, (_, i) => `p${i}`).join('\n\n');
    for (const md of [table, paragraphs]) {
      const start = Date.now();
      await expect(renderOfficeFile('document', md, 'Hostile')).rejects.toBeInstanceOf(OfficeRenderError);
      expect(Date.now() - start).toBeLessThan(1000);
    }
  });

  it('refuses an unknown kind instead of returning nothing', async () => {
    await expect(renderOfficeFile('presentation' as never, 'x', 'T')).rejects.toBeInstanceOf(OfficeRenderError);
  });
});
