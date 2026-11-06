import { EXCEL_MAX_CELL_CHARS, EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS, formulaTokens, lostCharacter, parseCellDate, xmlSafe } from '@otherbench/core/domain/office-spec.js';
import type { Cell, FormulaToken, SpreadsheetSpec } from '@otherbench/core/domain/office-spec.js';

/**
 * Cached values for a spreadsheet's formulas (Deck #928). The .xlsx writer
 * still asks Excel to calculate everything on open; these are only what a
 * viewer that doesn't calculate (Protected View, preview panes, phones, Drive)
 * shows in the meantime. A wrong cached value is worse than none, so this
 * calculates a small subset the way Excel does and gives up (null) on
 * anything else, and on anything that depends on something it gave up on.
 *
 * The subset: number, text and TRUE/FALSE literals; + - * / ^ %, unary + and
 * -, &, = <> < <= > >=; references to cells and ranges on any sheet ($ or
 * not, quoted sheet names); SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, AND,
 * OR, NOT, ROUND, ROUNDUP, ROUNDDOWN and ABS. Errors are worked out (so COUNT
 * can skip them and an IF can step round them) but a formula whose result is
 * an error gets no cached value. Circular references are found from every
 * reference a formula holds, taken or not, as Excel finds them.
 *
 * Where Excel's behaviour isn't certain the answer is "unknown": text in
 * arithmetic (Excel converts "3" and "1,000" and dates by locale), ordering
 * text that isn't plain letters and digits, comparing non-ASCII text that
 * isn't identical, numbers that differ only past the 15th significant digit
 * when compared, rounded or made into text, and sums that cancel to a value
 * so small that Excel's own adjustment to 0 may apply.
 */

/** A formula cell's cached value: `t` is the cell's type ('n' is written as no `t`) and `v` the text of its `<v>`. */
export interface CachedValue {
  t: 'n' | 'b' | 'str';
  v: string;
}

type Scalar = { k: 'num'; n: number } | { k: 'str'; s: string } | { k: 'bool'; b: boolean } | { k: 'err'; e: string } | { k: 'empty' } | { k: 'unknown' };

/** A reference: one cell (`single`) or a rectangle, zero-based and inclusive. */
interface Area {
  k: 'area';
  sheet: number;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  single: boolean;
}

type Value = Scalar | Area;

type NodeBody =
  | { t: 'value'; v: Scalar }
  | { t: 'area'; a: Area }
  | { t: 'unary'; op: string; a: Node }
  | { t: 'binary'; op: string; a: Node; b: Node }
  | { t: 'call'; name: string; args: (Node | null)[] };

/** A parsed formula; `h` is the height of the tree below it. */
type Node = NodeBody & { h: number };

const UNKNOWN: Scalar = { k: 'unknown' };
const EMPTY: Scalar = { k: 'empty' };
const DIV0: Scalar = { k: 'err', e: '#DIV/0!' };
const VALUE_ERROR: Scalar = { k: 'err', e: '#VALUE!' };
const num = (n: number): Scalar => ({ k: 'num', n: n === 0 ? 0 : n });
const str = (s: string): Scalar => ({ k: 'str', s });
const bool = (b: boolean): Scalar => ({ k: 'bool', b });

/** The largest number Excel takes, and the smallest normal double: anything past either is left uncached. */
const MAX_NUMBER = 9.99999999999999e307;
const MIN_NORMAL = 2.2250738585072014e-308;
/** Excel's own limit on nesting is 64 levels of functions. */
const MAX_DEPTH = 64;
/** A formula's tree is evaluated recursively, so a very long chain of operators is left uncached rather than risk the stack. */
const MAX_HEIGHT = 256;
/** Columns looked at and dependencies found while working out which formulas each formula depends on; past this nothing is cached. */
const GRAPH_BUDGET = 2_000_000;
/** Cells read while calculating; past this the rest are left uncached. */
const EVAL_BUDGET = 10_000_000;
/** A sum or difference this much smaller than what went into it may be one Excel sets to 0 ("close to zero" results). */
const CANCELLED = 1e-14;
const PREFIXES = /^(?:_xl(?:fn|ws)\.)+/i;

class Unparsed extends Error {}
class OutOfBudget extends Error {}

/** A number that Excel can hold, or unknown. */
function finite(n: number): Scalar {
  const a = Math.abs(n);
  return Number.isFinite(n) && a <= MAX_NUMBER && (a === 0 || a >= MIN_NORMAL) ? num(n) : UNKNOWN;
}

