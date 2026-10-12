import { describe, expect, it } from 'vitest';
import { checkOfficeContent, columnName, isOfficeKind, OFFICE_GUIDANCE, parseCellDate, parseSpreadsheet, xmlSafe, type SpreadsheetSpec } from '../src/domain/office-spec.js';

const sheet = (rows: unknown[][], extra: Record<string, unknown> = {}) => JSON.stringify({ sheets: [{ name: 'Costs', rows, ...extra }] });
function errorOf(content: string): string {
  const parsed = parseSpreadsheet(content);
  if (parsed.ok) throw new Error(`expected an error for ${content.slice(0, 80)}`);
  return parsed.error;
}

describe('parseSpreadsheet', () => {
  it('parses a good workbook as given', () => {
    const spec: SpreadsheetSpec = {
      sheets: [
        {
          name: 'Costs',
          columns: [{ width: 24 }, {}],
          freeze: { rows: 1 },
          rows: [
            [{ value: 'Item', bold: true }, { value: 'Cost', bold: true, align: 'right', fill: '#DDEBF7' }],
            ['Widgets', 12],
            ['Gadgets', 30.5],
            ['Total', '=SUM(B2:B3)'],
            [null, { date: '2026-10-12T09:30' }, { formula: "'Second sheet'!B1*2", format: '#,##0.00' }, true],
          ],
        },
        { name: 'Second sheet', rows: [['x', 1]] },
      ],
    };
    expect(parseSpreadsheet(JSON.stringify(spec))).toEqual({ ok: true, spec });
  });

  it('names the JSON path of each problem', () => {
    expect(errorOf('{')).toMatch(/^The content isn't valid JSON/);
    expect(errorOf('[]')).toMatch(/^The content must be a JSON object/);
    expect(errorOf(JSON.stringify({ sheets: [] }))).toBe('sheets: must be a list of 1-50 sheets');
    expect(errorOf(JSON.stringify({ sheets: [{ name: 'a:b', rows: [] }] }))).toMatch(/^sheets\[0\]\.name: /);
    expect(errorOf(JSON.stringify({ sheets: [{ name: 'x'.repeat(32), rows: [] }] }))).toMatch(/^sheets\[0\]\.name: /);
    expect(errorOf(JSON.stringify({ sheets: [{ name: "'quoted", rows: [] }] }))).toMatch(/^sheets\[0\]\.name: /);
    expect(errorOf(JSON.stringify({ sheets: [{ name: 'Costs', rows: [] }, { name: 'costs', rows: [] }] }))).toBe(
      'sheets[1].name: "costs" is used by another sheet (names are compared ignoring case)'
    );
    expect(errorOf(sheet([[{ value: 1, fill: 'red' }]]))).toBe('sheets[0].rows[0][0].fill: must be a colour as #RRGGBB');
    expect(errorOf('{"sheets":[{"name":"Costs","rows":[[1e999]]}]}')).toBe('sheets[0].rows[0][0]: numbers must be finite');
    expect(errorOf(sheet([[{ value: 1, formula: 'A1' }]]))).toBe('sheets[0].rows[0][0]: has "value" and "formula": give at most one of value, formula and date');
    expect(errorOf(JSON.stringify({ sheets: [{ name: 'Costs', rows: [], colums: [] }] }))).toBe('sheets[0]: unknown key "colums". Allowed: name, columns, freeze, rows.');
    expect(errorOf(sheet([[{ date: '2026-02-30' }]]))).toMatch(/^sheets\[0\]\.rows\[0\]\[0\]\.date: /);
    expect(errorOf(sheet([[{ value: 'x', bold: 'yes' }]]))).toBe('sheets[0].rows[0][0].bold: must be true or false');
    expect(errorOf(sheet([['x'.repeat(32_768)]]))).toMatch(/^sheets\[0\]\.rows\[0\]\[0\]: is over Excel's 32767 characters a cell/);
  });

  it('checks formulas: balance, quotes, sheet names and the refused functions', () => {
    expect(errorOf(sheet([[], [], [], ['Total', '=SUM(B2:B3']]))).toBe('sheets[0].rows[3][1]: "=SUM(B2:B3" has an unclosed parenthesis');
    expect(errorOf(sheet([['=SUM(A1))']]))).toMatch(/has a "\)" with no "\(" before it/);
    expect(errorOf(sheet([['="abc']]))).toMatch(/has an unclosed double quote/);
    expect(errorOf(sheet([['=Nope!A1']]))).toMatch(/refers to sheet "Nope", which isn't in the workbook/);
    expect(errorOf(sheet([["='No such'!A1"]]))).toMatch(/refers to sheet "No such"/);
    for (const f of ['WEBSERVICE("https://x")', '_xlfn.WEBSERVICE("https://x")', 'FILTERXML(A1,"//a")', 'IMAGE("https://x/a.png")', 'hyperlink("https://x")', 'RTD("a",,"b")', 'CALL("a","b")', 'REGISTER("a")', 'REGISTER.ID("a","b")', 'EXEC("calc")']) {
      expect(errorOf(sheet([[`=${f}`]])), f).toMatch(/which Grunt refuses/);
    }
    expect(errorOf(sheet([["=cmd|' /C calc'!A0"]]))).toMatch(/uses "\|"/);
    expect(errorOf(sheet([['=[Book2.xlsx]Sheet1!A1']]))).toMatch(/uses "\["/);
    expect(errorOf(sheet([[{ formula: 'SUM(' }]]))).toMatch(/^sheets\[0\]\.rows\[0\]\[0\]\.formula: /);
  });

  it('reads a long formula in one pass, whatever it is made of', () => {
    const formulas = ['=1' + 'a'.repeat(8000), '=' + '1a'.repeat(4000), '=' + 'a.'.repeat(4000), '=' + '('.repeat(8000), '=1' + '_'.repeat(8000) + '('];
    const started = Date.now();
    for (let i = 0; i < 100; i++) for (const f of formulas) parseSpreadsheet(sheet([[f]]));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('accepts what only looks like a problem: special characters in strings, quoted sheet names with apostrophes, literal text', () => {
    const ok = (content: string) => expect(parseSpreadsheet(content).ok, content).toBe(true);
    ok(sheet([['="a|b"', '="[x]"', '=IF(A1="(x)!","a","b")', '=STDEV.S(A1:A3)', '=_xlfn.XLOOKUP(1,A1:A3,B1:B3)', { value: '=x' }, { formula: 'SUM(A1:A2)' }]]));
    ok(JSON.stringify({ sheets: [{ name: 'Costs', rows: [["='Q3''s costs'!B4", "='Second sheet'!B4", '=costs!A1']] }, { name: "Q3's costs", rows: [] }, { name: 'Second sheet', rows: [] }] }));
  });
});

describe('office-spec helpers', () => {
  it('xmlSafe drops what XML 1.0 cannot hold and keeps the rest, emoji included', () => {
    expect(xmlSafe('a\u0000b\u0001c\td\ne\rf\u000bg￾h')).toBe('abc\td\ne\rfgh');
    expect(xmlSafe('lone \uD800 high, lone \uDC00 low, pair 😀, Café')).toBe('lone  high, lone  low, pair 😀, Café');
  });

  it('parseCellDate reads dates and wall-clock times, and refuses ones that do not exist', () => {
    expect(parseCellDate('2026-10-12')).toEqual({ utcMs: Date.UTC(2026, 9, 12), hasTime: false });
    expect(parseCellDate('2026-10-12T09:30')).toEqual({ utcMs: Date.UTC(2026, 9, 12, 9, 30), hasTime: true });
    expect(parseCellDate('2026-10-12T09:30:15')).toEqual({ utcMs: Date.UTC(2026, 9, 12, 9, 30, 15), hasTime: true });
    for (const bad of ['2026-02-30', '2026-13-01', '1899-12-31', '2026-10-12T24:00', '12/10/2026', '2026-10-12Z']) expect(parseCellDate(bad), bad).toBeNull();
  });

  it('columnName gives Excel column letters', () => {
    expect([0, 25, 26, 701, 702, 16_383].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA', 'XFD']);
  });

  it('checkOfficeContent checks spreadsheets only, and isOfficeKind knows the kinds', () => {
    expect(checkOfficeContent('document', 'anything at all')).toBeNull();
    expect(checkOfficeContent('markdown', '{')).toBeNull();
    expect(checkOfficeContent('spreadsheet', '{')).toMatch(/isn't valid JSON/);
    expect(checkOfficeContent('spreadsheet', sheet([['x']]))).toBeNull();
    expect(['document', 'spreadsheet', 'html'].map(isOfficeKind)).toEqual([true, true, false]);
  });

  it('the guidance covers both formats and the refused functions, in under 2 KB and with no heading of its own', () => {
    expect(OFFICE_GUIDANCE).toContain('"document"');
    expect(OFFICE_GUIDANCE).toContain('"spreadsheet"');
    expect(OFFICE_GUIDANCE).toContain('WEBSERVICE');
    expect(OFFICE_GUIDANCE.length).toBeLessThan(2048);
    expect(OFFICE_GUIDANCE.split('\n').some((l) => l.startsWith('#'))).toBe(false);
  });
});
