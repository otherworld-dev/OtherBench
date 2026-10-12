import { describe, expect, it } from 'vitest';
import {
  ALLOWED_FUNCTIONS,
  checkOfficeContent,
  columnName,
  formulaForFile,
  isOfficeKind,
  NOT_YET_FUNCTIONS,
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
      '={' + '1,'.repeat(4000) + '1}',
      '={' + '"a",'.repeat(2000) + '1}',
      '=' + '#DIV/0!+'.repeat(1000) + '1',
      '=' + 'A1 '.repeat(2700) + 'A1',
      '=' + 'SUM('.repeat(2000) + ')'.repeat(2000),
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

const SHEET_NAMES = ['Costs', 'Second sheet', "Q3's costs", 'Données'];
const NAMES: ReadonlySet<string> = new Set(SHEET_NAMES.map((n) => n.toLowerCase()));
const workbook = (rows: unknown[][]) => JSON.stringify({ sheets: SHEET_NAMES.map((name, i) => ({ name, rows: i === 0 ? rows : [] })) });

/** Formulas every round has accepted (bar the LET/LAMBDA family), and the ones this round adds. */
const ACCEPTED = [
  '=SUM(B2:B3)',
  "='Second sheet'!B1*2",
  '="a|b"',
  '="[x]"',
  '=IF(A1="(x)!","a","b")',
  '=STDEV.S(A1:A3)',
  '=_xlfn.XLOOKUP(1,A1:A3,B1:B3)',
  "='Q3''s costs'!B4",
  '=costs!A1',
  '=Données!A1',
  '=SUM(données!A1:A3)',
  '=XLOOKUP(1,A1:A3,B1:B3)',
  '=FILTER(A1:A3,B1:B3>0)',
  '=_xlfn._xlws.SORT(A1:A3)',
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
  '=A1=#DIV/0!',
  '=IFERROR(1/0,#N/A)',
  '={1,2;3,4}',
  '=SUM({1,-2,"a",TRUE,#N/A})',
  '=A1#',
  '=SORT(A1:A3)#',
  '=B:B',
  '=2:2',
  '=$A$1:$B$2',
  '=50%*A1',
  '=1.5E+3',
  '=A1:B3 A2:C2',
  '=SUM(A1,\nB1)',
  '=ENCODEURL("a b")',
  '=DBCS("a")',
  '=A1<>B1&A2<=B2&A3>=B3',
  '=-A$1^2',
  '=XFD1048576',
  '=$A:$C',
  '=$3:5',
  '=#REF!+#null!',
  "='Second sheet'!$A$1:B2",
  '=.5+1.e-3',
  '=COUNTIFS(Costs!A:A,">0",B:B,"<>")',
];

describe('formula functions', () => {
  const errorFor = (formula: string): string => errorOf(sheet([[formula]]));
  const NOT_ALLOWED = /isn't one of Excel's built-in functions Grunt allows/;

  it('refuses every function on the refused list, however it is written, called or not', () => {
    for (const f of REFUSED_FUNCTIONS) {
      for (const written of [`${f}(1)`, `${f.toLowerCase()}(1)`, `${f} (1)`, `${f}\n(1)`, `_xlfn._xlws.${f}(1)`, `_XLFN._xlfn.${f}(1)`, `@${f}(1)`, `1+${f}(1)`, `SUM(${f})`, `SUM(A1,${f.toLowerCase()})`]) {
        expect(errorFor(`=${written}`), written).toMatch(new RegExp(`uses ${f.replace('.', '\\.')}, which Grunt refuses: it could reach the network or another program, or reveal details of this computer, when the file is opened`));
      }
    }
  });

  it('refuses any _xl prefix but _xlfn. and _xlws., called or not', () => {
    expect(errorFor('=_xlpm.x+1')).toMatch(/uses "_xlpm\.x", whose "_xlpm\." prefix Grunt refuses/);
    expect(errorFor('=_xlfoo.SUM(1)')).toMatch(/uses "_xlfoo\.SUM", whose "_xlfoo\." prefix Grunt refuses/);
    expect(errorFor('=SUM(A1,_xleta.WEBSERVICE)')).toMatch(/whose "_xleta\." prefix Grunt refuses/);
    expect(errorFor('=_xludf.FOO(1)')).toMatch(/whose "_xludf\." prefix Grunt refuses/);
    expect(errorFor('=_xlfn._xlpm.SUM(1)')).toMatch(/whose "_xlpm\." prefix Grunt refuses/);
  });

  it('refuses LET, LAMBDA and its helpers for now', () => {
    for (const [f, name] of [
      ['=LET(x,1,x+1)', 'LET'],
      ['=LET(_xlpm.x,1,_xlpm.x+1)', 'LET'],
      ['=LAMBDA(x,x+1)(2)', 'LAMBDA'],
      ['=LET(f,LAMBDA(x,x+1),f(2))', 'LET'],
      ['=MAP(A1:A3,LAMBDA(v,v*2))', 'MAP'],
      ['=MAP(A1:A3,_xleta.WEBSERVICE)', 'MAP'],
      ['=MAP(A1:A3,WEBSERVICE)', 'MAP'],
      ['=BYROW(A1:B2,INDIRECT)', 'BYROW'],
      ['=_xlfn.REDUCE(0,A1:A3,x)', 'REDUCE'],
      ['=SCAN(0,A1:A3,x)', 'SCAN'],
      ['=bycol(A1:B2,x)', 'BYCOL'],
      ['=MAKEARRAY(2,2,x)', 'MAKEARRAY'],
      ['=ISOMITTED(x)', 'ISOMITTED'],
      ['=GROUPBY(A1:A3,B1:B3,SUM)', 'GROUPBY'],
      ['=PIVOTBY(A1:A3,B1:B3,C1:C3,SUM)', 'PIVOTBY'],
    ] as const) {
      expect(errorFor(f), f).toMatch(new RegExp(`uses ${name}, which Grunt doesn't support in spreadsheets yet`));
    }
    for (const name of NOT_YET_FUNCTIONS) expect(ALLOWED_FUNCTIONS.has(name), name).toBe(false);
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
      '=SUM(A1, WEBSERVICE("x"))',
      '=IF(A1,"a",WEBSERVICE("x"))',
      '="a"&WEBSERVICE("x")',
      '=WEBSERVICE（"x"）',
      '=WEBSERVICE\u007f("x")',
      '=WEBSERVICE\u0085("x")',
      '=SUM(INDIRECT)',
    ]) {
      expect(errorFor(f), f).toMatch(/which Grunt refuses/);
    }
    expect(errorFor('=1\\WEBSERVICE("x")')).toMatch(/has "\\" at character 3, which Grunt can't read in a formula/);
  });

  it('refuses any function that is not one of Excel built-ins, including lookalike letters', () => {
    expect(errorFor('=FOO(1)')).toMatch(/uses FOO, which isn't one of Excel's built-in functions Grunt allows/);
    for (const f of ['=ＷＥＢＳＥＲＶＩＣＥ("x")', '=WEBSERVICE\u200B("x")', '=WEBSERVIC\u0301E("x")', '=ſum(A1)', '=CUBEVALUE("c","m")', '=PY(1,0)', '=A1(2)']) {
      expect(errorFor(f), f).toMatch(NOT_ALLOWED);
    }
    // A name, a space, then "(" is read as a call, so a range intersected with a bracketed range is refused too. Rare; accepted.
    expect(errorFor('=A1:B3 (A2:C2)')).toMatch(/uses B3, which isn't one/);
  });

  it('fails closed: anything the tokenizer does not fully read is refused', () => {
    const named = (rows: unknown[][]) => JSON.stringify({ sheets: [{ name: 'Costs', rows }, { name: 'Sheet1', rows: [] }, { name: 'Sheet2', rows: [] }] });
    const cases: [string, RegExp][] = [
      ['=A1\tB1', /has a tab at character 4, which Grunt can't read in a formula/],
      ['=A1+\u0001B1', /has a control character \(U\+0001\) at character 5/],
      ['=myName+1', /uses the name "myName", which isn't a cell reference, a function call, TRUE or FALSE/],
      ['=SUM(myName)', /uses the name "myName"/],
      ['=SUM(A1,SUM)', /uses SUM without calling it/],
      ['=Sheet1:Sheet2!A1', /uses references across sheets \(Sheet1:Sheet2!\), which Grunt doesn't support/],
      ['=A1:Sheet2!B2', /uses references across sheets \(A1:Sheet2!\)/],
      ['=SUM(A1:A3)~', /has "~" at character 12, which Grunt can't read in a formula/],
      ['=SUM(A1;A2)', /has ";" at character 8/],
      ['={1,2;3,WEBSERVICE("x")}', /has an array constant that holds something other than numbers, text, TRUE\/FALSE and error values, at character 9/],
      ['={1,{2}}', /array constant/],
      ['={1,2', /array constant/],
      ['={}', /array constant/],
      ['={-"a"}', /array constant/],
      ['=[1]Sheet1!A1', /uses "\["/],
      ['=Table1[Col]', /uses "\["/],
      ['=R[1]C', /uses "\["/],
      ['="unclosed', /has an unclosed double quote/],
      ["='Sheet1", /has an unclosed single quote/],
      ["='Sheet1'+1", /has a name in single quotes at character 2 that isn't followed by "!"/],
      ['=SUM((A1)', /has an unclosed parenthesis/],
      ['=!A1', /has "!" at character 2 with no sheet name before it/],
      ['=Sheet1!', /needs a cell reference after "Sheet1!"/],
      ['=Sheet1!myName', /needs a cell reference after "Sheet1!"/],
      ['=A0', /uses the name "A0"/],
      ['=XFE1', /uses the name "XFE1"/],
      ['=A1048577', /uses the name "A1048577"/],
      ['=A01', /uses the name "A01"/],
      ['=1E', /has "E" at character 3/],
      ['=2abc', /has "a" at character 3/],
      ['=A1 #', /has "#" at character 5/],
      ['=#DIV/1!', /has "#" at character 2/],
      ['=1}', /has "}" at character 3/],
      ['=A1|B1', /uses "\|"/],
    ];
    for (const [f, message] of cases) {
      const parsed = parseSpreadsheet(named([[f]]));
      expect(parsed.ok, f).toBe(false);
      if (!parsed.ok) expect(parsed.error, f).toMatch(message);
    }
  });

  it("accepts Excel's own functions, references, literals and operators, and text that only mentions a URL", () => {
    for (const f of ACCEPTED) expect(parseSpreadsheet(workbook([[f]])), f).toMatchObject({ ok: true });
  });

  it('knows the prefix Excel stores each function with', () => {
    expect(ALLOWED_FUNCTIONS.get('SUM')).toBe('');
    expect(ALLOWED_FUNCTIONS.get('VLOOKUP')).toBe('');
    expect(ALLOWED_FUNCTIONS.get('NETWORKDAYS.INTL')).toBe('');
    expect(ALLOWED_FUNCTIONS.get('XLOOKUP')).toBe('_xlfn.');
    expect(ALLOWED_FUNCTIONS.get('STDEV.S')).toBe('_xlfn.');
    expect(ALLOWED_FUNCTIONS.get('ENCODEURL')).toBe('_xlfn.');
    expect(ALLOWED_FUNCTIONS.get('DBCS')).toBe('_xlfn.');
    expect(ALLOWED_FUNCTIONS.has('LAMBDA')).toBe(false);
    expect(ALLOWED_FUNCTIONS.get('FILTER')).toBe('_xlfn._xlws.');
    expect(ALLOWED_FUNCTIONS.get('SORT')).toBe('_xlfn._xlws.');
    for (const f of REFUSED_FUNCTIONS) expect(ALLOWED_FUNCTIONS.has(f), f).toBe(false);
    for (const [name, prefix] of ALLOWED_FUNCTIONS) {
      expect(name, name).toMatch(/^[A-Z][A-Z0-9.]*$/);
      expect(['', '_xlfn.', '_xlfn._xlws.'], name).toContain(prefix);
    }
  });
});

describe('formulaForFile', () => {
  const text = (formula: string): string => {
    const written = formulaForFile(formula, NAMES);
    if (!written.ok) throw new Error(`${formula}: ${written.error}`);
    return written.text;
  };

  it('gives the text for <f>: no "=", canonical function names with their file prefixes, the rest as given', () => {
    expect(text('=SUM(A1:A3)')).toBe('SUM(A1:A3)');
    expect(text('SUM(A1:A3)')).toBe('SUM(A1:A3)');
    expect(text('=xlookup(1,A1:A3,B1:B3)')).toBe('_xlfn.XLOOKUP(1,A1:A3,B1:B3)');
    expect(text('=_xlfn.XLOOKUP(1,A1:A3,B1:B3)')).toBe('_xlfn.XLOOKUP(1,A1:A3,B1:B3)');
    expect(text('=_xlws._XLFN.xlookup(1,A1:A3,B1:B3)')).toBe('_xlfn.XLOOKUP(1,A1:A3,B1:B3)');
    expect(text('=filter(A1:A3,B1:B3>0)')).toBe('_xlfn._xlws.FILTER(A1:A3,B1:B3>0)');
    expect(text('=_xlfn.FILTER(A1:A3,B1:B3>0)')).toBe('_xlfn._xlws.FILTER(A1:A3,B1:B3>0)');
    expect(text('=STDEV.S(A1:A3)')).toBe('_xlfn.STDEV.S(A1:A3)');
    expect(text('=_xlfn.SUM(A1)')).toBe('SUM(A1)');
    expect(text("=\"x\"\"y\"&'Q3''s costs'!B4")).toBe("\"x\"\"y\"&'Q3''s costs'!B4");
    expect(text('=IF(a1>0,"sum(x)",donnÉes!b2)')).toBe('IF(a1>0,"sum(x)",donnÉes!b2)');
    expect(text('=ROUND( sum(A1:A3) , 2)')).toBe('ROUND( SUM(A1:A3) , 2)');
  });

  it('refuses what parseSpreadsheet refuses, with the same message', () => {
    for (const f of ['=WEBSERVICE("x")', '=SUM(A1', '=Nope!A1', '=LET(x,1,x)', '=A1\tB1', '=myName']) {
      const written = formulaForFile(f, NAMES);
      expect(written.ok, f).toBe(false);
      if (!written.ok) expect(errorOf(workbook([[f]])), f).toBe(`sheets[0].rows[0][0]: ${written.error}`);
    }
  });

  it('writes exactly what it checked: its own text reads back the same, and is the input bar prefixes and name case', () => {
    expect(ACCEPTED.length).toBeGreaterThanOrEqual(40);
    const unprefixed = (s: string) => s.replace(/_xl(?:fn|ws)\./gi, '');
    for (const f of ACCEPTED) {
      const written = text(f);
      expect(text(written), f).toBe(written);
      expect(text(`=${written}`), f).toBe(written);
      expect(unprefixed(written).toUpperCase(), f).toBe(unprefixed(f.slice(1)).toUpperCase());
      expect(unprefixed(written).length, f).toBe(unprefixed(f.slice(1)).length);
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