const round15 = (n: number): number => Number(n.toPrecision(15));

/** a + b, or unknown when it cancels to almost nothing (Excel may make such a result exactly 0). */
function add(a: number, b: number): Scalar {
  const r = a + b;
  if (r !== 0 && Math.abs(r) < Math.max(Math.abs(a), Math.abs(b)) * CANCELLED) return UNKNOWN;
  return finite(r);
}

/** -1, 0 or 1, or null when the answer differs between full precision and Excel's 15 significant digits. */
function compareNumbers(a: number, b: number): number | null {
  const order = (x: number, y: number): number => (x < y ? -1 : x > y ? 1 : 0);
  const exact = order(a, b);
  return exact === order(round15(a), round15(b)) ? exact : null;
}

const ASCII = /^[\x00-\x7f]*$/;
const PLAIN = /^[A-Za-z0-9]*$/;

/** Excel's = on text: ignores case. Only ASCII is compared; other text is equal when identical and otherwise unknown. */
function equalText(a: string, b: string): boolean | null {
  if (a === b) return true;
  if (ASCII.test(a) && ASCII.test(b)) return a.toUpperCase() === b.toUpperCase();
  return null;
}

/** Excel's ordering of text, only for plain letters and digits (digits first, case ignored), or with an empty side. */
function compareText(a: string, b: string): number | null {
  if (a === '' || b === '') return a === b ? 0 : a === '' ? -1 : 1;
  if (!PLAIN.test(a) || !PLAIN.test(b)) return null;
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A number as Excel's & writes it (General, 15 significant digits), or null outside the range where that is plain digits for certain. */
function generalText(n: number): string | null {
  const r = round15(n);
  if (r === 0) return '0';
  const a = Math.abs(r);
  if (a < 1e-3 || a >= 1e15) return null;
  let s = r.toPrecision(15);
  if (s.includes('e')) return null;
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** `repr` (a decimal, maybe with an exponent) rounded to `digits` places: half away from zero, away from zero, or towards zero. */
function roundRepr(repr: string, digits: number, mode: 'half' | 'up' | 'down'): number {
  const negative = repr.startsWith('-');
  let s = negative ? repr.slice(1) : repr;
  let exp = 0;
  const e = s.search(/e/i);
  if (e >= 0) {
    exp = Number(s.slice(e + 1));
    s = s.slice(0, e);
  }
  const dot = s.indexOf('.');
  const whole = dot < 0 ? s : s.slice(0, dot);
  let all = whole + (dot < 0 ? '' : s.slice(dot + 1));
  let point = whole.length + exp;
  const lead = /^0*/.exec(all)![0].length;
  all = all.slice(lead);
  point -= lead;
  if (all === '') return 0;
  const keep = point + digits;
  if (keep >= all.length) return Number(repr);
  let kept = keep > 0 ? BigInt(all.slice(0, keep)) : 0n;
  const rest = keep > 0 ? all.slice(keep) : all;
  const up = mode === 'up' ? /[1-9]/.test(rest) : mode === 'half' ? keep >= 0 && rest[0]! >= '5' : false;
  if (up) kept += 1n;
  const value = Number(`${kept}e${-digits}`);
  return negative && value !== 0 ? -value : value;
}

/**
 * Excel rounds the decimal it shows, not the binary double (ROUND(2.675, 2) is 2.68). The decimal is taken two ways, the
 * shortest that reads back as the double and its 15 significant digits; when they round differently the answer is unknown.
 */
function roundNumber(x: number, digits: number, mode: 'half' | 'up' | 'down'): Scalar {
  const a = roundRepr(String(x), digits, mode);
  const b = roundRepr(x.toPrecision(15), digits, mode);
  return a === b ? finite(a) : UNKNOWN;
}

/** The text of a number's `<v>`: 15 significant digits, so 0.1+0.2 is written 0.3 as Excel shows it. */
function numberXml(n: number): string {
  return String(round15(n) || 0).replace('e', 'E');
}

const COMPARISONS = ['=', '<>', '<', '<=', '>', '>='];
const LEVELS = [COMPARISONS, ['&'], ['+', '-'], ['*', '/'], ['^']];
const node = (n: NodeBody, ...children: Node[]): Node => {
  const h = 1 + Math.max(0, ...children.map((c) => c.h));
  if (h > MAX_HEIGHT) throw new Unparsed();
  return { ...n, h };
};
const leaf = (v: Scalar): Node => ({ t: 'value', v, h: 1 });

interface Sheets {
  /** Lower-case name -> index. */
  index: ReadonlyMap<string, number>;
  names: readonly string[];
}

/** The rectangle a reference token names (A1, $A$1, A:C, 2:5), with or without a sheet. */
function tokenArea(token: FormulaToken, sheets: Sheets, own: number): Area & { doubtful: boolean } {
  let sheet = own;
  let doubtful = false;
  let text = token.text;
  if (token.sheet !== undefined) {
    let name = token.sheet.slice(0, -1);
    if (name.startsWith("'")) name = name.slice(1, -1).replace(/''/g, "'");
    const found = sheets.index.get(name.toLowerCase());
    if (found === undefined) throw new Unparsed();
    sheet = found;
    // Excel matches sheet names ignoring case; for non-ASCII names that is a rule this doesn't know exactly.
    doubtful = name !== sheets.names[found] && !ASCII.test(name);
    text = text.slice(token.sheet.length);
  }
  const col = (letters: string): number => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const area = (r1: number, c1: number, r2: number, c2: number, single: boolean) => ({
    k: 'area' as const,
    sheet,
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
    single,
    doubtful,
  });
  let m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(text);
  if (m) return area(Number(m[2]) - 1, col(m[1]!), Number(m[2]) - 1, col(m[1]!), true);
  m = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(text);
  if (m) return area(0, col(m[1]!), EXCEL_MAX_ROWS - 1, col(m[2]!), false);
  m = /^\$?(\d+):\$?(\d+)$/.exec(text);
  if (m) return area(Number(m[1]) - 1, 0, Number(m[2]) - 1, EXCEL_MAX_COLUMNS - 1, false);
  throw new Unparsed();
}

const box = (a: Area, b: Area): Area => ({
  k: 'area',
  sheet: a.sheet,
  r1: Math.min(a.r1, b.r1),
  c1: Math.min(a.c1, b.c1),
  r2: Math.max(a.r2, b.r2),
  c2: Math.max(a.c2, b.c2),
  single: false,
});

const isColon = (t: FormulaToken | undefined): boolean => t?.kind === 'operator' && t.text === ':';

/**
 * Every area a formula refers to, taken or not, for finding circular references; or null when a reference can't be
 * known from the text (OFFSET, or ":" next to something that isn't a reference), and the workbook is left uncached.
 * A chain such as A1:B2:C3 counts as the rectangle around all of it.
 */
function staticAreas(tokens: readonly FormulaToken[], sheets: Sheets, own: number): Area[] | null {
  const out: Area[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'call' && t.text.slice(0, -1).trim().replace(PREFIXES, '').toUpperCase() === 'OFFSET') return null;
    if (isColon(t) && (tokens[i - 1]?.kind !== 'reference' || tokens[i + 1]?.kind !== 'reference')) return null;
    if (t.kind !== 'reference') continue;
    let area: Area = tokenArea(t, sheets, own);
    while (isColon(tokens[i + 1]) && tokens[i + 2]?.kind === 'reference') {
      area = box(area, tokenArea(tokens[i + 2]!, sheets, area.sheet));
      i += 2;
    }
    out.push(area);
  }
  return out;
}

/** A recursive-descent parser over the checked tokens, by Excel's precedence: comparisons, &, + -, * /, ^, %, unary + -, then references (":" and the space intersection). */
class Parser {
  private i = 0;
  private depth = 0;
  private readonly tokens: FormulaToken[];

  constructor(
    tokens: readonly FormulaToken[],
    private readonly sheets: Sheets,
    private readonly own: number,
  ) {
    this.tokens = tokens.filter((t) => t.kind !== 'space');
  }

  parse(): Node {
    const n = this.binary(0);
    if (this.i !== this.tokens.length) throw new Unparsed();
    return n;
  }

  private take(ops: readonly string[]): string | null {
    const t = this.tokens[this.i];
    if (t?.kind !== 'operator' || !ops.includes(t.text)) return null;
    this.i++;
    return t.text;
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new Unparsed();
  }

  private binary(level: number): Node {
    const ops = LEVELS[level];
    if (ops === undefined) return this.percent();
    let a = this.binary(level + 1);
    for (let op = this.take(ops); op !== null; op = this.take(ops)) {
      const b = this.binary(level + 1);
      a = node({ t: 'binary', op, a, b }, a, b);
    }
    return a;
  }

  private percent(): Node {
    let a = this.prefix();
    while (this.take(['%']) !== null) a = node({ t: 'unary', op: '%', a }, a);
    return a;
  }

  private prefix(): Node {
    const op = this.take(['+', '-']);
    if (op === null) return this.reference();
    this.enter();
    const a = this.prefix();
    this.depth--;
    return node({ t: 'unary', op, a }, a);
  }

  /** A reference, a range, or (two references with a space between) an intersection, which isn't in the subset. */
  private reference(): Node {
    let n = this.range();
    while (this.tokens[this.i]?.kind === 'reference') {
      this.range();
      n = leaf(UNKNOWN);
    }
    return n;
  }

  private range(): Node {
    const t = this.tokens[this.i];
    if (t?.kind !== 'reference') return this.atom();
    this.i++;
    const first = tokenArea(t, this.sheets, this.own);
    let area: Area = first;
    let parts = 1;
    let singles = first.single;
    while (isColon(this.tokens[this.i]) && this.tokens[this.i + 1]?.kind === 'reference') {
      const next = tokenArea(this.tokens[this.i + 1]!, this.sheets, first.sheet);
      area = box(area, next);
      singles &&= next.single;
      parts++;
      this.i += 2;
    }
    if (first.doubtful || parts > 2 || (parts === 2 && !singles)) return leaf(UNKNOWN);
    return { t: 'area', a: area, h: 1 };
  }

  private atom(): Node {
    const t = this.tokens[this.i++];
    switch (t?.kind) {
      case 'number': {
        // Excel keeps 15 significant digits of a number typed in; a longer literal is left alone.
        const digits = t.text.split(/e/i)[0]!.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
        return leaf(digits.length > 15 ? UNKNOWN : finite(Number(t.text)));
      }
      case 'string':
        return leaf(str(t.text.slice(1, -1).replace(/""/g, '"')));
      case 'boolean':
        return leaf(bool(t.text.toUpperCase() === 'TRUE'));
      case 'error':
        return leaf({ k: 'err', e: t.text.toUpperCase() });
      case 'array':
        return leaf(UNKNOWN);
      case 'open': {
        this.enter();
        const inner = this.binary(0);
        if (this.tokens[this.i++]?.kind !== 'close') throw new Unparsed();
        this.depth--;
        return inner;
      }
      case 'call': {
        this.enter();
        const name = t.text.slice(0, -1).trim();
        const args: (Node | null)[] = [];
        if (this.tokens[this.i]?.kind === 'close') this.i++;
        else {
          for (;;) {
            const next = this.tokens[this.i]?.kind;
            args.push(next === 'comma' || next === 'close' ? null : this.binary(0));
            const sep = this.tokens[this.i++]?.kind;
            if (sep === 'close') break;
            if (sep !== 'comma') throw new Unparsed();
          }
        }
        this.depth--;
        return node({ t: 'call', name, args }, ...args.filter((a): a is Node => a !== null));
      }
      default:
        throw new Unparsed();
    }
  }
}

/** The formula in a cell, as toCell in xlsx.ts decides it, or null. */
function formulaOf(cell: Cell | undefined): string | null {
  if (typeof cell === 'string') return cell.startsWith('=') ? cell : null;
  if (cell !== null && typeof cell === 'object' && cell.formula !== undefined) return cell.formula;
  return null;
}

/** Text as the file holds it: xmlSafe's, with "" an empty cell (the writer leaves it out) and anything the writer would alter unknown. */
function textCell(text: string): Scalar {
  const safe = xmlSafe(text);
  if (safe === '') return EMPTY;
  if (safe.includes('\r') || lostCharacter(safe) !== undefined) return UNKNOWN;
  return str(safe);
}

/** A cell that isn't a formula, as the file holds it (dates as the writer's serial numbers). */
function literal(cell: Cell | undefined): Scalar {
  if (cell === null || cell === undefined) return EMPTY;
  if (typeof cell === 'string') return textCell(cell);
  if (typeof cell === 'number') return finite(cell);
  if (typeof cell === 'boolean') return bool(cell);
  if (cell.date !== undefined) {
    const date = parseCellDate(cell.date);
    // write-excel-file's own arithmetic, so the value is the same double the file holds.
    return date === null ? UNKNOWN : finite(new Date(date.utcMs).getTime() / 86_400_000 + 25_569);
  }
  const value = cell.value;
  if (typeof value === 'string') return textCell(value);
  if (typeof value === 'number') return finite(value);
  if (typeof value === 'boolean') return bool(value);
  return EMPTY;
}

interface Formula {
  sheet: number;
  row: number;
  col: number;
  node: Node;
  areas: Area[];
}

const cellKey = (sheet: number, row: number, col: number): number => (sheet * EXCEL_MAX_ROWS + row) * EXCEL_MAX_COLUMNS + col;

class Workbook {
  private readonly results = new Map<number, Scalar>();
  private steps = 0;

  constructor(
    private readonly spec: SpreadsheetSpec,
    private readonly formulaIds: ReadonlyMap<number, number>,
  ) {}

  result(sheet: number, row: number, col: number): Scalar | undefined {
    return this.results.get(cellKey(sheet, row, col));
  }

  /** One formula's value, every formula it depends on already done. */
  calculate(f: Formula): void {
    let out: Scalar;
    try {
      const v = this.value(f.node);
      out = v.k === 'area' ? (v.single ? this.cell(v.sheet, v.r1, v.c1) : UNKNOWN) : v;
      if (out.k === 'empty') out = num(0);
      if (out.k === 'str' && out.s.length > EXCEL_MAX_CELL_CHARS) out = UNKNOWN;
    } catch (err) {
      if (!(err instanceof OutOfBudget || err instanceof RangeError)) throw err;
      out = UNKNOWN;
    }
    this.results.set(cellKey(f.sheet, f.row, f.col), out);
  }

  private step(): void {
    if (++this.steps > EVAL_BUDGET) throw new OutOfBudget();
  }

  private cell(sheet: number, row: number, col: number): Scalar {
    this.step();
    const key = cellKey(sheet, row, col);
    if (this.formulaIds.has(key)) return this.results.get(key) ?? UNKNOWN;
    return literal(this.spec.sheets[sheet]?.rows[row]?.[col]);
  }

  /**
   * Every cell of an area that is in the sheet, in row order; past the sheet's rows and a row's cells they're empty.
   * Each row walked counts against the budget as well as each cell read, or a whole-column range over many short rows
   * would read nothing and never run out.
   */
  private *cells(a: Area): Generator<Scalar> {
    const rows = this.spec.sheets[a.sheet]?.rows ?? [];
    for (let r = a.r1; r <= Math.min(a.r2, rows.length - 1); r++) {
      this.step();
      const row = rows[r] ?? [];
      for (let c = a.c1; c <= Math.min(a.c2, row.length - 1); c++) yield this.cell(a.sheet, r, c);
    }
  }

  private value(n: Node): Value {
    switch (n.t) {
      case 'value':
        return n.v;
      case 'area':
        return n.a;
      case 'unary':
        return this.unary(n.op, n.a);
      case 'binary':
        return this.binary(n.op, n.a, n.b);
      case 'call':
        return this.call(n.name, n.args);
    }
  }

  /** A value where one is wanted: a single cell is read, a range (implicit intersection or a spill) is unknown. */
  private scalar(n: Node): Scalar {
    const v = this.value(n);
    if (v.k !== 'area') return v;
    return v.single ? this.cell(v.sheet, v.r1, v.c1) : UNKNOWN;
  }

  /** An operand of arithmetic: TRUE is 1 and an empty cell 0; text is unknown, as Excel converts "3", "1,000" or a date by locale. */
  private static arithmetic(v: Scalar): number | Scalar {
    switch (v.k) {
      case 'num':
        return v.n;
      case 'bool':
        return v.b ? 1 : 0;
      case 'empty':
        return 0;
      case 'str':
        return UNKNOWN;
      default:
        return v;
    }
  }

  private unary(op: string, a: Node): Scalar {
    const v = this.scalar(a);
    if (op === '+') return v.k === 'empty' ? UNKNOWN : v;
    const x = Workbook.arithmetic(v);
    if (typeof x !== 'number') return x;
    return op === '-' ? finite(-x) : finite(x / 100);
  }

  private binary(op: string, an: Node, bn: Node): Scalar {
    const a = this.scalar(an);
    const b = this.scalar(bn);
    if (a.k === 'unknown' || b.k === 'unknown') return UNKNOWN;
    if (a.k === 'err') return a;
    if (b.k === 'err') return b;
    if (op === '&') {
      const x = Workbook.text(a);
      const y = Workbook.text(b);
      if (x === null || y === null || x.length + y.length > EXCEL_MAX_CELL_CHARS) return UNKNOWN;
      return str(x + y);
    }
    if (COMPARISONS.includes(op)) return Workbook.compare(op, a, b);
    const x = Workbook.arithmetic(a);
    if (typeof x !== 'number') return x;
    const y = Workbook.arithmetic(b);
    if (typeof y !== 'number') return y;
    switch (op) {
      case '+':
        return add(x, y);
      case '-':
        return add(x, -y);
      case '*':
        return finite(x * y);
      case '/':
        return y === 0 ? DIV0 : finite(x / y);
      case '^':
        // 0^0 is #NUM! and 0^-1 #DIV/0! in Excel; a negative base with a fractional power is NaN here but not always an error there.
        return x === 0 && y <= 0 ? UNKNOWN : finite(x ** y);
      default:
        return UNKNOWN;
    }
  }

  /** A value as & joins it, or null when Excel's text for it isn't certain. */
  private static text(v: Scalar): string | null {
    switch (v.k) {
      case 'str':
        return v.s;
      case 'num':
        return generalText(v.n);
      case 'bool':
        return v.b ? 'TRUE' : 'FALSE';
      case 'empty':
        return '';
      default:
        return null;
    }
  }

  /** Excel's comparison: an empty cell is 0, "" or FALSE to match the other side; otherwise numbers < text < TRUE/FALSE. */
  private static compare(op: string, a: Scalar, b: Scalar): Scalar {
    const blank = (other: Scalar): Scalar => (other.k === 'str' ? str('') : other.k === 'bool' ? bool(false) : num(0));
    const x = a.k === 'empty' ? blank(b) : a;
    const y = b.k === 'empty' ? blank(a) : b;
    const rank = (v: Scalar): number => (v.k === 'num' ? 0 : v.k === 'str' ? 1 : 2);
    let order: number | null;
    if (rank(x) !== rank(y)) order = rank(x) < rank(y) ? -1 : 1;
    else if (x.k === 'num' && y.k === 'num') order = compareNumbers(x.n, y.n);
    else if (x.k === 'bool' && y.k === 'bool') order = Number(x.b) - Number(y.b);
    else if (x.k === 'str' && y.k === 'str') {
      if (op === '=' || op === '<>') {
        const same = equalText(x.s, y.s);
        return same === null ? UNKNOWN : bool(same === (op === '='));
      }
      order = compareText(x.s, y.s);
    } else return UNKNOWN;
    if (order === null) return UNKNOWN;
    switch (op) {
      case '=':
        return bool(order === 0);
      case '<>':
        return bool(order !== 0);
      case '<':
        return bool(order < 0);
      case '<=':
        return bool(order <= 0);
      case '>':
        return bool(order > 0);
      default:
        return bool(order >= 0);
    }
  }

  /** A condition: a non-zero number is TRUE, an empty cell FALSE; text is unknown. */
  private static condition(v: Scalar): boolean | Scalar {
    switch (v.k) {
      case 'num':
        return v.n !== 0;
      case 'bool':
        return v.b;
      case 'empty':
        return false;
      case 'str':
        return UNKNOWN;
      default:
        return v;
    }
  }

  /** A number argument (ROUND, ABS): a typed TRUE is 1, an empty cell 0; text, and TRUE/FALSE in a cell, are unknown. */
  private number(n: Node | null | undefined): number | Scalar {
    if (n === null || n === undefined) return UNKNOWN;
    const v = this.value(n);
    if (v.k === 'area') {
      if (!v.single) return UNKNOWN;
      const c = this.cell(v.sheet, v.r1, v.c1);
      return c.k === 'num' ? c.n : c.k === 'empty' ? 0 : c.k === 'err' ? c : UNKNOWN;
    }
    return v.k === 'num' ? v.n : v.k === 'bool' ? (v.b ? 1 : 0) : v.k === 'err' ? v : UNKNOWN;
  }

  private call(name: string, args: (Node | null)[]): Value {
    const argc = (min: number, max: number): boolean => args.length >= min && args.length <= max;
    switch (name) {
      case 'SUM':
      case 'AVERAGE':
      case 'MIN':
      case 'MAX':
      case 'COUNT':
      case 'COUNTA':
        return argc(1, 255) ? this.aggregate(name, args) : UNKNOWN;
      case 'AND':
      case 'OR':
        return argc(1, 255) ? this.logical(name === 'AND', args) : UNKNOWN;
      case 'IF': {
        if (!argc(2, 3) || args[0] === null) return UNKNOWN;
        const cond = Workbook.condition(this.scalar(args[0]!));
        if (typeof cond !== 'boolean') return cond;
        if (!cond && args.length === 2) return bool(false);
        const branch = args[cond ? 1 : 2];
        // An empty argument (IF(A1,,2)) is left alone.
        return branch === null || branch === undefined ? UNKNOWN : this.value(branch);
      }
      case 'NOT': {
        if (!argc(1, 1) || args[0] === null) return UNKNOWN;
        const cond = Workbook.condition(this.scalar(args[0]!));
        return typeof cond === 'boolean' ? bool(!cond) : cond;
      }
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN': {
        if (!argc(2, 2)) return UNKNOWN;
        const x = this.number(args[0]);
        const d = this.number(args[1]);
        if (typeof x !== 'number') return x;
        if (typeof d !== 'number') return d;
        if (!Number.isInteger(d) || Math.abs(d) > 15) return UNKNOWN;
        return roundNumber(x, d, name === 'ROUND' ? 'half' : name === 'ROUNDUP' ? 'up' : 'down');
      }
      case 'ABS': {
        if (!argc(1, 1)) return UNKNOWN;
        const x = this.number(args[0]);
        return typeof x === 'number' ? finite(Math.abs(x)) : x;
      }
      default:
        return UNKNOWN;
    }
  }

  /**
   * SUM, AVERAGE, MIN, MAX, COUNT and COUNTA. In a reference only numbers count (COUNTA: anything not empty) and text
   * and TRUE/FALSE are skipped; typed directly, TRUE/FALSE count as numbers and text is unknown (Excel converts "3").
   * COUNT skips errors and COUNTA counts them; the others give the error.
   */
  private aggregate(name: string, args: (Node | null)[]): Scalar {
    const numbers: number[] = [];
    let count = 0;
    let error: Scalar | null = null;
    const counts = name === 'COUNT' || name === 'COUNTA';
    const take = (v: Scalar, direct: boolean): boolean => {
      if (v.k === 'unknown') return false;
      if (name === 'COUNTA') {
        if (v.k !== 'empty') count++;
      } else if (name === 'COUNT') {
        if (v.k === 'num' || (direct && v.k === 'bool')) count++;
        else if (direct && v.k === 'str') return false;
      } else if (v.k === 'num') numbers.push(v.n);
      else if (v.k === 'err') error ??= v;
      else if (direct && v.k === 'bool') numbers.push(v.b ? 1 : 0);
      else if (direct && v.k === 'str') return false;
      return true;
    };
    for (const arg of args) {
      if (arg === null) return UNKNOWN;
      const v = this.value(arg);
      if (v.k === 'area') {
        for (const c of this.cells(v)) if (!take(c, false)) return UNKNOWN;
      } else if (!take(v, true)) return UNKNOWN;
    }
    if (counts) return num(count);
    if (error) return error;
    if (name === 'MIN' || name === 'MAX') {
      let best = numbers[0] ?? 0;
      for (const n of numbers) best = name === 'MIN' ? Math.min(best, n) : Math.max(best, n);
      return num(best);
    }
    let total: Scalar = num(0);
    for (const n of numbers) {
      if (total.k !== 'num') return total;
      total = add(total.n, n);
    }
    if (name === 'SUM' || total.k !== 'num') return total;
    return numbers.length === 0 ? DIV0 : finite(total.n / numbers.length);
  }

  /** AND and OR: in a reference text and empty cells are skipped; typed text is unknown; with no TRUE/FALSE or number at all, #VALUE!. */
  private logical(isAnd: boolean, args: (Node | null)[]): Scalar {
    let seen = false;
    let result = isAnd;
    let error: Scalar | null = null;
    const take = (v: Scalar, direct: boolean): boolean => {
      if (v.k === 'unknown' || (direct && v.k === 'str')) return false;
      if (v.k === 'err') error ??= v;
      else if (v.k === 'num' || v.k === 'bool') {
        const b = v.k === 'num' ? v.n !== 0 : v.b;
        seen = true;
        result = isAnd ? result && b : result || b;
      }
      return true;
    };
    for (const arg of args) {
      if (arg === null) return UNKNOWN;
      const v = this.value(arg);
      if (v.k === 'area') {
        for (const c of this.cells(v)) if (!take(c, false)) return UNKNOWN;
      } else if (!take(v, true)) return UNKNOWN;
    }
    if (error) return error;
    return seen ? bool(result) : VALUE_ERROR;
  }
}

