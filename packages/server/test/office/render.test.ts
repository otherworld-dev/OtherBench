import { describe, expect, it } from 'vitest';
import { checkOfficeContent, formulaForFile, MAX_DOCUMENT_CHARS, MAX_DOCUMENT_INDENT, MAX_DOCUMENT_LINES, MAX_DOCUMENT_MARKS, MAX_DOCUMENT_QUOTE_DEPTH, MAX_DOCUMENT_TABLE_CELLS, MAX_DOCUMENT_TABLE_ROWS } from '@grunt/core/domain/office-spec.js';
import { listZipEntries, readZipEntry } from '../../src/import/zip.js';
import { extractOfficeText } from '../../src/office/extract.js';
import { renderXlsx } from '../../src/office/xlsx.js';
// renderOfficeFile makes the file in a worker run from the compiled dist/office/render-worker.js: run `npx tsc -b` first.
import { OFFICE_RENDER_CONCURRENCY, OfficeRenderError, officeRenderWorkersRunning, renderOfficeFile, renderOfficeFileInProcess } from '../../src/office/render.js';

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
  }, 30_000);

  it('restarts the numbering for each numbered list', async () => {
    const doc = part(await renderOfficeFileInProcess('document', '1. One\n2. Two\n\nBetween\n\n1. Again', 'N'), 'word/document.xml');
    expect(new Set(doc.match(/<w:numId w:val="\d+"\/>/g)).size).toBe(2);
  });

  it('is A4 with 2.54 cm margins, in Calibri 11', async () => {
    const bytes = await renderOfficeFileInProcess('document', 'Text', 'Page');
    const doc = part(bytes, 'word/document.xml');
    expect(doc).toContain('w:w="11906"');
    expect(doc).toContain('w:h="16838"');
    expect(doc).toContain('w:top="1440"');
    const styles = part(bytes, 'word/styles.xml');
    expect(styles).toContain('Calibri');
    expect(styles).toContain('w:val="22"');
  });

  it('strips characters XML cannot hold, and keeps emoji and accents', async () => {
    const doc = part(await renderOfficeFileInProcess('document', 'Bad \u0001 char, Café 😀', 'T\u0002itle'), 'word/document.xml');
    expect(doc).not.toMatch(/[\u0001\u0002]/);
    expect(doc).toContain('Café 😀');
  });
});

describe('renderOfficeFile: document links, titles and size limits', () => {
  it('writes javascript: and relative links as plain text, with no relationship', async () => {
    const bytes = await renderOfficeFileInProcess('document', '[js](javascript:alert(1)) [rel](/etc/passwd) [frag](#top) [mail](mailto:a@example.com)', 'L');
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
    const core = part(await renderOfficeFileInProcess('document', 'Text', 'A <b> & "c"'), 'docProps/core.xml');
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
  }, 30_000);

  it.each([
    ['lines', Array.from({ length: MAX_DOCUMENT_LINES + 1 }, () => 'x').join('\n'), /6,001 lines.*at most 6,000 lines/],
    ['characters', 'a'.repeat(MAX_DOCUMENT_CHARS + 1), /characters.*at most 120,000 characters/],
    ['table rows', ['| a |', '|---|', ...Array.from({ length: MAX_DOCUMENT_TABLE_ROWS }, () => '| x |')].join('\n'), /table of more than 1,000 rows/],
    ['table cells', '|x'.repeat(MAX_DOCUMENT_TABLE_CELLS + 1), /table of more than 10,000 cells/],
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
    await expect(renderOfficeFileInProcess('presentation' as never, 'x', 'T')).rejects.toBeInstanceOf(OfficeRenderError);
  }, 30_000);
});

