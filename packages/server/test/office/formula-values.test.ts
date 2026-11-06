import { describe, expect, it } from 'vitest';
import type { Cell, SheetSpec } from '@otherbench/core/domain/office-spec.js';
import { cachedFormulaValues, type CachedValue } from '../../src/office/formula-values.js';

const n = (v: string): CachedValue => ({ t: 'n', v });
const s = (v: string): CachedValue => ({ t: 'str', v });
const TRUE: CachedValue = { t: 'b', v: '1' };
const FALSE: CachedValue = { t: 'b', v: '0' };

/** The cached value of `formula` written in column A of the row after `rows` (so the rows above are A1, A2, ...), on sheet "S". */
function calc(formula: string, rows: Cell[][] = [], others: SheetSpec[] = []): CachedValue | null {
  const sheet: SheetSpec = { name: 'S', rows: [...rows, [formula]] };
  return cachedFormulaValues({ sheets: [sheet, ...others] })(0, rows.length, 0);
}

/** Every cached value of a one-sheet workbook, by A1 reference (only the formula cells). */
function all(rows: Cell[][], others: SheetSpec[] = []): Record<string, CachedValue | null> {
  const values = cachedFormulaValues({ sheets: [{ name: 'S', rows }, ...others] });
  const out: Record<string, CachedValue | null> = {};
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if ((typeof cell === 'string' && cell.startsWith('=')) || (cell !== null && typeof cell === 'object' && cell.formula !== undefined)) {
        out[`${String.fromCharCode(65 + c)}${r + 1}`] = values(0, r, c);
      }
    }),
  );
  return out;
}

describe('cached formula values: literals and operators', () => {
  it.each([
    ['=1', n('1')],
    ['=1.5e3', n('1500')],
    ['=.5', n('0.5')],
    ['="abc"', s('abc')],
    ['="say ""hi"""', s('say "hi"')],
    ['=TRUE', TRUE],
    ['=false', FALSE],
    ['=1+2*3', n('7')],
    ['=(1+2)*3', n('9')],
    ['=10-4-3', n('3')],
    ['=12/4/3', n('1')],
    // Negation binds tighter than ^ in Excel, and ^ goes left to right.
    ['=-2^2', n('4')],
    ['=2-2^2', n('-2')],
    ['=2^3^2', n('64')],
    ['=2^-1', n('0.5')],
    ['=--3', n('3')],
    ['=+5', n('5')],
    ['=10%', n('0.1')],
    ['=50%*4', n('2')],
    ['=-5%', n('-0.05')],
    ['=TRUE+1', n('2')],
    ['=-TRUE', n('-1')],
    ['=FALSE*5', n('0')],
    ['=1 + 2', n('3')],
    ['=SUM(1,\n  2)', n('3')],
  ])('%s', (formula, expected) => expect(calc(formula)).toEqual(expected));

  it('leaves errors uncached: #DIV/0!, error literals and 0^0', () => {
    for (const f of ['=1/0', '=0/0', '=#N/A', '=1+#REF!', '=0^0', '=0^-1', '=(-8)^(1/3)']) expect(calc(f), f).toBeNull();
  });

  it('leaves numbers Excel cannot hold, and literals with more than 15 significant digits, uncached', () => {
    expect(calc('=10^400')).toBeNull();
    expect(calc('=1E308*10')).toBeNull();
    expect(calc('=1E-320*1')).toBeNull();
    expect(calc('=0.1234567890123456')).toBeNull();
    expect(calc('=123456789012345')).toEqual(n('123456789012345'));
  });

  it('writes numbers with 15 significant digits, so binary noise is not shown', () => {
    expect(calc('=0.1+0.2')).toEqual(n('0.3'));
    expect(calc('=1.1-1')).toEqual(n('0.1'));
    expect(calc('=1/3')).toEqual(n('0.333333333333333'));
    expect(calc('=2/3')).toEqual(n('0.666666666666667'));
    expect(calc('=1E20*10')).toEqual(n('1E+21'));
    expect(calc('=1E-7*1')).toEqual(n('1E-7'));
    expect(calc('=0*-1')).toEqual(n('0'));
    expect(calc('=2^53')).toEqual(n('9007199254740990'));
  });

  it('leaves a sum that cancels to almost nothing uncached, where Excel may give exactly 0', () => {
    expect(calc('=0.5-0.4-0.1')).toBeNull();
    expect(calc('=SUM(0.1,0.2,-0.3)')).toBeNull();
    expect(calc('=0.3-0.3')).toEqual(n('0'));
    expect(calc('=5-5')).toEqual(n('0'));
  });

  it('leaves text in arithmetic uncached, as Excel converts "3" or a date by locale', () => {
    expect(calc('="3"+1')).toBeNull();
    expect(calc('=-"3"')).toBeNull();
    expect(calc('=A1*2', [['abc']])).toBeNull();
    expect(calc('=A1*2', [['12']])).toBeNull();
  });
});

