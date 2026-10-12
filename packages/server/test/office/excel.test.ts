import { describe, expect, it } from 'vitest';
import { isDateFormatCode, serialToIso } from '../../src/office/excel.js';
import { extractOfficeText } from '../../src/office/extract.js';
import { makeZip, type ZipFixtureEntry } from '../import/make-zip.js';

interface SheetFixture {
  name: string;
  rows?: string;
  state?: string;
  chart?: boolean;
  partName?: string;
}

function xlsx(opts: { sheets: SheetFixture[]; shared?: string; styles?: string; date1904?: boolean; absoluteTargets?: boolean }): Buffer {
  const workbook = `<workbook xmlns="main" xmlns:r="rels"><workbookPr${opts.date1904 ? ' date1904="1"' : ''}/><sheets>${opts.sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`;
  const base = opts.absoluteTargets ? '/xl/' : '';
  const rels = `<Relationships xmlns="r">${opts.sheets
    .map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${s.chart ? 'chartsheet' : 'worksheet'}" Target="${base}${s.chart ? 'chartsheets' : 'worksheets'}/sheet${i + 1}.xml"/>`)
    .join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="${base}sharedStrings.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="${base}styles.xml"/></Relationships>`;
  const entries: ZipFixtureEntry[] = [
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: rels },
    ...opts.sheets.map((s, i) => ({ name: s.partName ?? `xl/${s.chart ? 'chartsheets' : 'worksheets'}/sheet${i + 1}.xml`, content: `<worksheet xmlns="main"><sheetData>${s.rows ?? ''}</sheetData></worksheet>` })),
  ];
  if (opts.shared) entries.push({ name: 'xl/sharedStrings.xml', content: `<sst xmlns="main">${opts.shared}</sst>` });
  if (opts.styles) entries.push({ name: 'xl/styles.xml', content: `<styleSheet xmlns="main">${opts.styles}</styleSheet>` });
  return makeZip(entries);
}