/** A formula result as a cached value, or null: errors and unknowns aren't cached, nor text a viewer might read differently. */
function cachedValue(v: Scalar | undefined): CachedValue | null {
  if (v === undefined) return null;
  if (v.k === 'num') return { t: 'n', v: numberXml(v.n) };
  if (v.k === 'bool') return { t: 'b', v: v.b ? '1' : '0' };
  if (v.k !== 'str') return null;
  // Whitespace at the ends of a <v> or a line break in it may not survive a reader, and the writer would alter some characters.
  if (/^[ \t\n]|[ \t\n]$|[\t\r\n]/.test(v.s) || xmlSafe(v.s) !== v.s || lostCharacter(v.s) !== undefined) return null;
  return { t: 'str', v: v.s };
}

const NOTHING = (): null => null;

/**
 * The cached value for each formula cell of `spec` (sheet index, zero-based row and column), or null for one that gets
 * none. Formulas are calculated in dependency order (Kahn's algorithm): one in a cycle, or that depends on one, never
 * comes up and stays uncached.
 */
export function cachedFormulaValues(spec: SpreadsheetSpec): (sheet: number, row: number, col: number) => CachedValue | null {
  const names = spec.sheets.map((s) => s.name);
  const sheets: Sheets = { names, index: new Map(names.map((n, i) => [n.toLowerCase(), i])) };
  const nameSet = new Set(names);
  const formulas: Formula[] = [];
  const ids = new Map<number, number>();
  /** For each sheet, column -> the ids of its formulas, top to bottom (cells are visited in row order). */
  const columns: Map<number, number[]>[] = spec.sheets.map(() => new Map());
  try {
    for (const [s, sheet] of spec.sheets.entries()) {
      for (const [r, row] of sheet.rows.entries()) {
        for (const [c, cell] of row.entries()) {
          const text = formulaOf(cell);
          if (text === null) continue;
          const tokens = formulaTokens(text, nameSet);
          if (tokens === null) return NOTHING;
          const areas = staticAreas(tokens, sheets, s);
          if (areas === null) return NOTHING;
          let parsed: Node;
          try {
            parsed = new Parser(tokens, sheets, s).parse();
          } catch (err) {
            if (!(err instanceof Unparsed || err instanceof RangeError)) throw err;
            parsed = leaf(UNKNOWN);
          }
          const f: Formula = { sheet: s, row: r, col: c, node: parsed, areas };
          let column = columns[s]!.get(c);
          if (!column) columns[s]!.set(c, (column = []));
          column.push(formulas.length);
          ids.set(cellKey(s, r, c), formulas.length);
          formulas.push(f);
        }
      }
    }
  } catch (err) {
    // A reference that can't be read (it was checked, so this shouldn't happen) leaves the whole workbook uncached.
    if (err instanceof Unparsed) return NOTHING;
    throw err;
  }

  // Which formulas each formula refers to, ranges included. The budget counts the columns looked at and the edges found.
  let budget = GRAPH_BUDGET;
  const waiting = new Array<number>(formulas.length).fill(0);
  const dependents: number[][] = formulas.map(() => []);
  const sortedColumns = columns.map((byColumn) => [...byColumn.keys()].sort((x, y) => x - y));
  for (const [id, f] of formulas.entries()) {
    const deps = new Set<number>();
    for (const a of f.areas) {
      for (const c of sortedColumns[a.sheet]!) {
        if (--budget < 0) return NOTHING;
        if (c < a.c1) continue;
        if (c > a.c2) break;
        const column = columns[a.sheet]!.get(c)!;
        // The first formula at or below row r1.
        let lo = 0;
        let hi = column.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (formulas[column[mid]!]!.row < a.r1) lo = mid + 1;
          else hi = mid;
        }
        for (let k = lo; k < column.length && formulas[column[k]!]!.row <= a.r2; k++) {
          if (--budget < 0) return NOTHING;
          deps.add(column[k]!);
        }
      }
    }
    waiting[id] = deps.size;
    for (const dep of deps) dependents[dep]!.push(id);
  }

  const book = new Workbook(spec, ids);
  // First in, first out, so with a limited budget the formulas near the top of each sheet are the ones worked out.
  const ready = formulas.map((_, id) => id).filter((id) => waiting[id] === 0);
  for (let q = 0; q < ready.length; q++) {
    const next = ready[q]!;
    book.calculate(formulas[next]!);
    for (const d of dependents[next]!) if (--waiting[d]! === 0) ready.push(d);
  }
  return (sheet, row, col) => cachedValue(book.result(sheet, row, col));
}