describe('cached formula values: empty cells', () => {
  it('reads an empty cell as 0 in arithmetic and "" in &', () => {
    expect(calc('=A1+1', [[null]])).toEqual(n('1'));
    expect(calc('=B1*2', [[1]])).toEqual(n('0'));
    expect(calc('=A1&"x"', [[null]])).toEqual(s('x'));
    expect(calc('=-A1', [[null]])).toEqual(n('0'));
    expect(calc('=Z99+1')).toEqual(n('1'));
  });

  it('gives 0 for a formula that is only a reference to an empty cell, as Excel shows it', () => {
    expect(calc('=A1', [[null]])).toEqual(n('0'));
    expect(calc('=IF(TRUE,A1)', [[null]])).toEqual(n('0'));
  });

  it('treats text "" as an empty cell, since the writer leaves such a cell out', () => {
    expect(calc('=A1+1', [['']])).toEqual(n('1'));
    expect(calc('=COUNTA(A1)', [[{ value: '' }]])).toEqual(n('0'));
  });

  it('matches an empty cell to the other side in a comparison: 0, "" or FALSE', () => {
    expect(calc('=A1=0', [[null]])).toEqual(TRUE);
    expect(calc('=A1=""', [[null]])).toEqual(TRUE);
    expect(calc('=A1=FALSE', [[null]])).toEqual(TRUE);
    expect(calc('=A1<1', [[null]])).toEqual(TRUE);
    expect(calc('=A1=B1', [[null]])).toEqual(TRUE);
    expect(calc('=A1="a"', [[null]])).toEqual(FALSE);
  });
});

describe('cached formula values: & and number-to-text', () => {
  it.each([
    ['="a"&"b"', 'ab'],
    ['="a"&1+2', 'a3'],
    ['=1&2', '12'],
    ['=12.5&""', '12.5'],
    ['=-3&""', '-3'],
    ['=0.1+0.2&""', '0.3'],
    ['=1/3&""', '0.333333333333333'],
    ['=100/7&""', '14.2857142857143'],
    ['=0.001&""', '0.001'],
    ['=123456789012345&""', '123456789012345'],
    ['=TRUE&""', 'TRUE'],
    ['=FALSE&"!"', 'FALSE!'],
  ])('%s gives %j', (formula, text) => expect(calc(formula)).toEqual(s(text)));

  it('leaves numbers whose General text may be scientific uncached', () => {
    expect(calc('=1E15&""')).toBeNull();
    expect(calc('=0.0001&""')).toBeNull();
    expect(calc('=1E-20&""')).toBeNull();
  });

  it('leaves a result over 32,767 characters uncached', () => {
    expect(calc('=A1&"b"', [['a'.repeat(32_767)]])).toBeNull();
    expect(calc('=A1&""', [['a'.repeat(32_767)]])).toEqual(s('a'.repeat(32_767)));
  });

  it("doesn't cache text with whitespace at its ends or a line break, which a viewer may not keep", () => {
    expect(calc('=A1&""', [[' a']])).toBeNull();
    expect(calc('="a "')).toBeNull();
    expect(calc('="a\nb"')).toBeNull();
    // The value is still used by what depends on it.
    expect(all([[' a', '=A1&"b"', '=LEN(B1)', '=IF(B1=" ab","yes","no")']])).toEqual({ B1: null, C1: null, D1: s('yes') });
  });

  it('caches non-ASCII text', () => {
    expect(calc('=A1&"!"', [['Café 😀']])).toEqual(s('Café 😀!'));
  });

  it('leaves text the writer would alter (a CR, U+0090) uncached', () => {
    expect(calc('=A1&""', [['a\rb']])).toBeNull();
    expect(calc('=A1&""', [['a\u0090b']])).toBeNull();
    // U+0085 is one the writer keeps.
    expect(calc('=A1&""', [['a\u0085b']])).toEqual(s('a\u0085b'));
  });
});