describe('renderOfficeFile: in a worker with a time and memory limit', () => {
  // Content the size checks pass but the Markdown parser takes far too long on (12 s to over 90 s in the request before).
  const nestedLists = `${'- '.repeat(20_000)}x`;

  it('stops a document that takes too long, with an OfficeRenderError, and leaves no worker running', async () => {
    expect(checkOfficeContent('document', nestedLists)).toBeNull();
    const start = Date.now();
    const error = await renderOfficeFile('document', nestedLists, 'Slow', { timeoutMs: 1500 }).catch((e: unknown) => e);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(error).toBeInstanceOf(OfficeRenderError);
    expect((error as Error).message).toBe('The document is too large or too complex to make in time: simplify it or split it into more than one artifact.');
    expect(officeRenderWorkersRunning()).toBe(0);
  }, 30_000);

  // Kept cheap with small worker limits (a test-only option): with Grunt's own limits these failures take 4-15 s of
  // CPU and sit on measured cliffs (3,000 levels of `- > ` overflow the stack, 4,000 the 512 MB heap).
  it('gives a worker that runs out of stack as an OfficeRenderError, and leaves no worker running', async () => {
    const limits = { resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 0.5 }, timeoutMs: 5000 };
    const deep = `${'- > '.repeat(1_000)}x`;
    expect(checkOfficeContent('document', deep)).toBeNull();
    const error = await renderOfficeFile('document', deep, 'Deep', limits).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfficeRenderError);
    expect((error as Error).message).toMatch(/Maximum call stack size exceeded|more memory than Grunt allows|too large or too complex to make in time/);
    expect(officeRenderWorkersRunning()).toBe(0);
  }, 30_000);

  it('gives a worker that runs out of memory as an OfficeRenderError, and leaves no worker running', async () => {
    const limits = { resourceLimits: { maxOldGenerationSizeMb: 16 }, timeoutMs: 10_000 };
    // The same tiny heap holds a one-line document: it's the content that runs it out.
    expect(extractOfficeText(await renderOfficeFile('document', '# Small', 'Small', limits))).toContain('# Small');
    const paragraphs = Array.from({ length: 500 }, (_, i) => `Paragraph ${i} with **bold** and a [link](https://example.com/${i}).`).join('\n\n');
    const error = await renderOfficeFile('document', paragraphs, 'Big', limits).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfficeRenderError);
    expect((error as Error).message).toBe('The document is too large or too complex to make: it needs more memory than Grunt allows. Simplify it or split it into more than one artifact.');
    expect(officeRenderWorkersRunning()).toBe(0);
  }, 30_000);

  it(`runs at most ${OFFICE_RENDER_CONCURRENCY} workers at once, starts each time limit when its worker starts, and loses no queued call when one ahead fails`, async () => {
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, officeRenderWorkersRunning())), 5);
    const nestedLists = `${'- '.repeat(20_000)}x`;
    const start = Date.now();
    const settled = await Promise.allSettled([
      // These two take both slots and fail on their time limit after 1.5 s.
      renderOfficeFile('document', nestedLists, 'Slow 1', { timeoutMs: 1500 }),
      renderOfficeFile('document', nestedLists, 'Slow 2', { timeoutMs: 1500 }),
      // Queued for 1.5 s: its own 1.5 s only counts once its worker starts.
      renderOfficeFile('document', '# Queued', 'Queued', { timeoutMs: 1500 }).then((bytes) => ({ bytes, ms: Date.now() - start })),
      renderOfficeFile('spreadsheet', '{"sheets":[]}', 'Sheet'),
    ]);
    clearInterval(sampler);
    expect(peak).toBe(OFFICE_RENDER_CONCURRENCY);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected', 'fulfilled', 'rejected']);
    for (const s of settled) if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(OfficeRenderError);
    const queued = (settled[2] as PromiseFulfilledResult<{ bytes: Buffer; ms: number }>).value;
    expect(extractOfficeText(queued.bytes)).toContain('# Queued');
    expect(queued.ms).toBeGreaterThanOrEqual(1500);
    expect((settled[3] as PromiseRejectedResult).reason.message).toBe('sheets: must be a list of 1-50 sheets');
    expect(officeRenderWorkersRunning()).toBe(0);
  }, 30_000);

  it('gives an error the renderer posts back as an OfficeRenderError', async () => {
    await expect(renderOfficeFile('spreadsheet', '{"sheets":[]}', 'S')).rejects.toThrow(new OfficeRenderError('sheets: must be a list of 1-50 sheets'));
    expect(officeRenderWorkersRunning()).toBe(0);
  }, 30_000);

  it('keeps the event loop free while a file is made', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    await renderOfficeFile('document', nestedLists, 'Slow', { timeoutMs: 1500 }).catch(() => undefined);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(10);
  }, 30_000);

  it('makes several files at once', async () => {
    const files = await Promise.all(['One', 'Two', 'Three'].map((t) => renderOfficeFile('document', `# ${t}`, t)));
    files.forEach((f, i) => expect(extractOfficeText(f)).toContain(`# ${['One', 'Two', 'Three'][i]}`));
    expect(officeRenderWorkersRunning()).toBe(0);
  }, 30_000);
});

