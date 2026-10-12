import { describe, expect, it } from 'vitest';
import {
  ALLOWED_FUNCTIONS,
  checkOfficeContent,
  columnName,
  isOfficeKind,
  OFFICE_GUIDANCE,
  parseCellDate,
  parseSpreadsheet,
  REFUSED_FUNCTIONS,
  xmlSafe,
  type SpreadsheetSpec,
} from '../src/domain/office-spec.js';

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

  it('reads quote-heavy and long Unicode formulas in one pass too', () => {
    const formulas = [
      '="' + '""'.repeat(100_000) + '"',
      '="' + '""'.repeat(4_000) + '"',
      '=' + 'é'.repeat(8000),
      '=1' + 'ü'.repeat(8000) + '(',
      '=' + ('a' + ' '.repeat(9)).repeat(800),
      '=' + 'Données'.repeat(1000) + '!A1',
    ];
    const started = Date.now();
    for (let i = 0; i < 100; i++) for (const f of formulas) parseSpreadsheet(sheet([[f]]));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('accepts what only looks like a problem: special characters in strings, quoted sheet names with apostrophes, literal text', () => {
    const ok = (content: string) => expect(parseSpreadsheet(content).ok, content).toBe(true);
    ok(sheet([['="a|b"', '="[x]"', '=IF(A1="(x)!","a","b")', '=STDEV.S(A1:A3)', '=_xlfn.XLOOKUP(1,A1:A3,B1:B3)', { value: '=x' }, { formula: 'SUM(A1:A2)' }]]));
    ok(JSON.stringify({ sheets: [{ name: 'Costs', rows: [["='Q3''s costs'!B4", "='Second sheet'!B4", '=costs!A1']] }, { name: "Q3's costs", rows: [] }, { name: 'Second sheet', rows: [] }] }));
  });

  it('reads unquoted sheet names in any script', () => {
    const ok = (content: string) => expect(parseSpreadsheet(content), content).toMatchObject({ ok: true });
    ok(JSON.stringify({ sheets: [{ name: 'Costs', rows: [['=Données!A1', '=Café!A1', '=SUM(données!A1:A3)']] }, { name: 'Données', rows: [] }, { name: 'Café', rows: [] }] }));
    expect(errorOf(sheet([['=Données!A1']]))).toMatch(/refers to sheet "Données", which isn't in the workbook/);
  });

  it('refuses an unknown key wherever a formula might hide', () => {
    expect(errorOf(JSON.stringify({ sheets: [{ name: 'Costs', rows: [] }], definedNames: { x: '=WEBSERVICE("x")' } }))).toMatch(/^\(top level\): unknown key "definedNames"/);
    expect(errorOf(JSON.stringify({ sheets: [{ name: 'Costs', rows: [], validation: [] }] }))).toMatch(/^sheets\[0\]: unknown key "validation"/);
    expect(errorOf(JSON.stringify({ sheets: [{ name: 'Costs', rows: [], definedNames: {} }] }))).toMatch(/^sheets\[0\]: unknown key "definedNames"/);
    expect(errorOf(sheet([[{ value: 1, validation: '=WEBSERVICE("x")' }]]))).toMatch(/^sheets\[0\]\.rows\[0\]\[0\]: unknown key "validation"/);
    expect(errorOf(sheet([[{ value: 1, hyperlink: 'https://x' }]]))).toMatch(/^sheets\[0\]\.rows\[0\]\[0\]: unknown key "hyperlink"/);
  });
});

describe('formula functions', () => {
  const errorFor = (formula: string): string => errorOf(sheet([[formula]]));
  const NOT_ALLOWED = /isn't one of Excel's built-in functions Grunt allows/;

  it('refuses every function on the refused list, however it is written', () => {
    for (const f of REFUSED_FUNCTIONS) {
      for (const written of [`${f}(1)`, `${f.toLowerCase()}(1)`, `${f} (1)`, `${f}\n(1)`, `_xlfn._xlws.${f}(1)`, `_XLFN._xlfn.${f}(1)`, `_xlpm.${f}(1)`, `@${f}(1)`, `1+${f}(1)`]) {
        expect(errorFor(`=${written}`), written).toMatch(new RegExp(`uses ${f.replace('.', '\\.')}, which Grunt refuses: it could reach the network or another program, or reveal details of this computer, when the file is opened`));
      }
    }
  });

  it('refuses each way round the check that review found', () => {
    for (const f of [
      '=WEBSERVICE ("x")',
      '=webservice("x")',
      '=_xlfn._xlws.FILTERXML(A1,"//a")',
      '=_xlfn._xlfn.WEBSERVICE("x")',
      '=@WEBSERVICE("x")',
      '=STOCKHISTORY("MSFT",A1)',
      '=TRANSLATE("hi","en","fr")',
      '=DETECTLANGUAGE("hi")',
      '=COPILOT("hi")',
      '=INFO("directory")',
      '=CELL("filename")',
      `=INDIRECT("'C:\\x\\[b.xlsx]S'!A1")`,
      '=1\\WEBSERVICE("x")',
      '=SUM(A1, WEBSERVICE("x"))',
      '=IF(A1,"a",WEBSERVICE("x"))',
      '="a"&WEBSERVICE("x")',
      '=WEBSERVICE（"x"）',
    ]) {
      expect(errorFor(f), f).toMatch(/which Grunt refuses/);
    }
  });

  it('refuses any function that is not one of Excel built-ins, including a called LET or LAMBDA name and lookalike letters', () => {
    expect(errorFor('=FOO(1)')).toMatch(/uses FOO, which isn't one of Excel's built-in functions Grunt allows/);
    // A name bound by LET or LAMBDA can't be called: Grunt can't tell it from an unknown function. That's accepted.
    expect(errorFor('=LET(f,LAMBDA(x,x+1),f(2))')).toMatch(/uses f, which isn't one/);
    expect(errorFor('=LET(_xlpm.f,LAMBDA(_xlpm.x,_xlpm.x+1),_xlpm.f(2))')).toMatch(NOT_ALLOWED);
    for (const f of ['=ＷＥＢＳＥＲＶＩＣＥ("x")', '=WEBSERVICE\u200B("x")', '=WEBSERVIC\u0301E("x")', '=ſum(A1)', '=_xludf.FOO(1)', '=CUBEVALUE("c","m")', '=PY(1,0)', '=Costs!A1(2)']) {
      expect(errorFor(f), f).toMatch(NOT_ALLOWED);
    }
    // A name, a space, then "(" is read as a call, so a range intersected with a bracketed range is refused too. Rare; accepted.
    expect(errorFor('=A1:B3 (A2:C2)')).toMatch(/uses B3, which isn't one/);
  });

  it("accepts Excel's own functions, with or without their file prefixes, and text that only mentions a URL", () => {
    for (const f of [
      '=XLOOKUP(1,A1:A3,B1:B3)',
      '=_xlfn.XLOOKUP(1,A1:A3,B1:B3)',
      '=FILTER(A1:A3,B1:B3>0)',
      '=_xlfn._xlws.SORT(A1:A3)',
      '=LET(x,1,x+1)',
      '=LET(_xlpm.x,1,_xlpm.x+1)',
      '=LAMBDA(x,x+1)(2)',
      '=MAP(A1:A3,LAMBDA(v,v*2))',
      '=TEXTJOIN(", ",TRUE,A1:A3)',
      '=IFERROR(VLOOKUP(A1,B:C,2,FALSE),"")',
      '=SUMPRODUCT((A1:A3>0)*B1:B3)',
      '=DATE(2026,10,12)+TIME(9,30,0)',
      '=NPV(0.1,B1:B5)',
      '="see https://example.com"',
      '=ROUND( SUM(A1:A3) , 2)',
      '=@A1:A3',
      '=sum(a1:a3)',
      '=LOG10(100)+ATAN2(1,1)+DAYS360(A1,A2)',
      '=NETWORKDAYS.INTL(A1,A2,1)+ISO.CEILING(2.5)',
      '=IF(AND(A1>0,NOT(ISBLANK(B1))),TRUE(),FALSE())',
    ]) {
      expect(parseSpreadsheet(sheet([[f]])), f).toMatchObject({ ok: true });
    }
  });

  it('knows the prefix Excel stores each function with', () => {
    expect(ALLOWED_FUNCTIONS.get('SUM')).toBe('');
    expect(ALLOWED_FUNCTIONS.get('VLOOKUP')).toBe('');
    expect(ALLOWED_FUNCTIONS.get('NETWORKDAYS.INTL')).toBe('');
    expect(ALLOWED_FUNCTIONS.get('XLOOKUP')).toBe('_xlfn.');
    expect(ALLOWED_FUNCTIONS.get('STDEV.S')).toBe('_xlfn.');
    expect(ALLOWED_FUNCTIONS.get('LAMBDA')).toBe('_xlfn.');
    expect(ALLOWED_FUNCTIONS.get('FILTER')).toBe('_xlfn._xlws.');
    expect(ALLOWED_FUNCTIONS.get('SORT')).toBe('_xlfn._xlws.');
    for (const f of REFUSED_FUNCTIONS) expect(ALLOWED_FUNCTIONS.has(f), f).toBe(false);
    for (const [name, prefix] of ALLOWED_FUNCTIONS) {
      expect(name, name).toMatch(/^[A-Z][A-Z0-9.]*$/);
      expect(['', '_xlfn.', '_xlfn._xlws.'], name).toContain(prefix);
    }
  });
});

describe('office-spec helpers', () => {
  it('xmlSafe drops what XML 1.0 cannot hold and keeps the rest, emoji included', () => {
    expect(xmlSafe('a\u0000b\u0001c\td\ne\rf\u000bg\uFFFEh')).toBe('abc\td\ne\rfgh');
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