describe('cached formula values: comparisons', () => {
  it.each([
    ['=1<2', TRUE],
    ['=2<=2', TRUE],
    ['=3>4', FALSE],
    ['=3>=4', FALSE],
    ['=1=1', TRUE],
    ['=1<>1', FALSE],
    // Text is compared ignoring case.
    ['="a"="A"', TRUE],
    ['="abc"<>"ABC"', FALSE],
    ['="a"<"B"', TRUE],
    ['="b"<"A"', FALSE],
    ['="ab"<"abc"', TRUE],
    ['="10"<"9"', TRUE],
    ['="a1"<"aa"', TRUE],
    ['=""<"a"', TRUE],
    // Numbers < text < TRUE/FALSE, whatever the values.
    ['="abc">5', TRUE],
    ['="1"=1', FALSE],
    ['="a"<999999', FALSE],
    ['=TRUE>1', TRUE],
    ['=FALSE>"z"', TRUE],
    ['=TRUE=1', FALSE],
    ['=TRUE>FALSE', TRUE],
    // Left to right: (1<2)<3 is TRUE<3.
    ['=1<2<3', FALSE],
    ['="é"="é"', TRUE],
    ['="é"="e"', null],
    ['="é"="É"', null],
    ['="a-b"<"ab"', null],
    ['="a b"<"ab"', null],
    // Equal at Excel's 15 digits but not as doubles: left alone.
    ['=0.1+0.2=0.3', null],
    ['=0.1+0.2>0.3', null],
    ['=1/3=1/3', TRUE],
  ])('%s', (formula, expected) => expect(calc(formula)).toEqual(expected));

  it('gives an error from either side as the result, uncached', () => {
    expect(calc('=1/0=1')).toBeNull();
  });
});

describe('cached formula values: references', () => {
  const MY_SHEET: SheetSpec = { name: 'My Sheet', rows: [[10, 20], [30]] };
  const DONNEES: SheetSpec = { name: 'Données', rows: [[7]] };

  it('reads cells on the same sheet, with and without $', () => {
    expect(calc('=A1+B1', [[2, 3]])).toEqual(n('5'));
    expect(calc('=$A$1*A$1*$A1', [[2]])).toEqual(n('8'));
  });

  it('reads cells and ranges on other sheets, quoted or not, and a non-ASCII name', () => {
    expect(calc("='My Sheet'!B1", [], [MY_SHEET])).toEqual(n('20'));
    expect(calc("=SUM('My Sheet'!A1:B2)", [], [MY_SHEET])).toEqual(n('60'));
    expect(calc("='my sheet'!A2", [], [MY_SHEET])).toEqual(n('30'));
    expect(calc('=Données!A1*2', [], [DONNEES])).toEqual(n('14'));
    expect(calc("='Données'!A1", [], [DONNEES])).toEqual(n('7'));
    // Excel matches names ignoring case, but how it folds non-ASCII isn't known here.
    expect(calc("='DONNÉES'!A1", [], [DONNEES])).toBeNull();
  });

  it('reads a formula on another sheet that comes later in the workbook', () => {
    const second: SheetSpec = { name: 'Data', rows: [[4, '=A1*10']] };
    expect(calc('=Data!B1+1', [], [second])).toEqual(n('41'));
  });

  it('reads a formula below or to the right of the one that refers to it', () => {
    expect(all([['=B1*2', '=C1+1', 3]])).toEqual({ A1: n('8'), B1: n('4') });
  });

  it('reads whole columns and rows', () => {
    expect(all([[1, '=SUM(A:A)'], [2], [3]])).toEqual({ B1: n('6') });
    expect(all([[1, 2, 3], ['=SUM(1:1)']])).toEqual({ A2: n('6') });
  });

  it('reads dates as the serial numbers the writer stores', () => {
    expect(calc('=A1+1', [[{ date: '2026-01-01' }]])).toEqual(n('46024'));
    expect(calc('=A2-A1', [[{ date: '2026-01-01' }], [{ date: '2026-03-01' }]])).toEqual(n('59'));
    expect(calc('=A1', [[{ date: '2026-01-01T12:00' }]])).toEqual(n('46023.5'));
  });

  it('reads cell objects by their value, whatever their format', () => {
    expect(calc('=A1+B1+C1', [[{ value: 2, format: '0.00' }, { value: true, bold: true }, { bold: true }]])).toEqual(n('3'));
    expect(calc('=A1&""', [[{ value: 'x', italic: true }]])).toEqual(s('x'));
  });

  it('leaves a range where one value is wanted uncached (implicit intersection, or a spill)', () => {
    expect(calc('=A1:A2', [[1], [2]])).toBeNull();
    expect(calc('=A1:A2*2', [[1], [2]])).toBeNull();
    expect(calc('=A1:A1+1', [[1]])).toBeNull();
    expect(calc('=IF(A1:A2,1,2)', [[1], [2]])).toBeNull();
  });

  it('leaves the intersection operator and ranges of more than two cells uncached', () => {
    expect(calc('=SUM(A1:B2 B1:B2)', [[1, 2], [3, 4]])).toBeNull();
    expect(calc('=SUM(A1:B1:B2)', [[1, 2], [3, 4]])).toBeNull();
  });
});