describe('renderOfficeFile: spreadsheet', () => {
  const BUDGET = {
    sheets: [
      {
        name: 'Costs',
        columns: [{ width: 20 }, { width: 12 }],
        freeze: { rows: 1 },
        rows: [
          [{ value: 'Item', bold: true }, { value: 'Cost', bold: true }],
          ['Widgets', 12],
          ['Gadgets', 30.5],
          ['Total', '=SUM(B2:B3)'],
          ['When', { date: '2026-10-12' }],
          ['Literal', { value: '=not a formula' }],
          ['Flag', true],
          ['Café 😀', 'bad \u0001 char'],
        ],
      },
      { name: 'Second sheet', rows: [['Double', "='Costs'!B4*2"]] },
    ],
  };

  it('makes an .xlsx Excel calculates on open, with formulas written without their "="', async () => {
    const bytes = await renderOfficeFile('spreadsheet', JSON.stringify(BUDGET), 'Budget');
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    expect(part(bytes, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
    expect(part(bytes, 'xl/worksheets/sheet1.xml')).toContain('<f>SUM(B2:B3)</f>');
    const text = extractOfficeText(bytes)!;
    expect(text).toContain('Sheet "Costs" (A1:B8) as CSV:');
    for (const line of ['B4: =SUM(B2:B3)', 'When,2026-10-12', 'Literal,=not a formula', 'Flag,TRUE', 'Café 😀,bad  char', `B1: ='Costs'!B4*2`]) expect(text, line).toContain(line);
    expect(text).not.toContain('==');
    expect(text).not.toContain('\u0001');
  }, 30_000);

  it("refuses a source that doesn't parse, with the parse message", async () => {
    await expect(renderOfficeFile('spreadsheet', '{"sheets":', 'Broken')).rejects.toBeInstanceOf(OfficeRenderError);
    await expect(renderOfficeFile('spreadsheet', '{"sheets":[]}', 'Empty')).rejects.toThrow('sheets: must be a list of 1-50 sheets');
  }, 30_000);

  it('makes a workbook with an empty sheet', async () => {
    const text = extractOfficeText(await renderOfficeFile('spreadsheet', JSON.stringify({ sheets: [{ name: 'Blank', rows: [] }] }), 'B'))!;
    expect(text).toContain('Sheet "Blank"');
  }, 30_000);

  // parseSpreadsheet takes a `format` on any cell object, but the library only takes one on number, date and formula cells
  // (and "@" on text): any other would be a 422 at download with no cell reference, so it's left out there.
  it('makes the file when a cell has a number format its type cannot use, and the values read back', async () => {
    const row = (cell: unknown) => ['x', cell];
    const rows = [
      row({ value: 'abc', format: '0.00' }),
      row({ value: 'def', format: '@' }),
      row({ value: '', format: '0.00' }),
      row({ value: true, format: '0.00' }),
      row({ bold: true, format: '0.00' }),
      row({ value: null, format: '0.00' }),
      row({ value: 12.5, format: '#,##0.0000' }),
      row({ date: '2026-10-12', format: 'dd/mm/yyyy' }),
      row({ formula: 'SUM(1,2)', format: '0.00' }),
      row({ value: 'bold text', bold: true, align: 'right' }),
    ];
    const bytes = await renderOfficeFileInProcess('spreadsheet', JSON.stringify({ sheets: [{ name: 'F', rows }] }), 'F');
    const text = extractOfficeText(bytes)!;
    for (const line of ['x,abc', 'x,def', 'x,TRUE', 'x,12.5', 'x,2026-10-12', 'B9: =SUM(1,2)', 'x,bold text']) expect(text, line).toContain(line);
    const styles = part(bytes, 'xl/styles.xml');
    for (const format of ['#,##0.0000', 'dd/mm/yyyy']) expect(styles, format).toContain(format);
    // The same through the worker, which is what Download uses.
    expect(extractOfficeText(await renderOfficeFile('spreadsheet', JSON.stringify({ sheets: [{ name: 'F', rows }] }), 'F'))).toContain('x,abc');
  }, 30_000);

  // Every formula is written as exactly the text core checked (formulaForFile): no "=", canonical function names with Excel's file
  // prefixes, everything else as given. Read back out of the sheet XML, each <f> is compared with formulaForFile's own text.
  const ROUND_TRIP_FORMULAS = [
    '=SUM(B2:B3)',
    'SUM(B2:B3)',
    "='Second sheet'!B1*2",
    '=XLOOKUP(A1,B1:B5,C1:C5)',
    '=_xlfn.XLOOKUP(A1,B1:B5,C1:C5)',
    '=FILTER(A1:A9,B1:B9>0)',
    '=sum(a1:a3)',
    '=IF(A1<B1,"a & b","<>")',
    '=IF(A1="say ""hi""","x","y")',
    '=A1&" & "&B1',
    '=IF(A1>1,"café 😀","")',
    '=IFERROR(VLOOKUP(A1,$A$1:$C$9,2,FALSE),"none")',
    '=SUM(A1:A3,\n  B1)',
    '=SUM(A1,\r\n  B1)',
    '=IF(A1,"two\nlines","one")',
    '=TEXTJOIN(", ",TRUE,A1:A9)',
    '=COUNTIF(A1:A9,">5")',
    '=IF(A1,"a\rb\r\nc","d")',
    '=A1&"\u0085 \u007f \u0090 \ufffd"',
  ];

  const unescapeXml = (s: string): string =>
    s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'amp') return '&';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });

  it('writes the text of every formula exactly as formulaForFile gives it', async () => {
    const names = new Set(['Costs', 'Second sheet']);
    const rows = ROUND_TRIP_FORMULAS.map((f, i) => (i % 2 === 0 ? [f] : [{ formula: f }]));
    const source = JSON.stringify({ sheets: [{ name: 'Costs', rows }, { name: 'Second sheet', rows: [['x']] }] });
    const xml = part(await renderOfficeFile('spreadsheet', source, 'F'), 'xl/worksheets/sheet1.xml');
    const written = [...xml.matchAll(/<f>([\s\S]*?)<\/f>/g)].map((m) => unescapeXml(m[1]!));
    expect(written).toHaveLength(ROUND_TRIP_FORMULAS.length);
    ROUND_TRIP_FORMULAS.forEach((formula, i) => {
      const expected = formulaForFile(formula, names);
      expect(expected.ok, formula).toBe(true);
      expect(written[i], JSON.stringify(formula)).toBe((expected as { text: string }).text);
    });
    expect(written[3]).toBe('_xlfn.XLOOKUP(A1,B1:B5,C1:C5)');
    expect(written[5]).toBe('_xlfn._xlws.FILTER(A1:A9,B1:B9>0)');
    expect(xml).not.toMatch(/<f>=/);
    // An XML reader turns a literal CR into LF, so a CR in a formula has to be written as a character reference.
    expect(xml).not.toContain('\r');
    expect(xml).toContain('&#13;');
    expect(written[13]).toContain('\r\n');
  }, 30_000);

  it("won't write a formula formulaForFile refuses, with its message (a spec that never went through parseSpreadsheet)", async () => {
    const spec = { sheets: [{ name: 'S', rows: [['=SUM(']] }] };
    const refused = formulaForFile('=SUM(', new Set(['S']));
    expect(refused.ok).toBe(false);
    await expect(renderXlsx(spec)).rejects.toBeInstanceOf(OfficeRenderError);
    await expect(renderXlsx(spec)).rejects.toThrow((refused as { error: string }).error);
    await expect(renderXlsx({ sheets: [{ name: 'S', rows: [[{ formula: 'NOSUCHFUNCTION(1)' }]] }] })).rejects.toThrow(/NOSUCHFUNCTION/);
  });
});
