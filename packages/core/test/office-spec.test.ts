import { describe, expect, it } from 'vitest';
import {
  ALLOWED_FUNCTIONS,
  checkOfficeContent,
  columnName,
  formulaForFile,
  isOfficeKind,
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_INDENT,
  MAX_DOCUMENT_LINES,
  MAX_DOCUMENT_MARKS,
  MAX_DOCUMENT_QUOTE_DEPTH,
  MAX_DOCUMENT_TABLE_CELLS,
  MAX_DOCUMENT_TABLE_ROWS,
  MAX_BULLETS,
  MAX_SLIDES,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  NOT_YET_FUNCTIONS,
  OFFICE_GUIDANCE,
  parseCellDate,
  parsePresentation,
  parseSpreadsheet,
  REFUSED_FUNCTIONS,
  xmlSafe,
  type PresentationSpec,
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
      expect(errorOf(sheet([[`=${f}`]])), f).toMatch(/which OtherBench refuses/);
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

const SHEET_NAMES = ['Costs', 'Second sheet', "Q3's costs", 'Données', 'R1', '2026'];
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
  '=sum(a1:a3)',
  '=LOG10(100)+ATAN2(1,1)+DAYS360(A1,A2)',
  '=NETWORKDAYS.INTL(A1,A2,1)+ISO.CEILING(2.5)',
  '=IF(AND(A1>0,NOT(ISBLANK(B1))),TRUE(),FALSE())',
  '=A1=#DIV/0!',
  '=IFERROR(1/0,#N/A)',
  '={1,2;3,4}',
  '=SUM({1,-2,"a",TRUE,#N/A})',
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
  '=SUM(A1,,B1)',
  '=IF(A1,,1)',
  '=SUM(A1,)',
  '=--A1+-+1',
  '=NOW()-PI()',
  '=(A1+B1)*-(C1)%',
  '=A1 : B2',
  "='R1'!A1+'2026'!B2",
  '="#DIV/0! in text"&#N/A',
];