describe('cached formula values: SUM, AVERAGE, MIN, MAX', () => {
  const MIXED: Cell[][] = [[1], ['x'], [true], [null], [4]];

  it('skips text, TRUE/FALSE and empty cells in a reference', () => {
    expect(calc('=SUM(A1:A5)', MIXED)).toEqual(n('5'));
    expect(calc('=AVERAGE(A1:A5)', MIXED)).toEqual(n('2.5'));
    expect(calc('=MIN(A1:A5)', MIXED)).toEqual(n('1'));
    expect(calc('=MAX(A1:A5)', MIXED)).toEqual(n('4'));
    // A single cell is a reference too.
    expect(calc('=SUM(A1)', [[true]])).toEqual(n('0'));
  });

  it('counts TRUE/FALSE typed as an argument, and leaves typed text uncached', () => {
    expect(calc('=SUM(TRUE,2)')).toEqual(n('3'));
    expect(calc('=AVERAGE(TRUE,3)')).toEqual(n('2'));
    expect(calc('=MIN(5,FALSE)')).toEqual(n('0'));
    expect(calc('=MAX(-1,TRUE)')).toEqual(n('1'));
    expect(calc('=SUM(1=1,1)')).toEqual(n('2'));
    expect(calc('=SUM("3",1)')).toBeNull();
    expect(calc('=MAX("x",1)')).toBeNull();
  });

  it('gives 0 for MIN and MAX of no numbers, and #DIV/0! (uncached) for AVERAGE of none', () => {
    expect(calc('=MIN(A1:A2)', [['x'], [null]])).toEqual(n('0'));
    expect(calc('=MAX(A1)', [[null]])).toEqual(n('0'));
    expect(calc('=AVERAGE(A1:A2)', [['x'], [null]])).toBeNull();
    expect(all([[null, '=AVERAGE(A1)', '=COUNT(B1)']])).toEqual({ B1: null, C1: n('0') });
  });

  it('gives an error in the arguments or the range as the result, uncached', () => {
    expect(calc('=SUM(1/0,1)')).toBeNull();
    expect(all([['=1/0'], ['=SUM(A1,1)'], ['=MAX(A1:A1)']])).toEqual({ A1: null, A2: null, A3: null });
  });

  it('sums several arguments and ranges', () => {
    expect(calc('=SUM(A1:A2,B1,10)', [[1, 5], [2]])).toEqual(n('18'));
    expect(calc('=SUM(0.1,0.2)')).toEqual(n('0.3'));
  });

  it('leaves an empty argument and a call with no arguments uncached', () => {
    expect(calc('=SUM(1,,2)')).toBeNull();
    expect(calc('=SUM()')).toBeNull();
  });
});