describe('reading Excel files', () => {
  it('reads shared and inline strings, booleans and errors as CSV, keeping empty rows so line N is row N', () => {
    const rows =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Cost, total</t></is></c></row>' +
      '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="e"><v>#DIV/0!</v></c><c r="C3" t="s"><v>1</v></c></row>';
    const shared = '<si><t>Item</t><rPh sb="0" eb="1"><t>アイテム</t></rPh></si><si><t>He said "hi"</t></si>';
    expect(extractOfficeText(xlsx({ sheets: [{ name: 'Costs', rows }], shared }))).toBe(
      ['Sheet "Costs" (A1:C3) as CSV:', 'Item,"Cost, total",', '', 'TRUE,#DIV/0!,"He said ""hi"""'].join('\n')
    );
  });

  it('shows date-formatted numbers as dates, from built-in and custom formats, under both epochs', () => {
    const styles =
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/><numFmt numFmtId="165" formatCode="&quot;Days: &quot;0"/></numFmts>' +
      '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs>';
    const rows1900 = '<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45000.5</v></c><c r="C1" s="0"><v>45000</v></c><c r="D1" s="3"><v>5</v></c></row>';
    expect(extractOfficeText(xlsx({ sheets: [{ name: 'D', rows: rows1900 }], styles }))).toBe('Sheet "D" (A1:D1) as CSV:\n2023-03-15,2023-03-15 12:00,45000,5');
    const rows1904 = '<row r="1"><c r="A1" s="1"><v>43538</v></c></row>';
    expect(extractOfficeText(xlsx({ sheets: [{ name: 'D', rows: rows1904 }], styles, date1904: true }))).toBe('Sheet "D" (A1:A1) as CSV:\n2023-03-15');
  });

  it('lists formulas with their values, and shared formulas by the cell they come from', () => {
    const rows =
      '<row r="2"><c r="B2"><v>12</v></c></row><row r="3"><c r="B3"><v>30.5</v></c></row>' +
      '<row r="4"><c r="B4"><f t="shared" ref="B4:B5" si="0">SUM(B2:B3)</f><v>42.5</v></c></row>' +
      '<row r="5"><c r="B5"><f t="shared" si="0"/><v>30.5</v></c></row>' +
      '<row r="6"><c r="B6" t="str"><f>"x"&amp;"y"</f><v>xy</v></c></row>' +
      '<row r="7"><c r="B7"><f>NOW()</f></c></row>';
    const text = extractOfficeText(xlsx({ sheets: [{ name: 'Costs', rows }] }))!;
    expect(text.split('\n').slice(-5)).toEqual([
      'Formulas in "Costs":',
      'B4: =SUM(B2:B3) (value 42.5)',
      'B5: shared formula from B4',
      'B6: ="x"&"y" (value xy)',
      'B7: =NOW()',
    ]);
  });

  it('marks a hidden sheet, names a chart sheet, and keeps the workbook order', () => {
    const one = '<row r="1"><c r="A1"><v>1</v></c></row>';
    const text = extractOfficeText(xlsx({ sheets: [{ name: 'Visible', rows: one }, { name: 'Secret', state: 'hidden', rows: one }, { name: 'Chart1', chart: true }, { name: 'Blank' }] }));
    expect(text).toBe(
      ['Sheet "Visible" (A1:A1) as CSV:', '1', '', 'Sheet "Secret" (A1:A1), hidden as CSV:', '1', '', 'Sheet "Chart1" is a chart.', '', 'Sheet "Blank" is empty.'].join('\n')
    );
  });

  it('reads sheets written without r attributes, with absolute targets and part names in another case', () => {
    const rows = '<row><c t="inlineStr"><is><t>a</t></is></c><c><v>2</v></c></row><row><c><v>3</v></c></row>';
    const text = extractOfficeText(xlsx({ sheets: [{ name: 'S', rows, partName: 'xl/worksheets/Sheet1.xml' }], absoluteTargets: true }));
    expect(text).toBe('Sheet "S" (A1:B2) as CSV:\na,2\n3,');
  });

  // The reader stops once the text is full, so the range in the heading comes from the sheet's own <dimension> (Excel writes one) rather than from rows it never read.
  it('stops at the character cap', () => {
    const rows = '<dimension ref="A1:A500"/>' + Array.from({ length: 500 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    const text = extractOfficeText(xlsx({ sheets: [{ name: 'Big', rows }] }), { maxChars: 150 })!;
    expect(text.startsWith('Sheet "Big" (A1:A500) as CSV:\n0\n1')).toBe(true);
    expect(text).not.toContain('\n499');
  });

  it('stops at the character cap in a sheet with no dimension, with the range of what it read', () => {
    const rows = Array.from({ length: 500 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    const text = extractOfficeText(xlsx({ sheets: [{ name: 'Big', rows }] }), { maxChars: 150 })!;
    expect(text).toMatch(/^Sheet "Big" \(A1:A\d+\) as CSV:\n0\n1\n/);
    expect(text.length).toBeLessThanOrEqual(151);
    expect(text).not.toContain('\n499');
  });

  it('leaves out columns past the 200th and says so, and also for a sheet of only such cells', () => {
    const rows = '<row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>';
    expect(extractOfficeText(xlsx({ sheets: [{ name: 'W', rows }] }))).toBe('Sheet "W" (A1:A1) as CSV:\n1\n(Columns after GR were left out.)');
    expect(extractOfficeText(xlsx({ sheets: [{ name: 'W', rows: '<row r="1"><c r="XFD1"><v>2</v></c></row>' }] }))).toBe('Sheet "W" has cells only past column GR, which Grunt leaves out.');
  });

  it('shows a date-styled number that Excel could not show as a date as the number', () => {
    const styles = '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>';
    const rows = '<row r="1"><c r="A1" s="1"><v>1e300</v></c><c r="B1" s="1"><v>-5</v></c><c r="C1" s="1"><v>abc</v></c></row>';
    expect(extractOfficeText(xlsx({ sheets: [{ name: 'D', rows }], styles }))).toBe('Sheet "D" (A1:C1) as CSV:\n1e300,-5,abc');
  });

  it('puts a cell with a reference outside a worksheet, and a huge r, where the order puts it', () => {
    const rows = '<row r="99999999999999999999"><c><v>1</v></c></row><row r="2"><c r="A99999999"><v>2</v></c><c r="AAAA1"><v>3</v></c><c r="ZZZ1"><v>4</v></c></row>';
    expect(extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }] }))).toBe('Sheet "S" (A1:C2) as CSV:\n1,,\n2,3,4');
  });
});