describe('formula functions', () => {
  const errorFor = (formula: string): string => errorOf(sheet([[formula]]));
  const NOT_ALLOWED = /isn't one of Excel's built-in functions OtherBench allows/;

  it('refuses every function on the refused list, however it is written, called or not', () => {
    for (const f of REFUSED_FUNCTIONS) {
      for (const written of [`${f}(1)`, `${f.toLowerCase()}(1)`, `${f} (1)`, `${f}\n(1)`, `_xlfn._xlws.${f}(1)`, `_XLFN._xlfn.${f}(1)`, `1+${f}(1)`, `SUM(${f})`, `SUM(A1,${f.toLowerCase()})`]) {
        expect(errorFor(`=${written}`), written).toMatch(new RegExp(`uses ${f.replace('.', '\\.')}, which OtherBench refuses: it could reach the network or another program, or reveal details of this computer, when the file is opened`));
      }
    }
  });

  it('refuses any _xl prefix but _xlfn. and _xlws., called or not', () => {
    expect(errorFor('=_xlpm.x+1')).toMatch(/uses "_xlpm\.x", whose "_xlpm\." prefix OtherBench refuses/);
    expect(errorFor('=_xlfoo.SUM(1)')).toMatch(/uses "_xlfoo\.SUM", whose "_xlfoo\." prefix OtherBench refuses/);
    expect(errorFor('=SUM(A1,_xleta.WEBSERVICE)')).toMatch(/whose "_xleta\." prefix OtherBench refuses/);
    expect(errorFor('=_xludf.FOO(1)')).toMatch(/whose "_xludf\." prefix OtherBench refuses/);
    expect(errorFor('=_xlfn._xlpm.SUM(1)')).toMatch(/whose "_xlpm\." prefix OtherBench refuses/);
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
      expect(errorFor(f), f).toMatch(new RegExp(`uses ${name}, which OtherBench doesn't support in spreadsheets yet`));
    }
    for (const name of NOT_YET_FUNCTIONS) expect(ALLOWED_FUNCTIONS.has(name), name).toBe(false);
  });

  it('refuses each way round the check that review found', () => {
    for (const f of [
      '=WEBSERVICE ("x")',
      '=webservice("x")',
      '=_xlfn._xlws.FILTERXML(A1,"//a")',
      '=_xlfn._xlfn.WEBSERVICE("x")',
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
      expect(errorFor(f), f).toMatch(/which OtherBench refuses/);
    }
    expect(errorFor('=1\\WEBSERVICE("x")')).toMatch(/has "\\" at character 3, which OtherBench can't read in a formula/);
    expect(errorFor('=@WEBSERVICE("x")')).toMatch(/uses "@" \(implicit intersection\), which OtherBench doesn't support in spreadsheets yet/);
  });

  it("refuses @ and the # spill operator for now, but keeps # in error values and text", () => {
    for (const f of ['=@A1:A3', '=@@A1', '=SUM(@A1:A3)', '=A1:A3 @B1']) expect(errorFor(f), f).toMatch(/uses "@" \(implicit intersection\), which OtherBench doesn't support in spreadsheets yet/);
    for (const f of ['=A1#', '=SORT(A1:A3)#', '=Costs!A1#', '=SUM(A1#)']) expect(errorFor(f), f).toMatch(/uses "#" \(a spill reference\), which OtherBench doesn't support in spreadsheets yet/);
    for (const f of ['=A1=#DIV/0!', '="#A1#"', '=IFERROR(A1,#N/A)']) expect(parseSpreadsheet(sheet([[f]])), f).toMatchObject({ ok: true });
  });

  it("refuses syntax Excel would repair: operands and operators must alternate", () => {
    const cases: [string | { formula: string }, RegExp][] = [
      ['=1:2:+', /uses ":" at character 5 between things that aren't cell references/],
      ['=1:2:', /ends where Excel expects a value/],
      ['=A1+', /ends where Excel expects a value/],
      ['=%', /has "%" at character 2 where Excel expects a value/],
      ['=*A1', /has "\*" at character 2 where Excel expects a value/],
      [{ formula: '==A1' }, /has "=" at character 2 where Excel expects a value/],
      ['=1 2', /has a space at character 3 between values that aren't both cell references/],
      ['="a" "b"', /has a space at character 5 between values that aren't both cell references/],
      ['=SUM(A1) B1', /has a space at character 9 between values/],
      ['=SUM(A1)(2)', /has "\(" at character 9 right after a value, with no operator between them/],
      ['=(A1)(2)', /has "\(" at character 6 right after a value/],
      ['="a"1', /has "1" at character 5 right after a value/],
      ['=0:1', /uses ":" at character 3 between things that aren't cell references/],
      ['=1:1048577', /uses ":" at character 3 between things that aren't cell references/],
      ['=A1:-B1', /uses ":" at character 4 between things that aren't cell references/],
      ['=A1:1', /uses ":" at character 4 between things that aren't cell references/],
      ['=1,000', /has "," at character 3 outside a function's arguments/],
      ['=(A1,B1)', /has "," at character 5 outside a function's arguments/],
      ['=()', /has "\)" at character 3 where Excel expects a value/],
      ['=SUM(1+)', /has "\)" at character 8 where Excel expects a value/],
      ['=SUM(A1,1+,2)', /has "," at character 11 where Excel expects a value/],
    ];
    for (const [f, message] of cases) expect(errorOf(sheet([[f]])), JSON.stringify(f)).toMatch(message);
  });

  it('refuses a reference across sheets however it is spaced', () => {
    const named = (f: string) => JSON.stringify({ sheets: [{ name: 'Costs', rows: [[f]] }, { name: 'Sheet2', rows: [] }] });
    for (const f of ['=A1:Sheet2!B2', '=A1: Sheet2!B2', '=A1 :Sheet2!B2', '=A1 : Sheet2!B2', "=A1:'Sheet2'!B2"]) {
      expect(errorOf(named(f)), f).toMatch(/uses references across sheets \(A1:'?Sheet2'?!\), which OtherBench doesn't support/);
    }
  });

  it('refuses unquoted sheet names Excel needs quoted, and takes them quoted', () => {
    const names = ['A1', 'XFD1048576', 'R', 'C', 'RC', 'R1C1', 'R1', 'C3', '2026', 'Données'];
    const book = (f: string) => JSON.stringify({ sheets: [{ name: 'Costs', rows: [[f]] }, ...names.map((name) => ({ name, rows: [] }))] });
    for (const f of ['=A1!B1', '=XFD1048576!A1', '=R!A1', '=C!A1', '=RC!A1', '=rc!A1', '=r!A1', '=R1C1!A1', '=r1c1!A1', '=R1!A1', '=C3!A1', '=2026!A1']) {
      expect(errorOf(book(f)), f).toMatch(/without quotes: write it as '.+'!/);
    }
    for (const f of ["='A1'!B1", "='R'!A1", "='rc'!A1", "='R1C1'!A1", "='2026'!A1", '=Données!A1']) expect(parseSpreadsheet(book(f)), f).toMatchObject({ ok: true });
  });

  it('refuses what xmlSafe would take out, even inside text and quoted sheet names', () => {
    const lone = String.fromCharCode(0xd800);
    const nonCharacter = String.fromCharCode(0xfffe);
    expect(errorFor(`="a${lone}b"`)).toMatch(/has the character U\+D800 at character 4, which OtherBench can't read in a formula/);
    expect(errorFor(`="a${String.fromCharCode(0xdc00)}"`)).toMatch(/U\+DC00 at character 4/);
    expect(errorFor(`='Co${lone}sts'!A1`)).toMatch(/U\+D800 at character 5/);
    expect(errorFor(`="a${nonCharacter}"`)).toMatch(/U\+FFFE at character 4/);
    expect(errorFor(`="a${String.fromCharCode(1)}"`)).toMatch(/a control character \(U\+0001\) at character 4/);
    expect(parseSpreadsheet(sheet([['="pair 😀, tab\tand\nline"']]))).toMatchObject({ ok: true });
  });

  it("refuses a sheet name with a character the .xlsx writer would take out, so a formula can't point at a name that isn't there", () => {
    const named = (name: string) => JSON.stringify({ sheets: [{ name, rows: [] }] });
    for (const [code, name] of [
      ['U+0090', 'A' + String.fromCharCode(0x90) + 'B'],
      ['U+007F', 'A' + String.fromCharCode(0x7f)],
      ['U+FFFD', String.fromCharCode(0xfffd) + 'A'],
      ['U+FDD0', 'A' + String.fromCharCode(0xfdd0)],
      ['U+0001', 'A' + String.fromCharCode(1) + 'B'],
      ['U+FFFE', 'A' + String.fromCharCode(0xfffe)],
    ] as const) {
      expect(errorOf(named(name)), code).toBe(`sheets[0].name: has the character ${code}, which a sheet name can't hold`);
    }
    expect(parseSpreadsheet(named('Café 😀 Données'))).toMatchObject({ ok: true });
  });

  it('refuses any function that is not one of Excel built-ins, including lookalike letters', () => {
    expect(errorFor('=FOO(1)')).toMatch(/uses FOO, which isn't one of Excel's built-in functions OtherBench allows/);
    for (const f of ['=ＷＥＢＳＥＲＶＩＣＥ("x")', '=WEBSERVICE\u200B("x")', '=WEBSERVIC\u0301E("x")', '=ſum(A1)', '=CUBEVALUE("c","m")', '=PY(1,0)', '=A1(2)']) {
      expect(errorFor(f), f).toMatch(NOT_ALLOWED);
    }
    // A name, a space, then "(" is read as a call, so a range intersected with a bracketed range is refused too. Rare; accepted.
    expect(errorFor('=A1:B3 (A2:C2)')).toMatch(/uses B3, which isn't one/);
  });

  it('fails closed: anything the tokenizer does not fully read is refused', () => {
    const named = (rows: unknown[][]) => JSON.stringify({ sheets: [{ name: 'Costs', rows }, { name: 'Sheet1', rows: [] }, { name: 'Sheet2', rows: [] }] });
    const cases: [string, RegExp][] = [
      ['=A1\tB1', /has a tab at character 4, which OtherBench can't read in a formula/],
      ['=A1+\u0001B1', /has a control character \(U\+0001\) at character 5/],
      ['=myName+1', /uses the name "myName", which isn't a cell reference, a function call, TRUE or FALSE/],
      ['=SUM(myName)', /uses the name "myName"/],
      ['=SUM(A1,SUM)', /uses SUM without calling it/],
      ['=Sheet1:Sheet2!A1', /uses references across sheets \(Sheet1:Sheet2!\), which OtherBench doesn't support/],
      ['=A1:Sheet2!B2', /uses references across sheets \(A1:Sheet2!\)/],
      ['=SUM(A1:A3)~', /has "~" at character 12, which OtherBench can't read in a formula/],
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

  it('names the length when the prefixes take a formula over the limit, and takes sheet names in any case', () => {
    const formula = '=' + 'STDEV.S(1)+'.repeat(700) + '1';
    expect(formula.length).toBeLessThanOrEqual(8193);
    const written = formulaForFile(formula, NAMES);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.error).toMatch(/is over 8192 characters once Excel's function prefixes are added/);
    expect(formulaForFile("=Costs!A1+'Second Sheet'!B2", new Set(['Costs', 'SECOND SHEET']))).toEqual({ ok: true, text: "Costs!A1+'Second Sheet'!B2" });
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

  it('checkOfficeContent checks spreadsheets and presentations by their source, and isOfficeKind knows the kinds', () => {
    expect(checkOfficeContent('document', 'anything at all')).toBeNull();
    expect(checkOfficeContent('presentation', '{')).toMatch(/isn't valid JSON/);
    expect(checkOfficeContent('presentation', '{"slides":[]}')).toBe('slides: must be a list of 1-200 slides');
    expect(checkOfficeContent('presentation', JSON.stringify({ slides: [{ layout: 'title', title: 'Hi' }] }))).toBeNull();
    expect(checkOfficeContent('markdown', '{')).toBeNull();
    expect(checkOfficeContent('spreadsheet', '{')).toMatch(/isn't valid JSON/);
    expect(checkOfficeContent('spreadsheet', sheet([['x']]))).toBeNull();
    expect(['document', 'spreadsheet', 'presentation', 'html'].map(isOfficeKind)).toEqual([true, true, true, false]);
  });

  it('the guidance covers the three formats and the refused functions, in about 2 KB and with no heading of its own', () => {
    for (const kind of ['"document"', '"spreadsheet"', '"presentation"', 'WEBSERVICE', 'two-column']) expect(OFFICE_GUIDANCE).toContain(kind);
    expect(OFFICE_GUIDANCE.length).toBeLessThan(2304);
    expect(OFFICE_GUIDANCE.split('\n').some((l) => l.startsWith('#'))).toBe(false);
  });
});

describe('checkOfficeContent: document size limits', () => {
  const doc = (content: string) => checkOfficeContent('document', content);
  const lines = (n: number, line = 'x') => Array.from({ length: n }, () => line).join('\n');
  const table = (rows: number) => ['| a | b |', '|---|---|', ...Array.from({ length: rows - 2 }, (_, i) => `| ${i} | y |`)].join('\n');
  const FENCE = '`'.repeat(3);

  it('accepts ordinary documents', () => {
    expect(doc('')).toBeNull();
    expect(doc('# Memo\n\nSome **bold** text, a [link](https://example.com).\n\n- one\n  - two\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBeNull();
  });

  it('refuses more lines than the limit, naming it, and accepts exactly the limit', () => {
    expect(doc(lines(MAX_DOCUMENT_LINES))).toBeNull();
    expect(doc(lines(MAX_DOCUMENT_LINES + 1))).toBe(`The document has ${(MAX_DOCUMENT_LINES + 1).toLocaleString('en-US')} lines; OtherBench makes Word files of at most ${MAX_DOCUMENT_LINES.toLocaleString('en-US')} lines. Split it into more than one document.`);
    expect(doc(lines(MAX_DOCUMENT_LINES + 1).replace(/\n/g, '\r\n'))).toMatch(/lines/);
  });

  it('refuses more characters than the limit, and accepts exactly the limit', () => {
    expect(doc('a'.repeat(MAX_DOCUMENT_CHARS))).toBeNull();
    expect(doc('a'.repeat(MAX_DOCUMENT_CHARS + 1))).toMatch(/characters; OtherBench makes Word files of at most 120,000 characters/);
  });

  it('refuses a table of more rows than the limit, and accepts exactly the limit', () => {
    expect(doc(table(MAX_DOCUMENT_TABLE_ROWS))).toBeNull();
    expect(doc(table(MAX_DOCUMENT_TABLE_ROWS + 1))).toMatch(/table of more than 1,000 rows/);
    // Without leading pipes it is still a table.
    const bare = ['a | b', '--|--', ...Array.from({ length: MAX_DOCUMENT_TABLE_ROWS }, (_, i) => `${i} | y`)].join('\n');
    expect(doc(bare)).toMatch(/table of more than 1,000 rows/);
    // A blank line starts a new table.
    expect(doc(`${table(MAX_DOCUMENT_TABLE_ROWS)}\n\n${table(MAX_DOCUMENT_TABLE_ROWS)}`)).toBeNull();
  });

  it('counts a pipe-free line after a table row as a row, as GFM does, until a blank line', () => {
    // GFM body rows need no pipe: a table runs until a blank line.
    const alternating = ['| a | b |', '|---|---|', ...Array.from({ length: MAX_DOCUMENT_TABLE_ROWS }, (_, i) => (i % 2 ? 'plain row' : '| x | y |'))].join('\n');
    expect(doc(alternating)).toMatch(/table of more than 1,000 rows/);
    expect(doc(['| a |', '|---|', ...Array.from({ length: MAX_DOCUMENT_TABLE_ROWS - 2 }, () => 'no pipe')].join('\n'))).toBeNull();
    // Pipe-free lines that don't follow a table row aren't counted.
    expect(doc(lines(MAX_DOCUMENT_LINES, 'prose'))).toBeNull();
    expect(doc(`${table(MAX_DOCUMENT_TABLE_ROWS)}\n\n${lines(MAX_DOCUMENT_TABLE_ROWS + 1, 'prose')}`)).toBeNull();
  });

  it('refuses a table of more cells (pipes) than the limit, wide or long, and accepts exactly the limit', () => {
    const wide = (columns: number, rows: number) => Array.from({ length: rows }, () => '|x'.repeat(columns)).join('\n');
    expect(doc(wide(MAX_DOCUMENT_TABLE_CELLS / 4, 4))).toBeNull();
    expect(doc(wide(MAX_DOCUMENT_TABLE_CELLS, 1))).toBeNull();
    expect(doc(wide(MAX_DOCUMENT_TABLE_CELLS + 1, 1))).toMatch(new RegExp(`table of more than ${MAX_DOCUMENT_TABLE_CELLS.toLocaleString('en-US')} cells \\(it passes that at line 1\\)`));
    expect(doc(wide(200, 250))).toMatch(/cells \(it passes that at line \d+\)/);
    expect(doc(wide(20_000, 2))).toMatch(/cells/);
    // Pipes in separate tables aren't added together.
    expect(doc(`${wide(MAX_DOCUMENT_TABLE_CELLS, 1)}\n\n${wide(MAX_DOCUMENT_TABLE_CELLS, 1)}`)).toBeNull();
  });

  it('refuses indentation past the limit (a tab is 4 columns) and accepts exactly the limit', () => {
    expect(doc(`${' '.repeat(MAX_DOCUMENT_INDENT)}- deep`)).toBeNull();
    expect(doc(`${' '.repeat(MAX_DOCUMENT_INDENT + 1)}- deep`)).toMatch(/Line 1 of the document is indented 25 columns; .* at most 24 columns/);
    expect(doc(`${'\t'.repeat(MAX_DOCUMENT_INDENT / 4)}- deep`)).toBeNull();
    expect(doc(`ok\n${'\t'.repeat(MAX_DOCUMENT_INDENT / 4 + 1)}- deep`)).toMatch(/Line 2 .* indented 28 columns/);
    expect(doc(`> ${' '.repeat(MAX_DOCUMENT_INDENT + 1)}- deep`)).toMatch(/indented/);
  });

  it('refuses quotes nested past the limit, spaced or not, and accepts exactly the limit', () => {
    expect(doc(`${'>'.repeat(MAX_DOCUMENT_QUOTE_DEPTH)} q`)).toBeNull();
    expect(doc(`${'> '.repeat(MAX_DOCUMENT_QUOTE_DEPTH)}q`)).toBeNull();
    expect(doc(`${'>'.repeat(MAX_DOCUMENT_QUOTE_DEPTH + 1)} q`)).toMatch(/quoted 9 levels deep; .* at most 8 levels deep/);
    expect(doc(`${'> '.repeat(MAX_DOCUMENT_QUOTE_DEPTH + 1)}q`)).toMatch(/quoted 9 levels/);
    expect(doc(`${'>'.repeat(10_000)} q`)).toMatch(/quoted 10,000 levels/);
  });

  it('refuses more formatting marks than the limit outside code, and accepts exactly the limit', () => {
    expect(doc('*'.repeat(MAX_DOCUMENT_MARKS))).toBeNull();
    expect(doc('*'.repeat(MAX_DOCUMENT_MARKS + 1))).toMatch(/more than 10,000 formatting marks/);
    expect(doc(`${FENCE}\n${'*'.repeat(50_000)}\n${FENCE}`)).toBeNull();
  });

  it('treats indentation, quotes and tables as ordinary code inside fenced blocks', () => {
    const deep = `${' '.repeat(100)}code`;
    expect(doc(`${FENCE}\n${deep}\n> > > > > > > > > > \n${FENCE}`)).toBeNull();
    expect(doc(`~~~js\n${deep}\n~~~`)).toBeNull();
    expect(doc(`${FENCE}\n${lines(2000, '| a | b |')}\n${FENCE}`)).toBeNull();
    // A longer fence is closed only by one as long; a shorter inner one is code.
    expect(doc(`${FENCE}\`\n${FENCE}\n${deep}\n${FENCE}\n${FENCE}\``)).toBeNull();
    // After the fence closes, indentation counts again.
    expect(doc(`${FENCE}\n${deep}\n${FENCE}\n${deep}`)).toMatch(/Line 4 .* indented 100 columns/);
    // An unclosed fence runs to the end.
    expect(doc(`${FENCE}\n${deep}`)).toBeNull();
  });

  it('checks a worst-case 120 KB document in a fraction of a second', () => {
    const worst = Array.from({ length: MAX_DOCUMENT_LINES }, (_, i) => `${' '.repeat((i % 12) * 2)}> - *a* | b`).join('\n').slice(0, MAX_DOCUMENT_CHARS);
    const start = performance.now();
    for (let i = 0; i < 20; i++) doc(worst);
    expect((performance.now() - start) / 20).toBeLessThan(250);
  });

  it('is only for documents', () => {
    expect(checkOfficeContent('markdown', lines(MAX_DOCUMENT_LINES + 1))).toBeNull();
  });
});

describe('parsePresentation', () => {
  const deck = (slides: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ slides, ...extra });
  function deckError(content: string): string {
    const parsed = parsePresentation(content);
    if (parsed.ok) throw new Error(`expected an error for ${content.slice(0, 80)}`);
    return parsed.error;
  }

  it('parses each layout as given', () => {
    const spec: PresentationSpec = {
      theme: { accent: '#1F4E79' },
      slides: [
        { layout: 'title', title: 'Q3 review', subtitle: 'October' },
        { layout: 'section', title: 'Results' },
        { layout: 'bullets', title: 'Highlights', bullets: ['Revenue up 12%', { text: 'Two new clients', level: 1 }], notes: 'Mention churn.' },
        { layout: 'two-column', title: 'Before and after', left: { heading: 'Before', bullets: ['Manual'] }, right: { bullets: ['Automatic'] } },
        { layout: 'table', title: 'Costs', table: { header: ['Item', 'Cost'], rows: [['Widgets', 12]] } },
      ],
    };
    expect(parsePresentation(JSON.stringify(spec))).toEqual({ ok: true, spec });
  });

  it('names the JSON path of each problem', () => {
    expect(deckError(deck([]))).toBe('slides: must be a list of 1-200 slides');
    expect(deckError(deck([{ layout: 'chart', title: 'X' }]))).toBe('slides[0].layout: must be one of: title, section, bullets, two-column, table');
    expect(deckError(deck([{ layout: 'bullets', title: 'X', bulets: ['a'] }]))).toBe('slides[0]: unknown key "bulets". Allowed: layout, title, bullets, notes.');
    expect(deckError(deck([{ layout: 'bullets', title: 'X', bullets: Array.from({ length: 21 }, () => 'b') }]))).toBe('slides[0].bullets: must be a list of 1-20 bullets');
    expect(deckError(deck([{ layout: 'bullets', title: 'X', bullets: [{ text: 'a', level: 3 }] }]))).toBe('slides[0].bullets[0].level: must be 0, 1 or 2');
    expect(deckError(deck([{ layout: 'table', title: 'X', table: { header: ['A', 'B'], rows: [['only one']] } }]))).toBe('slides[0].table.rows[0]: must have 2 cells, one for each header');
    expect(deckError(deck([{ layout: 'title', title: ' ' }]))).toBe('slides[0].title: must be text of 1-200 characters');
    expect(deckError(deck([{ layout: 'title', title: 'X' }], { theme: { accent: 'blue' } }))).toBe('theme.accent: must be a colour as #RRGGBB');
  });

  it('is what checkOfficeContent runs for a presentation', () => {
    expect(checkOfficeContent('presentation', '{')).toMatch(/isn't valid JSON/);
    expect(checkOfficeContent('presentation', deck([{ layout: 'title', title: 'X' }]))).toBeNull();
  });

  it('holds each limit and refuses one more', () => {
    const title = { layout: 'title', title: 'X' };
    expect(parsePresentation(deck(Array.from({ length: MAX_SLIDES }, () => title)))).toMatchObject({ ok: true });
    expect(deckError(deck(Array.from({ length: MAX_SLIDES + 1 }, () => title)))).toBe('slides: must be a list of 1-200 slides');
    const bullets = (n: number) => [{ layout: 'bullets', title: 'X', bullets: Array.from({ length: n }, () => 'b') }];
    expect(parsePresentation(deck(bullets(MAX_BULLETS)))).toMatchObject({ ok: true });
    expect(deckError(deck([{ layout: 'two-column', title: 'X', left: { bullets: ['a'] }, right: { bullets: [] } }]))).toBe('slides[0].right.bullets: must be a list of 1-20 bullets');
    const table = (header: unknown[], rows: unknown[][]) => [{ layout: 'table', title: 'X', table: { header, rows } }];
    const wide = Array.from({ length: MAX_TABLE_COLUMNS }, (_, i) => `C${i}`);
    expect(parsePresentation(deck(table(wide, [])))).toMatchObject({ ok: true });
    expect(deckError(deck(table([...wide, 'extra'], [])))).toBe('slides[0].table.header: must be a list of 1-10 column names');
    expect(parsePresentation(deck(table(['A'], Array.from({ length: MAX_TABLE_ROWS }, () => ['x']))))).toMatchObject({ ok: true });
    expect(deckError(deck(table(['A'], Array.from({ length: MAX_TABLE_ROWS + 1 }, () => ['x']))))).toBe('slides[0].table.rows: must be a list of at most 30 rows');
    expect(deckError(deck([{ layout: 'title', title: 'x'.repeat(201) }]))).toBe('slides[0].title: must be text of 1-200 characters');
    expect(deckError(deck([{ layout: 'title', title: 'X', subtitle: 'x'.repeat(301) }]))).toBe('slides[0].subtitle: must be text of at most 300 characters');
    expect(deckError(deck([{ layout: 'title', title: 'X', notes: 'x'.repeat(5001) }]))).toBe('slides[0].notes: must be text of at most 5000 characters');
  });

  it('refuses the wrong shape at each level', () => {
    expect(deckError('[]')).toBe('The content must be a JSON object: {"slides": [...]}.');
    expect(deckError(deck(['x']))).toBe('slides[0]: must be an object with "layout" and "title"');
    expect(deckError(deck([{ layout: 'constructor', title: 'X' }]))).toMatch(/^slides\[0\]\.layout: must be one of/);
    expect(deckError(deck([{ layout: 'bullets', title: 'X', bullets: [5] }]))).toBe('slides[0].bullets[0]: must be text or {"text": "...", "level": 0-2}');
    expect(deckError(deck([{ layout: 'bullets', title: 'X', bullets: ['  '] }]))).toBe('slides[0].bullets[0]: must be text of 1-500 characters');
    expect(deckError(deck([{ layout: 'bullets', title: 'X', bullets: [{ text: 'a', level: 0, extra: 1 }] }]))).toBe('slides[0].bullets[0]: unknown key "extra". Allowed: text, level.');
    expect(deckError(deck([{ layout: 'table', title: 'X', table: { header: ['A'], rows: [[true]] } }]))).toBe('slides[0].table.rows[0][0]: must be text of at most 200 characters');
    expect(deckError(deck([{ layout: 'title', title: 'X' }], { theme: { accent: '#12345' } }))).toBe('theme.accent: must be a colour as #RRGGBB');
    expect(deckError(deck([{ layout: 'title', title: 'X' }], { theme: { colour: '#123456' } }))).toBe('theme: unknown key "colour". Allowed: accent.');
  });

  it('refuses text the .pptx could not hold or would silently lose, naming the path', () => {
    const code = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    const places: [string, (text: string) => unknown][] = [
      ['slides[0].title', (t) => ({ layout: 'title', title: t })],
      ['slides[0].subtitle', (t) => ({ layout: 'section', title: 'X', subtitle: t })],
      ['slides[0].notes', (t) => ({ layout: 'title', title: 'X', notes: t })],
      ['slides[0].bullets[0]', (t) => ({ layout: 'bullets', title: 'X', bullets: [t] })],
      ['slides[0].bullets[1].text', (t) => ({ layout: 'bullets', title: 'X', bullets: ['ok', { text: t, level: 2 }] })],
      ['slides[0].left.heading', (t) => ({ layout: 'two-column', title: 'X', left: { heading: t, bullets: ['a'] }, right: { bullets: ['b'] } })],
      ['slides[0].right.bullets[0]', (t) => ({ layout: 'two-column', title: 'X', left: { bullets: ['a'] }, right: { bullets: [t] } })],
      ['slides[0].table.header[1]', (t) => ({ layout: 'table', title: 'X', table: { header: ['A', t], rows: [] } })],
      ['slides[0].table.rows[1][0]', (t) => ({ layout: 'table', title: 'X', table: { header: ['A'], rows: [['ok'], [t]] } })],
    ];
    for (const cp of [0x01, 0x0b, 0x1f, 0x7f, 0x84, 0x90, 0x9f, 0xd800, 0xdc00, 0xfdd0, 0xfffd, 0xfffe, 0xffff]) {
      for (const [path, make] of places) {
        // JSON.stringify writes a lone surrogate as an escape, which JSON.parse reads back.
        expect(deckError(deck([make(`a${String.fromCharCode(cp)}b`)])), `${code(cp)} in ${path}`).toBe(`${path}: has the character ${code(cp)}, which slide text can't hold`);
      }
    }
    expect(deckError(deck([{ layout: 'title', title: `a${String.fromCodePoint(0x1fffe)}` }]))).toBe("slides[0].title: has the character U+1FFFE, which slide text can't hold");
    // Tab, line feed, carriage return, U+0085, a surrogate pair and ordinary text are fine.
    const fine = 'Café 😀 tab\tline\nreturn\rnext\u0085   ﻿';
    expect(parsePresentation(deck([{ layout: 'bullets', title: fine, bullets: [fine], notes: fine }]))).toMatchObject({ ok: true });
  });

  it('reads a full deck in a fraction of a second', () => {
    const text = 'a '.repeat(250);
    const slides = Array.from({ length: MAX_SLIDES }, () => ({ layout: 'bullets', title: 'X', bullets: Array.from({ length: MAX_BULLETS }, () => text), notes: text.repeat(10) }));
    const content = deck(slides);
    const start = performance.now();
    for (let i = 0; i < 5; i++) parsePresentation(content);
    expect((performance.now() - start) / 5).toBeLessThan(250);
  });
});