describe('cached formula values: COUNT and COUNTA', () => {
  it('COUNT counts numbers in a reference, and numbers and TRUE/FALSE typed as arguments', () => {
    expect(calc('=COUNT(A1:A5)', [[1], ['x'], [true], [null], [{ date: '2026-01-01' }]])).toEqual(n('2'));
    expect(calc('=COUNT(TRUE,1,2)')).toEqual(n('3'));
    expect(calc('=COUNT("x")')).toBeNull();
  });

  it('COUNT skips errors, in a reference and typed', () => {
    expect(all([['=1/0'], [2], ['=COUNT(A1:A2)'], ['=COUNT(1/0,1)']])).toEqual({ A1: null, A3: n('1'), A4: n('1') });
  });

  it('COUNTA counts every cell that is not empty, errors and formulas giving "" included', () => {
    expect(calc('=COUNTA(A1:A4)', [[1], ['x'], [true], [null]])).toEqual(n('3'));
    expect(all([['=1/0'], ['=""'], [null], ['=COUNTA(A1:A3)']])).toEqual({ A1: null, A2: s(''), A4: n('2') });
    expect(calc('=COUNTA("x",1,TRUE)')).toEqual(n('3'));
  });
});

describe('cached formula values: IF, AND, OR, NOT', () => {
  it.each([
    ['=IF(1,"y","n")', s('y')],
    ['=IF(0,"y","n")', s('n')],
    ['=IF(-2,"y","n")', s('y')],
    ['=IF(0.5,"y","n")', s('y')],
    ['=IF(FALSE,1)', FALSE],
    ['=IF(TRUE,1)', n('1')],
    ['=IF(1<2,"a"&"b",0)', s('ab')],
    // Only the branch taken is worked out.
    ['=IF(TRUE,1,1/0)', n('1')],
    ['=IF(FALSE,1/0,2)', n('2')],
    ['=IF(FALSE,VLOOKUP(1,B1:C2,2),3)', n('3')],
    ['=IF(TRUE,VLOOKUP(1,B1:C2,2),3)', null],
    ['=IF("x",1,2)', null],
    ['=IF(1/0,1,2)', null],
    ['=IF(TRUE,,1)', null],
    ['=IF(TRUE)', null],
    ['=AND(TRUE,1)', TRUE],
    ['=AND(TRUE,0)', FALSE],
    ['=AND(1=1,2>1)', TRUE],
    ['=OR(FALSE,0)', FALSE],
    ['=OR(FALSE,3)', TRUE],
    ['=AND("TRUE")', null],
    ['=AND(TRUE,1/0)', null],
    ['=NOT(0)', TRUE],
    ['=NOT(1)', FALSE],
    ['=NOT(TRUE)', FALSE],
    ['=NOT("x")', null],
    ['=NOT(1,2)', null],
  ])('%s', (formula, expected) => expect(calc(formula)).toEqual(expected));

  it('reads an empty cell as FALSE', () => {
    expect(calc('=IF(A1,1,2)', [[null]])).toEqual(n('2'));
    expect(calc('=NOT(A1)', [[null]])).toEqual(TRUE);
  });

  it('gives a "" from IF as text, the usual guard against dividing by zero', () => {
    expect(calc('=IF(A2=0,"",A1/A2)', [[5], [0]])).toEqual(s(''));
    expect(calc('=IF(A2=0,"",A1/A2)', [[5], [2]])).toEqual(n('2.5'));
  });

  it('returns a reference from IF, so SUM treats it as one', () => {
    expect(calc('=SUM(IF(TRUE,A1:A2,0))', [[true], [3]])).toEqual(n('3'));
  });

  it('AND and OR skip text and empty cells in a reference, and give #VALUE! (uncached) when nothing is left', () => {
    expect(calc('=AND(A1:A3)', [[1], ['x'], [null]])).toEqual(TRUE);
    expect(calc('=OR(A1:A3)', [[0], ['x'], [false]])).toEqual(FALSE);
    expect(calc('=AND(A1:A2)', [['x'], [null]])).toBeNull();
  });
});