describe('isDateFormatCode', () => {
  it('ignores quoted text, [..] sections and escaped characters', () => {
    expect(isDateFormatCode('yyyy-mm-dd')).toBe(true);
    expect(isDateFormatCode('[h]:mm:ss')).toBe(true);
    expect(isDateFormatCode('"Days: "0')).toBe(false);
    expect(isDateFormatCode('[Red]#,##0.00')).toBe(false);
    expect(isDateFormatCode('0\\d')).toBe(false);
    expect(isDateFormatCode('General')).toBe(false);
    expect(isDateFormatCode('0 "s" d')).toBe(true);
    expect(isDateFormatCode('"unterminated d')).toBe(false);
  });
});

describe('serialToIso', () => {
  it('counts from 1900 (with its leap-year bug) or 1904', () => {
    expect(serialToIso(1, false)).toBe('1900-01-01');
    expect(serialToIso(45000, false)).toBe('2023-03-15');
    expect(serialToIso(45000.25, false)).toBe('2023-03-15 06:00');
    expect(serialToIso(0, true)).toBe('1904-01-01');
  });

  it('gives the number back when it is no date, instead of throwing', () => {
    for (const n of [1e300, -1, Infinity, NaN]) expect(() => serialToIso(n, false)).not.toThrow();
    expect(serialToIso(1e300, false)).toBe('1e+300');
  });
});