describe('cached formula values: ROUND, ROUNDUP, ROUNDDOWN, ABS', () => {
  it.each([
    // Half away from zero, on the decimal Excel shows rather than the double.
    ['=ROUND(2.5,0)', '3'],
    ['=ROUND(-2.5,0)', '-3'],
    ['=ROUND(0.5,0)', '1'],
    ['=ROUND(2.675,2)', '2.68'],
    ['=ROUND(1.005,2)', '1.01'],
    ['=ROUND(-1.005,2)', '-1.01'],
    ['=ROUND(1234.5,-2)', '1200'],
    ['=ROUND(1250,-2)', '1300'],
    ['=ROUND(0.005,2)', '0.01'],
    ['=ROUND(-0.004,2)', '0'],
    ['=ROUND(0.004,1)', '0'],
    ['=ROUND(5,2)', '5'],
    ['=ROUND(1/3,4)', '0.3333'],
    ['=ROUND(0.1+0.2,2)', '0.3'],
    ['=ROUND(TRUE,0)', '1'],
    ['=ROUNDUP(3.2,0)', '4'],
    ['=ROUNDUP(-3.2,0)', '-4'],
    ['=ROUNDUP(3.14159,3)', '3.142'],
    ['=ROUNDUP(0.0004,2)', '0.01'],
    ['=ROUNDUP(3,0)', '3'],
    ['=ROUNDDOWN(3.7,0)', '3'],
    ['=ROUNDDOWN(-3.7,0)', '-3'],
    ['=ROUNDDOWN(3.799,2)', '3.79'],
    ['=ROUNDDOWN(1999,-3)', '1000'],
    ['=ABS(-3)', '3'],
    ['=ABS(2.5)', '2.5'],
  ])('%s is %s', (formula, value) => expect(calc(formula)).toEqual(n(value)));

  it('reads an empty cell as 0', () => {
    expect(calc('=ROUND(A1,0)', [[null]])).toEqual(n('0'));
    expect(calc('=ABS(A1)', [[null]])).toEqual(n('0'));
    expect(calc('=ROUND(A1,A2)', [[1.25], [null]])).toEqual(n('1'));
  });

  it('leaves the cases it is unsure of uncached', () => {
    // The double just above 0.3 rounds up past it; at 15 digits it doesn't.
    expect(calc('=ROUNDUP(0.1+0.2,1)')).toBeNull();
    // num_digits that isn't whole, or past 15.
    expect(calc('=ROUND(1.25,0.5)')).toBeNull();
    expect(calc('=ROUND(1.25,16)')).toBeNull();
    // TRUE/FALSE or text in a cell, text typed, a range, the wrong number of arguments.
    expect(calc('=ROUND(A1,0)', [[true]])).toBeNull();
    expect(calc('=ABS(A1)', [['3']])).toBeNull();
    expect(calc('=ROUND("1.5",0)')).toBeNull();
    expect(calc('=ABS(A1:A2)', [[1], [2]])).toBeNull();
    expect(calc('=ROUND(1)')).toBeNull();
    expect(calc('=ABS(1,2)')).toBeNull();
  });
});

describe('cached formula values: what is left uncached', () => {
  it('leaves other functions, arrays and prefixed functions uncached, and anything that uses them', () => {
    expect(all([[1, '=VLOOKUP(1,A1:B1,2)', '=B1+1', '=SUM(B1:C1)', '={1,2}', '=XLOOKUP(1,A1:A1,A1:A1)', '=LEN("abc")']])).toEqual({
      B1: null,
      C1: null,
      D1: null,
      E1: null,
      F1: null,
      G1: null,
    });
  });

  it('leaves a formula in a cycle, and anything that refers to one, uncached', () => {
    expect(all([['=B1+1', '=A1+1', '=A1*2', '=5']])).toEqual({ A1: null, B1: null, C1: null, D1: n('5') });
    expect(all([['=A1']])).toEqual({ A1: null });
    expect(all([[1], [2], ['=SUM(A:A)']])).toEqual({ A3: null });
  });

  it('finds a cycle through a branch IF does not take, as Excel does', () => {
    expect(all([['=IF(TRUE,1,A1)']])).toEqual({ A1: null });
    expect(all([['=IF(TRUE,1,B1)', '=A1']])).toEqual({ A1: null, B1: null });
  });

  it('finds a cycle across sheets', () => {
    const other: SheetSpec = { name: 'T', rows: [['=S!A1']] };
    expect(all([['=T!A1'], ['=1']], [other])).toEqual({ A1: null, A2: n('1') });
  });

  it('leaves the whole workbook uncached when a reference cannot be known from the text (OFFSET, or ":" after a call)', () => {
    expect(all([[1, '=OFFSET(A1,0,0)', '=1+1']])).toEqual({ B1: null, C1: null });
    expect(all([[1, '=SUM(A1:INDEX(A1:A2,1))', '=1+1']])).toEqual({ B1: null, C1: null });
  });

  it('leaves a formula nested past Excel\'s 64 levels uncached', () => {
    expect(calc(`=${'('.repeat(70)}1${')'.repeat(70)}`)).toBeNull();
    expect(calc(`=${'('.repeat(60)}1${')'.repeat(60)}`)).toEqual(n('1'));
    expect(calc(`=${'-'.repeat(70)}1`)).toBeNull();
    expect(calc(`=1${'+1'.repeat(300)}`)).toBeNull();
    expect(calc(`=1${'+1'.repeat(200)}`)).toEqual(n('201'));
  });

  it('gives nothing for a formula that would not be written', () => {
    expect(cachedFormulaValues({ sheets: [{ name: 'S', rows: [['=SUM(']] }] })(0, 0, 0)).toBeNull();
  });
});

describe('cached formula values: size', () => {
  it('counts the empty rows a range walks over against the budget', () => {
    // 100 whole-column sums over 200,100 rows with nothing in column B: no cell is read, yet each walks every row.
    const rows: Cell[][] = [...Array.from({ length: 100 }, (): Cell[] => ['=SUM(B:B)']), ...Array.from({ length: 200_000 }, (): Cell[] => [])];
    const values = cachedFormulaValues({ sheets: [{ name: 'S', rows }] });
    expect(values(0, 0, 0)).toEqual(n('0'));
    expect(values(0, 99, 0)).toBeNull();
  });

  it('works down a long chain of formulas in dependency order, without recursion', () => {
    const rows: Cell[][] = Array.from({ length: 5000 }, (_, r) => [1, r === 0 ? '=A1' : `=B${r}+A${r + 1}`]);
    const summary: SheetSpec = { name: 'Summary', rows: [['=Data!B5000']] };
    const values = cachedFormulaValues({ sheets: [summary, { name: 'Data', rows }] });
    expect(values(0, 0, 0)).toEqual(n('5000'));
    expect(values(1, 4999, 1)).toEqual(n('5000'));
  });

  it('works out a long reversed chain (each formula refers to the one below)', () => {
    const rows: Cell[][] = Array.from({ length: 3000 }, (_, r) => [r === 2999 ? 1 : `=A${r + 2}+1`]);
    expect(cachedFormulaValues({ sheets: [{ name: 'S', rows }] })(0, 0, 0)).toEqual(n('3000'));
  });

  it('stops promptly on a workbook that would take too long, leaving the rest uncached', () => {
    // 6,000 running totals over a growing range read 18 million cells.
    const rows: Cell[][] = Array.from({ length: 6000 }, (_, r) => [1, `=SUM($A$1:A${r + 1})`]);
    const start = Date.now();
    const values = cachedFormulaValues({ sheets: [{ name: 'S', rows }] });
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(values(0, 0, 1)).toEqual(n('1'));
    expect(values(0, 5999, 1)).toBeNull();
  });

  it('gives up on the whole workbook when finding the dependencies would take too long', () => {
    // Each of 3,000 formulas depends on every formula above it: 4.5 million edges.
    const rows: Cell[][] = Array.from({ length: 3000 }, (_, r) => [r === 0 ? 1 : `=SUM(A$1:A${r})`]);
    const start = Date.now();
    const values = cachedFormulaValues({ sheets: [{ name: 'S', rows }] });
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(values(0, 1, 0)).toBeNull();
  });
});