// Hostile input: linear time, and text that stops at the cap however the file is built.
describe('reading hostile Excel files', () => {
  const FAST_MS = 2000;
  const CAP = 100_000;
  /** Runs `fn`, checks it was fast, and reports the time when GRUNT_TIMINGS is set. */
  function timed<T>(label: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const ms = performance.now() - start;
    if (process.env['GRUNT_TIMINGS']) console.log(`[timing] ${label}: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(FAST_MS);
    return result;
  }
  const dateStyle = (formatCode: string) => `<numFmts count="1"><numFmt numFmtId="164" formatCode="${formatCode}"/></numFmts><cellXfs count="1"><xf numFmtId="164"/></cellXfs>`;
  const dateRow = '<row r="1"><c r="A1" s="0"><v>45000</v></c></row>';

  it.each([
    ['1M unterminated quotes', '&quot;'.repeat(1_000_000)],
    ['1M unterminated brackets', '['.repeat(1_000_000)],
    ['1M backslashes', '\\'.repeat(1_000_000)],
    ['500k alternating quotes and brackets', '&quot;['.repeat(500_000)],
  ])('reads a number format of %s in linear time', (label, code) => {
    const file = xlsx({ sheets: [{ name: 'S', rows: dateRow }], styles: dateStyle(code) });
    expect(timed(label, () => extractOfficeText(file))).toBe('Sheet "S" (A1:A1) as CSV:\n45000');
  });

  it('reads a number format of 300 thousand quoted strings that ends in a date code', () => {
    const file = xlsx({ sheets: [{ name: 'S', rows: dateRow }], styles: dateStyle(`${'&quot;x&quot;'.repeat(300_000)}yyyy`) });
    expect(timed('300k quoted strings then yyyy', () => extractOfficeText(file))).toBe('Sheet "S" (A1:A1) as CSV:\n2023-03-15');
  });

  it('reads a sheet whose only cell is in row 1048576 without looping past the cap', () => {
    const rows = '<row r="1048576"><c r="A1048576"><v>1</v></c></row>';
    const text = timed('row 1048576', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }] })))!;
    expect(text.startsWith('Sheet "S" (A1:A1048576) as CSV:')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(CAP + 1);
  });

  it('reads a row with a huge r and no cells as nothing', () => {
    const text = timed('huge r', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows: '<row r="99999999999999999999"/><row r="1048577"/>' }] })));
    expect(text).toBe('Sheet "S" is empty.');
  });

  it('reads 200 thousand cells in one row in linear time, keeping 200 columns', () => {
    const rows = `<row r="1">${'<c><v>1</v></c>'.repeat(200_000)}</row>`;
    const text = timed('200k cells in a row', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }] })))!;
    expect(text).toBe(`Sheet "S" (A1:GR1) as CSV:\n${Array.from({ length: 200 }, () => '1').join(',')}\n(Columns after GR were left out.)`);
  });

  it('reads 200 thousand cells in 200 thousand rows in linear time and stops at the cap', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    const text = timed('200k rows', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }] })))!;
    expect(text.length).toBeLessThanOrEqual(CAP + 1);
    expect(text).toMatch(/^Sheet "S" \(A1:A\d+\) as CSV:\n0\n1\n/);
  });

  it('reads 200 thousand cells that all say A1 in linear time, without calling the text cut', () => {
    const rows = `<row r="1">${'<c r="A1"><v>1</v></c>'.repeat(200_000)}</row>`;
    expect(timed('200k cells at A1', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }] })))).toBe('Sheet "S" (A1:A1) as CSV:\n1');
  });

  it('reads 200 thousand formulas in linear time and stops at the cap', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><f>SUM(B${i + 1})</f></c></row>`).join('');
    const text = timed('200k formulas', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }] }), { maxChars: 20_000 }));
    expect(text === null || text.length <= 20_001).toBe(true);
  });

  it.each([
    ['an inline string', (v: string) => `<row r="1"><c r="A1" t="inlineStr"><is><t>${v}</t></is></c></row>`, undefined],
    ['a value', (v: string) => `<row r="1"><c r="A1" t="str"><v>${v}</v></c></row>`, undefined],
    ['a formula', (v: string) => `<row r="1"><c r="A1"><f>${v}</f></c></row>`, undefined],
    ['a shared string', () => '<row r="1"><c r="A1" t="s"><v>0</v></c></row>', (v: string) => `<si><t>${v}</t></si>`],
  ])('reads %s of 4 MB in linear time and cuts it at the cap', (label, row, shared) => {
    const big = 'x'.repeat(4_000_000);
    const file = xlsx({ sheets: [{ name: 'S', rows: row(big) }], shared: shared?.(big) });
    const text = timed(`4 MB in ${label}`, () => extractOfficeText(file, { maxChars: 1000 }))!;
    expect(text.length).toBeLessThanOrEqual(1001);
  });

  it('reads 300 thousand shared strings in linear time', () => {
    const shared = Array.from({ length: 300_000 }, (_, i) => `<si><t>s${i}</t></si>`).join('');
    const rows = '<row r="1"><c r="A1" t="s"><v>299999</v></c><c r="B1" t="s"><v>5</v></c><c r="C1" t="s"><v>-1</v></c></row>';
    expect(timed('300k shared strings', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }], shared })))).toBe('Sheet "S" (A1:B1) as CSV:\ns299999,s5');
  });

  it('reads 200 thousand cells that all point to one 20 KB shared string, stopping at the cap', () => {
    const shared = `<si><t>${'y'.repeat(20_000)}</t></si>`;
    const rows = `<row r="1">${'<c t="s"><v>0</v></c>'.repeat(200_000)}</row>`;
    const text = timed('one shared string x 200k', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }], shared }), { maxChars: 50_000 }))!;
    expect(text.length).toBeLessThanOrEqual(50_001);
  });

  it('reads 50 thousand sheets that are all the same part, stopping at the cap', () => {
    const names = Array.from({ length: 50_000 }, (_, i) => `<sheet name="n${i}" sheetId="${i + 1}" r:id="rId1"/>`).join('');
    const file = makeZip([
      { name: 'xl/workbook.xml', content: `<workbook xmlns:r="r"><sheets>${names}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' },
    ]);
    const text = timed('50k sheets', () => extractOfficeText(file))!;
    expect(text.length).toBeLessThanOrEqual(CAP + 100);
  });

  it('reads 100 thousand unclosed cells in linear time', () => {
    const rows = `<row r="1">${'<c r="A1"><v>1'.repeat(100_000)}</row>`;
    expect(timed('unclosed cells', () => extractOfficeText(xlsx({ sheets: [{ name: 'S', rows }] })))).toBe('Sheet "S" is empty.');
  });
});
