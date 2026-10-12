/**
 * The sources Office artifacts are made from (spec 2026-10-12-office-files §3,
 * Deck #928). A `document` is Markdown, bounded only by the 1 MB cap and the size limits
 * below (characters, lines, table rows and cells, indent, quote depth, marks).
 * A `spreadsheet` is JSON: sheets of rows of cells, where text starting with
 * "=" is a formula. A `presentation` is JSON too: slides, each in one of a few
 * layouts (title, section, bullets, two-column, table) with optional speaker
 * notes. The artifact tool, your edit (PUT) and the server's
 * renderers parse with this, and the web draws its previews from it, so it
 * imports nothing at all: no Node built-ins, and not artifacts.ts (which pulls
 * in the crypto module). Errors name the JSON path, so the model can fix the
 * one place.
 */

export const OFFICE_KINDS = ['document', 'spreadsheet', 'presentation'] as const;
export type OfficeKind = (typeof OFFICE_KINDS)[number];

export function isOfficeKind(kind: string): kind is OfficeKind {
  return (OFFICE_KINDS as readonly string[]).includes(kind);
}

export const MAX_SHEETS = 50;
export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLUMNS = 16_384;
export const EXCEL_MAX_CELL_CHARS = 32_767;
export const MAX_SHEET_NAME = 31;
export const MAX_FORMULA_CHARS = 8_192;
/**
 * Functions that could reach the network or another program, or reveal details
 * of this computer, when the file is opened. They are named in the error; any
 * other function outside ALLOWED_FUNCTIONS is refused too.
 */
export const REFUSED_FUNCTIONS: readonly string[] = [
  'WEBSERVICE',
  'FILTERXML',
  'IMAGE',
  'HYPERLINK',
  'RTD',
  'CALL',
  'REGISTER',
  'REGISTER.ID',
  'EXEC',
  'STOCKHISTORY',
  'TRANSLATE',
  'DETECTLANGUAGE',
  'COPILOT',
  'INFO',
  'CELL',
  'INDIRECT',
];

/**
 * Not in phase 1: LET, LAMBDA and the LAMBDA helpers, and GROUPBY/PIVOTBY
 * (which need a LAMBDA or a bare function name). Excel stores their parameter
 * names with an "_xlpm." prefix, which would need scope tracking to write, and
 * bare names are otherwise refused.
 */
export const NOT_YET_FUNCTIONS: readonly string[] = ['LET', 'LAMBDA', 'MAP', 'REDUCE', 'SCAN', 'BYROW', 'BYCOL', 'MAKEARRAY', 'ISOMITTED', 'GROUPBY', 'PIVOTBY'];

/** Functions Excel 2007 had: stored in the file by name alone. */
const EXCEL_2007_FUNCTIONS = [
  // Maths and trigonometry
  'ABS ACOS ACOSH ASIN ASINH ATAN ATAN2 ATANH CEILING COMBIN COS COSH DEGREES ECMA.CEILING EVEN EXP FACT FACTDOUBLE FLOOR GCD INT ISO.CEILING LCM LN LOG LOG10',
  'MDETERM MINVERSE MMULT MOD MROUND MULTINOMIAL ODD PI POWER PRODUCT QUOTIENT RADIANS RAND RANDBETWEEN ROMAN ROUND ROUNDDOWN ROUNDUP SERIESSUM SIGN SIN SINH',
  'SQRT SQRTPI SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SUMSQ SUMX2MY2 SUMX2PY2 SUMXMY2 TAN TANH TRUNC',
  // Statistical, with the pre-2010 names Excel keeps for compatibility
  'AVEDEV AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS BETADIST BETAINV BINOMDIST CHIDIST CHIINV CHITEST CONFIDENCE CORREL COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS',
  'COVAR CRITBINOM DEVSQ EXPONDIST FDIST FINV FISHER FISHERINV FORECAST FREQUENCY FTEST GAMMADIST GAMMAINV GAMMALN GEOMEAN GROWTH HARMEAN HYPGEOMDIST INTERCEPT',
  'KURT LARGE LINEST LOGEST LOGINV LOGNORMDIST MAX MAXA MEDIAN MIN MINA MODE NEGBINOMDIST NORMDIST NORMINV NORMSDIST NORMSINV PEARSON PERCENTILE PERCENTRANK',
  'PERMUT POISSON PROB QUARTILE RANK RSQ SKEW SLOPE SMALL STANDARDIZE STDEV STDEVA STDEVP STDEVPA STEYX TDIST TINV TREND TRIMMEAN TTEST VAR VARA VARP VARPA',
  'WEIBULL ZTEST',
  // Lookup and reference
  'ADDRESS AREAS CHOOSE COLUMN COLUMNS GETPIVOTDATA HLOOKUP INDEX LOOKUP MATCH OFFSET ROW ROWS TRANSPOSE VLOOKUP',
  // Text
  'ASC BAHTTEXT CHAR CLEAN CODE CONCATENATE DOLLAR EXACT FIND FINDB FIXED JIS LEFT LEFTB LEN LENB LOWER MID MIDB PHONETIC PROPER REPLACE REPLACEB REPT RIGHT',
  'RIGHTB SEARCH SEARCHB SUBSTITUTE T TEXT TRIM UPPER VALUE',
  // Logical
  'AND FALSE IF IFERROR NOT OR TRUE',
  // Date and time
  'DATE DATEDIF DATEVALUE DAY DAYS360 EDATE EOMONTH HOUR MINUTE MONTH NETWORKDAYS NETWORKDAYS.INTL NOW SECOND TIME TIMEVALUE TODAY WEEKDAY WEEKNUM WORKDAY',
  'WORKDAY.INTL YEAR YEARFRAC',
  // Financial
  'ACCRINT ACCRINTM AMORDEGRC AMORLINC COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD CUMIPMT CUMPRINC DB DDB DISC DOLLARDE DOLLARFR DURATION EFFECT FV',
  'FVSCHEDULE INTRATE IPMT IRR ISPMT MDURATION MIRR NOMINAL NPER NPV ODDFPRICE ODDFYIELD ODDLPRICE ODDLYIELD PMT PPMT PRICE PRICEDISC PRICEMAT PV RATE RECEIVED',
  'SLN SYD TBILLEQ TBILLPRICE TBILLYIELD VDB XIRR XNPV YIELD YIELDDISC YIELDMAT',
  // Information (not CELL or INFO)
  'ERROR.TYPE ISBLANK ISERR ISERROR ISEVEN ISLOGICAL ISNA ISNONTEXT ISNUMBER ISODD ISREF ISTEXT N NA TYPE',
  // Engineering
  'BESSELI BESSELJ BESSELK BESSELY BIN2DEC BIN2HEX BIN2OCT COMPLEX CONVERT DEC2BIN DEC2HEX DEC2OCT DELTA ERF ERFC GESTEP HEX2BIN HEX2DEC HEX2OCT IMABS IMAGINARY',
  'IMARGUMENT IMCONJUGATE IMCOS IMDIV IMEXP IMLN IMLOG10 IMLOG2 IMPOWER IMPRODUCT IMREAL IMSIN IMSQRT IMSUB IMSUM OCT2BIN OCT2DEC OCT2HEX',
  // Database
  'DAVERAGE DCOUNT DCOUNTA DGET DMAX DMIN DPRODUCT DSTDEV DSTDEVP DSUM DVAR DVARP',
];

/** Functions added after Excel 2007: stored as "_xlfn.NAME" ([MS-XLSX] 2.2.2's future functions), or Excel before them shows #NAME?. */
const FUTURE_FUNCTIONS = [
  // Maths and trigonometry
  'ACOT ACOTH AGGREGATE ARABIC BASE CEILING.MATH CEILING.PRECISE COMBINA COT COTH CSC CSCH DECIMAL FLOOR.MATH FLOOR.PRECISE MUNIT SEC SECH',
  // Statistical
  'BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CONFIDENCE.NORM CONFIDENCE.T COVARIANCE.P',
  'COVARIANCE.S EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FORECAST.ETS FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR GAMMA',
  'GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS HYPGEOM.DIST LOGNORM.DIST LOGNORM.INV MAXIFS MINIFS MODE.MULT MODE.SNGL NEGBINOM.DIST NORM.DIST NORM.INV NORM.S.DIST',
  'NORM.S.INV PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ SKEW.P STDEV.P',
  'STDEV.S T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST VAR.P VAR.S WEIBULL.DIST Z.TEST',
  // Lookup, reference and dynamic arrays
  'CHOOSECOLS CHOOSEROWS DROP EXPAND FORMULATEXT HSTACK PERCENTOF RANDARRAY SEQUENCE SORTBY TAKE TOCOL TOROW TRIMRANGE UNIQUE VSTACK WRAPCOLS WRAPROWS XLOOKUP',
  'XMATCH',
  // Text (ENCODEURL only encodes text; it fetches nothing)
  'ARRAYTOTEXT CONCAT DBCS ENCODEURL NUMBERVALUE REGEXEXTRACT REGEXREPLACE REGEXTEST TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT UNICHAR UNICODE VALUETOTEXT',
  // Logical
  'IFNA IFS SWITCH XOR',
  // Date and time, financial, information
  'DAYS ISOWEEKNUM PDURATION RRI ISFORMULA SHEET SHEETS',
  // Engineering
  'BITAND BITLSHIFT BITOR BITRSHIFT BITXOR ERF.PRECISE ERFC.PRECISE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN',
];

/** Worksheet-only future functions, stored as "_xlfn._xlws.NAME". */
const WORKSHEET_ONLY_FUNCTIONS = ['FILTER SORT'];

const withPrefix = (prefix: string, lines: readonly string[]): [string, string][] => lines.flatMap((line) => line.split(' ').map((name): [string, string] => [name, prefix]));

/**
 * Excel's built-in worksheet functions a formula may call: upper-case name ->
 * the prefix Excel stores it with in the file ('' for Excel 2007's, '_xlfn.'
 * for later ones, '_xlfn._xlws.' for FILTER and SORT). Left out on purpose:
 * REFUSED_FUNCTIONS, the CUBE functions (external data connections), Python,
 * Power Query, linked data types (FIELDVALUE), the web functions, and add-in or
 * user-defined ones (_xludf.).
 */
export const ALLOWED_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ...withPrefix('', EXCEL_2007_FUNCTIONS),
  ...withPrefix('_xlfn.', FUTURE_FUNCTIONS),
  ...withPrefix('_xlfn._xlws.', WORKSHEET_ONLY_FUNCTIONS),
]);

export interface SpreadsheetSpec {
  sheets: SheetSpec[];
}

export interface SheetSpec {
  /** 1-31 characters, none of \ / ? * [ ] :, not starting or ending with ', unique ignoring case. */
  name: string;
  /** Widths in characters, 1-255; columns[0] is A. */
  columns?: { width?: number }[];
  freeze?: { rows?: number; columns?: number };
  /** rows[0] is row 1, rows[0][0] is A1. */
  rows: Cell[][];
}

/** A string starting with "=" is a formula; numbers must be finite. */
export type Cell = null | string | number | boolean | CellObject;

export interface CellObject {
  /** Literal: {"value": "=x"} is the text "=x". At most one of value, formula and date. */
  value?: string | number | boolean | null;
  /** With or without the leading "=". */
  formula?: string;
  /** YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS], wall-clock time. */
  date?: string;
  /** An Excel number format, 1-64 characters; dates default to yyyy-mm-dd (or yyyy-mm-dd hh:mm). */
  format?: string;
  bold?: boolean;
  italic?: boolean;
  wrap?: boolean;
  align?: 'left' | 'center' | 'right';
  /** #RRGGBB */
  color?: string;
  /** #RRGGBB */
  fill?: string;
}

export type Parsed<T> = { ok: true; spec: T } | { ok: false; error: string };

const HEX = /^#[0-9a-fA-F]{6}$/;
const SHEET_NAME_BAD = /[\\/?*[\]:]/;
const FORMAT = /^[^\u0000-\u001f\u007f]{1,64}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
// The formula tokenizer's pieces. All sticky, none with nested quantifiers, so reading is linear.
/** An unquoted name: a function, a sheet, a reference, TRUE/FALSE. Marks and format characters count, so a lookalike stays one (unknown) name. */
const WORD = /[\p{L}\p{M}\p{N}\p{Pc}\p{Cf}.]+/uy;
/** What can't directly follow a reference or a number: more of a name, a "$" or a "(". */
const NAME_GOES_ON = /[\p{L}\p{M}\p{N}\p{Pc}\p{Cf}.$(]/uy;
/** The whitespace Excel allows in a formula: spaces and line breaks. */
const BREAKS = /[ \r\n]*/y;
const CELL_REF = /\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})/y;
const COLUMN_RANGE = /\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})/y;
const ROW_RANGE = /\$?([1-9]\d{0,6}):\$?([1-9]\d{0,6})/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const BOOLEAN = /(?:TRUE|FALSE)/iy;
const ERROR_VALUE = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)/iy;
/** The prefixes Excel writes before a function, any number of times; the canonical one is put back from ALLOWED_FUNCTIONS. */
const FILE_PREFIXES = /^(?:_xl(?:fn|ws)\.)+/i;
/** Any other "_xl...." prefix (_xlpm. for LAMBDA parameters, _xleta. for bare functions, _xludf. for add-ins) is refused. */
const OTHER_PREFIX = /^_xl[^.]*\./i;
const ASCII_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;
const INVISIBLE = /[\p{Cf}\p{Z}\p{Co}\p{Cn}\p{Cs}]/u;
const REFUSED = new Set(REFUSED_FUNCTIONS);
const NOT_YET = new Set(NOT_YET_FUNCTIONS);
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** NOT_XML without the global flag, for finding the first one. */
const XML_UNSAFE = new RegExp(NOT_XML.source);
/** What the .xlsx writer takes out besides NOT_XML: XML's discouraged characters (U+007F-U+0084, U+0086-U+009F), U+FFFD and the non-characters. */
const DISCOURAGED_XML = /[\u007f-\u0084\u0086-\u009f\ufffd\p{Noncharacter_Code_Point}]/u;
/** Sheet names Excel reads as R1C1 references unless quoted: R, C, RC, R1, C3, R1C1 and so on. */
const R1C1_LIKE = /^(?:[Rr]\d*(?:[Cc]\d*)?|[Cc]\d*)$/;

class SpecError extends Error {}

function bad(path: string, message: string): never {
  throw new SpecError(`${path}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Unknown keys are refused, so a typo ("colums") is an error rather than something quietly left out. */
function onlyKeys(object: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) bad(path, `unknown key "${key}". Allowed: ${allowed.join(', ')}.`);
}

function json(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new SpecError(`The content isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function guard<T>(parse: () => T): Parsed<T> {
  try {
    return { ok: true, spec: parse() };
  } catch (err) {
    if (err instanceof SpecError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Text with the characters XML 1.0 can't hold taken out (C0 controls but tab, LF and CR; U+FFFE/FFFF; lone surrogates), or Word and Excel refuse the file. */
export function xmlSafe(text: string): string {
  return text.replace(NOT_XML, '');
}

/** A cell date as UTC milliseconds of its wall-clock time, or null when it isn't one (or is before 1900, which Excel can't hold). */
export function parseCellDate(text: string): { utcMs: number; hasTime: boolean } | null {
  const m = DATE.exec(text);
  if (!m) return null;
  const n = (i: number): number => Number(m[i] ?? 0);
  const [year, month, day, hour, minute, second] = [n(1), n(2), n(3), n(4), n(5), n(6)];
  if (year < 1900 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(utcMs).getUTCDate() !== day) return null;
  return { utcMs, hasTime: m[4] !== undefined };
}

/** Excel's letters for a 0-based column: 0 is A, 26 is AA, 16383 is XFD. */
export function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Where a quote opened at `start` closes (a doubled quote is an escaped one), or -1. */
function closeQuote(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== quote) continue;
    if (text[i + 1] === quote) {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

const shorten = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** Where `re` (sticky) matches at `at` ends, or -1. */
function matchAt(re: RegExp, text: string, at: number): number {
  re.lastIndex = at;
  return re.exec(text) === null ? -1 : re.lastIndex;
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

const fitsColumn = (letters: string | undefined): boolean => columnNumber(letters ?? '') <= EXCEL_MAX_COLUMNS;
const fitsRow = (digits: string | undefined): boolean => Number(digits) <= EXCEL_MAX_ROWS;

/** Where an A1 reference starting at `at` ends (A1, $A$1, A:C, 2:5), or -1. A sheet prefix isn't part of it. */
function referenceEnd(text: string, at: number): number {
  for (const re of [CELL_REF, COLUMN_RANGE, ROW_RANGE]) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m || matchAt(NAME_GOES_ON, text, re.lastIndex) !== -1) continue;
    const fits = re === CELL_REF ? fitsColumn(m[1]) && fitsRow(m[2]) : re === COLUMN_RANGE ? fitsColumn(m[1]) && fitsColumn(m[2]) : fitsRow(m[1]) && fitsRow(m[2]);
    if (fits) return re.lastIndex;
  }
  return -1;
}

/** Where an array constant opened at `start` ends, or the position of what can't be in one. */
function arrayEnd(text: string, start: number): { end: number } | { bad: number } {
  let j = start + 1;
  for (;;) {
    let next: number;
    if (text[j] === '-') next = matchAt(NUMBER, text, j + 1);
    else if (text[j] === '"') {
      const close = closeQuote(text, j, '"');
      next = close === -1 ? -1 : close + 1;
    } else {
      next = matchAt(NUMBER, text, j);
      if (next === -1) next = matchAt(BOOLEAN, text, j);
      if (next === -1) next = matchAt(ERROR_VALUE, text, j);
    }
    if (next === -1) return { bad: j };
    j = next;
    if (text[j] === ',' || text[j] === ';') j++;
    else if (text[j] === '}') return { end: j + 1 };
    else return { bad: j };
  }
}

type Named = { name: string } | { problem: string; unknown?: true };

/** A function name as written -> its canonical file form (prefix + upper case), or why it can't be used. Only ASCII names match, so lookalikes are unknown. */
function functionName(written: string): Named {
  const bare = written.replace(FILE_PREFIXES, '');
  const other = OTHER_PREFIX.exec(bare);
  if (other) return { problem: `uses "${shorten(written)}", whose "${other[0]}" prefix Grunt refuses` };
  const name = ASCII_NAME.test(bare) ? bare.toUpperCase() : undefined;
  if (name !== undefined && REFUSED.has(name)) {
    return { problem: `uses ${name}, which Grunt refuses: it could reach the network or another program, or reveal details of this computer, when the file is opened` };
  }
  if (name !== undefined && NOT_YET.has(name)) return { problem: `uses ${name}, which Grunt doesn't support in spreadsheets yet` };
  const prefix = name === undefined ? undefined : ALLOWED_FUNCTIONS.get(name);
  if (name === undefined || prefix === undefined) return { problem: `uses ${shorten(bare || written)}, which isn't one of Excel's built-in functions Grunt allows`, unknown: true };
  return { name: prefix + name };
}

const PIPE = 'uses "|" (a link to another program), which Grunt refuses';
const BRACKET = 'uses "[" (a link to another workbook, or a table reference), which Grunt refuses';

/** Why a name that isn't a reference, a call or TRUE/FALSE can't be there. */
function bareNameProblem(word: string, text: string, end: number, sheetNames: ReadonlySet<string>): string {
  if (text[end] === '|') return PIPE;
  if (text[end] === '[') return BRACKET;
  if (text[end] === ':' && sheetNames.has(word.toLowerCase())) {
    WORD.lastIndex = end + 1;
    return `uses references across sheets (${shorten(word)}:${shorten(WORD.exec(text)?.[0] ?? '')}!), which Grunt doesn't support`;
  }
  const named = functionName(word);
  if ('name' in named) return `uses ${word.toUpperCase()} without calling it, which Grunt doesn't support: write ${word.toUpperCase()}(...)`;
  if (!named.unknown) return named.problem;
  return `uses the name "${shorten(word)}", which isn't a cell reference, a function call, TRUE or FALSE (Grunt's spreadsheets have no named ranges)`;
}

type TokenKind = 'space' | 'string' | 'number' | 'boolean' | 'error' | 'reference' | 'array' | 'call' | 'open' | 'close' | 'comma' | 'operator';

/** One token of a formula: what it is, where it starts, its text as given, and its text as written to the file (only a call's differs). */
interface Token {
  kind: TokenKind;
  at: number;
  text: string;
  out: string;
  /** For a sheet-qualified reference, the sheet part as written, "!" included. */
  sheet?: string;
}

const VALUE_KINDS: ReadonlySet<TokenKind> = new Set(['string', 'number', 'boolean', 'error', 'reference', 'array']);

/**
 * Why a formula's tokens don't make an expression Excel reads without
 * repairing the file, or null. Operands and operators alternate (unary + and -
 * may repeat; % follows a value); "(" follows a value only as part of a call;
 * "," only separates a call's arguments, which may be empty; ":" only joins
 * references, all on one sheet; a space only joins two references (their
 * intersection).
 */
function grammarProblem(tokens: readonly Token[], base: number): string | null {
  const calls: boolean[] = []; // for each open "(": is it a call's?
  let wantValue = true;
  let previous: Token | undefined; // the last token that isn't a space
  let beforePrevious: Token | undefined;
  let space: Token | undefined; // a space since `previous`
  const at = (t: Token): string => `at character ${t.at + base}`;
  const wanted = (t: Token): string => `has "${shorten(t.text)}" ${at(t)} where Excel expects a value`;
  const range = (colon: Token): string => `uses ":" ${at(colon)} between things that aren't cell references`;
  for (const t of tokens) {
    if (t.kind === 'space') {
      space = t;
      continue;
    }
    const afterColon = previous?.kind === 'operator' && previous.text === ':';
    if (VALUE_KINDS.has(t.kind) || t.kind === 'call' || t.kind === 'open') {
      if (!wantValue) {
        if (!space) return `has "${shorten(t.text)}" ${at(t)} right after a value, with no operator between them`;
        if (previous?.kind !== 'reference' || t.kind !== 'reference') return `has a space ${at(space)} between values that aren't both cell references`;
      }
      if (afterColon && t.kind !== 'reference' && t.kind !== 'call') return range(previous!);
      if (afterColon && t.sheet !== undefined) return `uses references across sheets (${shorten(beforePrevious?.text ?? '')}:${shorten(t.sheet)}), which Grunt doesn't support`;
      if (t.kind === 'call' || t.kind === 'open') calls.push(t.kind === 'call');
      wantValue = t.kind === 'call' || t.kind === 'open';
    } else if (t.kind === 'close') {
      const call = calls.pop();
      if (wantValue && !(call && (previous?.kind === 'call' || previous?.kind === 'comma'))) return wanted(t);
      wantValue = false;
    } else if (t.kind === 'comma') {
      if (!calls[calls.length - 1]) return `has "," ${at(t)} outside a function's arguments`;
      if (wantValue && previous?.kind !== 'call' && previous?.kind !== 'comma') return wanted(t);
      wantValue = true;
    } else if (wantValue) {
      // An operator where a value should be: only a unary sign, and not straight after ":".
      if (t.text !== '+' && t.text !== '-') return wanted(t);
      if (afterColon) return range(previous!);
    } else if (t.text === ':' && previous?.kind !== 'reference' && previous?.kind !== 'close') {
      return range(t);
    } else if (t.text !== '%') {
      wantValue = true;
    }
    beforePrevious = previous;
    previous = t;
    space = undefined;
  }
  return wantValue ? 'ends where Excel expects a value' : null;
}

/**
 * A formula (without its "=") as tokens, by Excel's A1 grammar, or what's
 * wrong with it. Fails closed: every character must belong to a token it
 * understands. `base` turns an index into the character number shown to the
 * model. One pass; whitespace after a name is looked at at most twice.
 */
function readFormula(body: string, sheetNames: ReadonlySet<string>, base: number): Token[] | string {
  if (body.trim() === '') return 'is empty';
  if (body.length > MAX_FORMULA_CHARS) return `is over ${MAX_FORMULA_CHARS} characters`;
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const push = (kind: TokenKind, end: number, out?: string): Token => {
    const text = body.slice(i, end);
    const token: Token = { kind, at: i, text, out: out ?? text };
    tokens.push(token);
    i = end;
    return token;
  };
  const unreadable = (at: number): string => {
    const cp = body.codePointAt(at)!;
    const ch = String.fromCodePoint(cp);
    const code = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    const what = cp === 9 ? 'a tab' : cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) ? `a control character (${code})` : INVISIBLE.test(ch) ? `the character ${code}` : `"${ch}"`;
    return `has ${what} at character ${at + base}, which Grunt can't read in a formula`;
  };
  // Nothing xmlSafe would take out, even inside text or a quoted sheet name, so what's written is what was checked.
  const unsafe = XML_UNSAFE.exec(body);
  if (unsafe) return unreadable(unsafe.index);
  /** A sheet-qualified reference: the sheet (written from `i` to the "!" at `bang`) must exist and a reference must follow. */
  const sheetReference = (sheet: string, bang: number): string | null => {
    if (!sheetNames.has(sheet.toLowerCase())) return `refers to sheet "${sheet}", which isn't in the workbook`;
    const end = referenceEnd(body, bang + 1);
    if (end === -1) return `needs a cell reference after "${shorten(body.slice(i, bang + 1))}"`;
    const part = body.slice(i, bang + 1);
    push('reference', end).sheet = part;
    return null;
  };
  /** Excel needs a sheet name quoted when it could be read as a reference, a boolean or a number. */
  const needsQuotes = (word: string): string | null =>
    referenceEnd(word, 0) === word.length || matchAt(BOOLEAN, word, 0) === word.length || R1C1_LIKE.test(word) || /^[0-9.]/.test(word)
      ? `refers to sheet "${word}" without quotes: write it as '${word}'!`
      : null;

  while (i < body.length) {
    const ch = body[i]!;
    const previous = tokens[tokens.length - 1];
    if (ch === ' ' || ch === '\n' || ch === '\r') {
      push('space', matchAt(BREAKS, body, i));
    } else if (ch === '"') {
      const close = closeQuote(body, i, '"');
      if (close === -1) return 'has an unclosed double quote';
      push('string', close + 1);
    } else if (ch === "'") {
      const close = closeQuote(body, i, "'");
      if (close === -1) return 'has an unclosed single quote';
      if (body[close + 1] !== '!') return `has a name in single quotes at character ${i + base} that isn't followed by "!": single quotes are only for sheet names`;
      const problem = sheetReference(body.slice(i + 1, close).replace(/''/g, "'"), close + 1);
      if (problem) return problem;
    } else if (ch === '{') {
      const array = arrayEnd(body, i);
      if ('bad' in array) return `has an array constant that holds something other than numbers, text, TRUE/FALSE and error values, at character ${array.bad + base}`;
      push('array', array.end);
    } else if (ch === '(') {
      depth++;
      push('open', i + 1);
    } else if (ch === ')') {
      if (--depth < 0) return 'has a ")" with no "(" before it';
      push('close', i + 1);
    } else if (ch === ',') {
      push('comma', i + 1);
    } else if ('+-*/^&=%:'.includes(ch)) {
      push('operator', i + 1);
    } else if (ch === '<' || ch === '>') {
      const two = body[i + 1] === '=' || (ch === '<' && body[i + 1] === '>');
      push('operator', i + (two ? 2 : 1));
    } else if (ch === '@') {
      // Excel's file grammar has no "@": it saves _xlfn.SINGLE(...), which would need rewriting.
      return 'uses "@" (implicit intersection), which Grunt doesn\'t support in spreadsheets yet';
    } else if (ch === '#') {
      // Right after a reference or ")" it's the spill operator (saved as _xlfn.ANCHORARRAY(...)); anywhere else it starts an error value.
      if (previous?.kind === 'reference' || previous?.kind === 'close') return 'uses "#" (a spill reference), which Grunt doesn\'t support in spreadsheets yet';
      else {
        const end = matchAt(ERROR_VALUE, body, i);
        if (end === -1) return unreadable(i);
        push('error', end);
      }
    } else if (ch === '|') {
      return PIPE;
    } else if (ch === '[') {
      return BRACKET;
    } else if (ch === '!') {
      return `has "!" at character ${i + base} with no sheet name before it`;
    } else if (ch === '$' || (ch >= '0' && ch <= '9') || (ch === '.' && body[i + 1]! >= '0' && body[i + 1]! <= '9')) {
      const wordEnd = matchAt(WORD, body, i);
      if (wordEnd !== -1 && body[wordEnd] === '!') return needsQuotes(body.slice(i, wordEnd))!;
      const end = referenceEnd(body, i);
      if (end !== -1) push('reference', end);
      else {
        const number = ch === '$' ? -1 : matchAt(NUMBER, body, i);
        if (number === -1) return unreadable(i);
        if (matchAt(NAME_GOES_ON, body, number) !== -1) return unreadable(number);
        push('number', number);
      }
    } else {
      const wordEnd = matchAt(WORD, body, i);
      if (wordEnd === -1) return unreadable(i);
      const word = body.slice(i, wordEnd);
      if (body[wordEnd] === '!') {
        const problem = needsQuotes(word) ?? sheetReference(word, wordEnd);
        if (problem) return problem;
        continue;
      }
      const open = matchAt(BREAKS, body, wordEnd);
      if (body[open] === '(') {
        const named = functionName(word);
        if (!('name' in named)) return named.problem;
        depth++;
        push('call', open + 1, named.name + body.slice(wordEnd, open + 1));
        continue;
      }
      const end = referenceEnd(body, i);
      if (end !== -1) push('reference', end);
      else if (matchAt(BOOLEAN, body, i) === wordEnd) push('boolean', wordEnd);
      else return bareNameProblem(word, body, wordEnd, sheetNames);
    }
  }
  if (depth > 0) return 'has an unclosed parenthesis';
  return grammarProblem(tokens, base) ?? tokens;
}

/** What's wrong with a formula (without its "="), or null. Grunt doesn't calculate, so a wrong reference still shows in Excel. */
export function formulaProblem(body: string, sheetNames: ReadonlySet<string>): string | null {
  const read = readFormula(body, sheetNames, 2);
  return typeof read === 'string' ? read : null;
}

/**
 * The exact text to write into a cell's <f> for `formula` (as given in the
 * source, with or without its "="), or why it can't be written. The renderer
 * writes nothing else: no "=", each function as its canonical name with the
 * prefix Excel stores it with (the source's own prefixes dropped), and every
 * other character as given. The text is read again before it's returned, and
 * must give the same tokens, so what's written is exactly what was checked.
 * `sheetNames` are the workbook's sheet names, in any case: they're compared
 * ignoring case.
 */
export function formulaForFile(formula: string, sheetNames: ReadonlySet<string>): { ok: true; text: string } | { ok: false; error: string } {
  return writeFormula(formula, new Set([...sheetNames].map((name) => name.toLowerCase())));
}

/** formulaForFile with `lowerNames` already lower-cased, so parseSpreadsheet doesn't redo it for every cell. */
function writeFormula(formula: string, lowerNames: ReadonlySet<string>): { ok: true; text: string } | { ok: false; error: string } {
  const shown = formula.startsWith('=') ? formula : `=${formula}`;
  const failed = (problem: string) => ({ ok: false as const, error: `"${shorten(shown)}" ${problem}` });
  const tokens = readFormula(shown.slice(1), lowerNames, 2);
  if (typeof tokens === 'string') return failed(tokens);
  const text = tokens.map((t) => t.out).join('');
  if (text.length > MAX_FORMULA_CHARS) return failed(`is over ${MAX_FORMULA_CHARS} characters once Excel's function prefixes are added`);
  const again = readFormula(text, lowerNames, 1);
  const same = typeof again !== 'string' && again.length === tokens.length && again.every((t, k) => t.kind === tokens[k]!.kind && t.out === tokens[k]!.out);
  if (!same) return failed("couldn't be written exactly as it was checked");
  return { ok: true, text };
}

function checkFormula(formula: string, path: string, sheetNames: ReadonlySet<string>): void {
  const written = writeFormula(formula, sheetNames);
  if (!written.ok) bad(path, written.error);
}

function checkText(text: string, path: string): void {
  if (text.length > EXCEL_MAX_CELL_CHARS) bad(path, `is over Excel's ${EXCEL_MAX_CELL_CHARS} characters a cell`);
}

const CELL_KEYS = ['value', 'formula', 'date', 'format', 'bold', 'italic', 'wrap', 'align', 'color', 'fill'] as const;

function cell(c: unknown, path: string, sheetNames: ReadonlySet<string>): Cell {
  if (c === null) return null;
  if (typeof c === 'string') {
    checkText(c, path);
    if (c.startsWith('=')) checkFormula(c, path, sheetNames);
    return c;
  }
  if (typeof c === 'number') {
    if (!Number.isFinite(c)) bad(path, 'numbers must be finite');
    return c;
  }
  if (typeof c === 'boolean') return c;
  if (!isObject(c)) bad(path, 'must be null, text, a number, true/false, or a cell object');
  onlyKeys(c, path, CELL_KEYS);
  const given = (['value', 'formula', 'date'] as const).filter((k) => c[k] !== undefined);
  if (given.length > 1) bad(path, `has ${given.map((k) => `"${k}"`).join(' and ')}: give at most one of value, formula and date`);
  const out: CellObject = {};
  const value = c['value'];
  if (value !== undefined) {
    if (value === null || typeof value === 'boolean') out.value = value;
    else if (typeof value === 'string') {
      checkText(value, `${path}.value`);
      out.value = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) bad(`${path}.value`, 'numbers must be finite');
      out.value = value;
    } else bad(`${path}.value`, 'must be text, a number, true/false or null');
  }
  const formula = c['formula'];
  if (formula !== undefined) {
    if (typeof formula !== 'string') bad(`${path}.formula`, 'must be text');
    checkFormula(formula.startsWith('=') ? formula : `=${formula}`, `${path}.formula`, sheetNames);
    out.formula = formula;
  }
  const date = c['date'];
  if (date !== undefined) {
    if (typeof date !== 'string' || parseCellDate(date) === null) bad(`${path}.date`, 'must be a date from 1900 on, as YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]');
    out.date = date;
  }
  const format = c['format'];
  if (format !== undefined) {
    if (typeof format !== 'string' || !FORMAT.test(format)) bad(`${path}.format`, 'must be an Excel number format of 1-64 characters, such as "#,##0.00"');
    out.format = format;
  }
  for (const key of ['bold', 'italic', 'wrap'] as const) {
    const flag = c[key];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') bad(`${path}.${key}`, 'must be true or false');
    out[key] = flag;
  }
  const align = c['align'];
  if (align !== undefined) {
    if (align !== 'left' && align !== 'center' && align !== 'right') bad(`${path}.align`, 'must be "left", "center" or "right"');
    out.align = align;
  }
  for (const key of ['color', 'fill'] as const) {
    const colour = c[key];
    if (colour === undefined) continue;
    if (typeof colour !== 'string' || !HEX.test(colour)) bad(`${path}.${key}`, 'must be a colour as #RRGGBB');
    out[key] = colour;
  }
  return out;
}

/** The first character in `text` that a writer would take out or that XML 1.0 can't hold, as "U+XXXX", or undefined. One scan, no backtracking. */
function lostCharacter(text: string): string | undefined {
  const lost = (DISCOURAGED_XML.exec(text) ?? XML_UNSAFE.exec(text))?.[0];
  return lost === undefined ? undefined : `U+${lost.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

function sheetName(name: unknown, path: string): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_SHEET_NAME) bad(path, `must be 1-${MAX_SHEET_NAME} characters`);
  if (SHEET_NAME_BAD.test(name)) bad(path, `"${name}" has one of \\ / ? * [ ] :, which Excel doesn't allow in a sheet name`);
  if (name.startsWith("'") || name.endsWith("'")) bad(path, `"${name}" starts or ends with ', which Excel doesn't allow`);
  // The .xlsx writer takes these out of a name (as xmlSafe does the others), so a formula that quotes the name as given would point at a sheet that isn't there.
  const lost = lostCharacter(name);
  if (lost !== undefined) bad(path, `has the character ${lost}, which a sheet name can't hold`);
  return name;
}

function sheet(s: Record<string, unknown>, path: string, sheetNames: ReadonlySet<string>): SheetSpec {
  onlyKeys(s, path, ['name', 'columns', 'freeze', 'rows']);
  const out: SheetSpec = { name: s['name'] as string, rows: [] };
  const columns = s['columns'];
  if (columns !== undefined) {
    if (!Array.isArray(columns) || columns.length > EXCEL_MAX_COLUMNS) bad(`${path}.columns`, `must be a list of at most ${EXCEL_MAX_COLUMNS} columns`);
    out.columns = columns.map((column: unknown, i) => {
      const cp = `${path}.columns[${i}]`;
      if (!isObject(column)) bad(cp, 'must be an object such as {"width": 12}');
      onlyKeys(column, cp, ['width']);
      const width = column['width'];
      if (width === undefined) return {};
      if (typeof width !== 'number' || !Number.isFinite(width) || width < 1 || width > 255) bad(`${cp}.width`, 'must be a number of characters from 1 to 255');
      return { width };
    });
  }
  const freeze = s['freeze'];
  if (freeze !== undefined) {
    const fp = `${path}.freeze`;
    if (!isObject(freeze)) bad(fp, 'must be an object such as {"rows": 1}');
    onlyKeys(freeze, fp, ['rows', 'columns']);
    const frozen: { rows?: number; columns?: number } = {};
    for (const key of ['rows', 'columns'] as const) {
      const count = freeze[key];
      if (count === undefined) continue;
      const max = key === 'rows' ? EXCEL_MAX_ROWS - 1 : EXCEL_MAX_COLUMNS - 1;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > max) bad(`${fp}.${key}`, `must be a whole number from 0 to ${max}`);
      frozen[key] = count;
    }
    out.freeze = frozen;
  }
  const rows = s['rows'];
  if (!Array.isArray(rows) || rows.length > EXCEL_MAX_ROWS) bad(`${path}.rows`, `must be a list of rows (at most ${EXCEL_MAX_ROWS})`);
  out.rows = rows.map((row: unknown, r) => {
    const rp = `${path}.rows[${r}]`;
    if (!Array.isArray(row) || row.length > EXCEL_MAX_COLUMNS) bad(rp, `must be a list of cells (at most ${EXCEL_MAX_COLUMNS})`);
    return row.map((c: unknown, i) => cell(c, `${rp}[${i}]`, sheetNames));
  });
  return out;
}

function spreadsheet(value: unknown): SpreadsheetSpec {
  if (!isObject(value)) throw new SpecError('The content must be a JSON object: {"sheets": [...]}.');
  onlyKeys(value, '(top level)', ['sheets']);
  const sheets = value['sheets'];
  if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > MAX_SHEETS) bad('sheets', `must be a list of 1-${MAX_SHEETS} sheets`);
  // Every name first: a formula may refer to a sheet after its own.
  const names = new Set<string>();
  sheets.forEach((s: unknown, i) => {
    const path = `sheets[${i}]`;
    if (!isObject(s)) bad(path, 'must be an object with "name" and "rows"');
    const name = sheetName(s['name'], `${path}.name`);
    if (names.has(name.toLowerCase())) bad(`${path}.name`, `"${name}" is used by another sheet (names are compared ignoring case)`);
    names.add(name.toLowerCase());
  });
  return { sheets: sheets.map((s: unknown, i) => sheet(s as Record<string, unknown>, `sheets[${i}]`, names)) };
}

export function parseSpreadsheet(content: string): Parsed<SpreadsheetSpec> {
  return guard(() => spreadsheet(json(content)));
}

export const MAX_SLIDES = 200;
export const MAX_BULLETS = 20;
export const MAX_TABLE_COLUMNS = 10;
export const MAX_TABLE_ROWS = 30;

/** 1-500 characters; levels 0-2. */
export type Bullet = string | { text: string; level: 0 | 1 | 2 };

export interface SlideColumn {
  heading?: string;
  bullets: Bullet[];
}

export type SlideSpec =
  | { layout: 'title'; title: string; subtitle?: string; notes?: string }
  | { layout: 'section'; title: string; subtitle?: string; notes?: string }
  | { layout: 'bullets'; title: string; bullets: Bullet[]; notes?: string }
  | { layout: 'two-column'; title: string; left: SlideColumn; right: SlideColumn; notes?: string }
  | { layout: 'table'; title: string; table: { header: string[]; rows: (string | number)[][] }; notes?: string };

/** A deck: 16:9, Calibri, one accent colour (#RRGGBB). */
export interface PresentationSpec {
  theme?: { accent?: string };
  slides: SlideSpec[];
}

const LAYOUT_KEYS: Record<SlideSpec['layout'], readonly string[]> = {
  title: ['layout', 'title', 'subtitle', 'notes'],
  section: ['layout', 'title', 'subtitle', 'notes'],
  bullets: ['layout', 'title', 'bullets', 'notes'],
  'two-column': ['layout', 'title', 'left', 'right', 'notes'],
  table: ['layout', 'title', 'table', 'notes'],
};

/**
 * Slide text: a string within `max` characters (non-blank when `required`)
 * holding nothing the .pptx writer would take out or XML 1.0 can't hold, so
 * what's validated is what's written.
 */
function slideText(value: unknown, path: string, max: number, required: boolean): string {
  if (typeof value !== 'string' || value.length > max || (required && value.trim() === '')) {
    bad(path, required ? `must be text of 1-${max} characters` : `must be text of at most ${max} characters`);
  }
  const lost = lostCharacter(value);
  if (lost !== undefined) bad(path, `has the character ${lost}, which slide text can't hold`);
  return value;
}

function bulletList(value: unknown, path: string): Bullet[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BULLETS) bad(path, `must be a list of 1-${MAX_BULLETS} bullets`);
  return value.map((b: unknown, i): Bullet => {
    const bp = `${path}[${i}]`;
    if (typeof b === 'string') return slideText(b, bp, 500, true);
    if (!isObject(b)) bad(bp, 'must be text or {"text": "...", "level": 0-2}');
    onlyKeys(b, bp, ['text', 'level']);
    const level = b['level'];
    if (level !== 0 && level !== 1 && level !== 2) bad(`${bp}.level`, 'must be 0, 1 or 2');
    return { text: slideText(b['text'], `${bp}.text`, 500, true), level };
  });
}

function slideColumn(value: unknown, path: string): SlideColumn {
  if (!isObject(value)) bad(path, 'must be an object with "bullets" and an optional "heading"');
  onlyKeys(value, path, ['heading', 'bullets']);
  return {
    ...(value['heading'] !== undefined ? { heading: slideText(value['heading'], `${path}.heading`, 300, false) } : {}),
    bullets: bulletList(value['bullets'], `${path}.bullets`),
  };
}

function slideTable(value: unknown, path: string): { header: string[]; rows: (string | number)[][] } {
  if (!isObject(value)) bad(path, 'must be an object with "header" and "rows"');
  onlyKeys(value, path, ['header', 'rows']);
  const header = value['header'];
  if (!Array.isArray(header) || header.length < 1 || header.length > MAX_TABLE_COLUMNS) bad(`${path}.header`, `must be a list of 1-${MAX_TABLE_COLUMNS} column names`);
  const head = header.map((h: unknown, i) => slideText(h, `${path}.header[${i}]`, 200, false));
  const rows = value['rows'];
  if (!Array.isArray(rows) || rows.length > MAX_TABLE_ROWS) bad(`${path}.rows`, `must be a list of at most ${MAX_TABLE_ROWS} rows`);
  return {
    header: head,
    rows: rows.map((row: unknown, r) => {
      const rp = `${path}.rows[${r}]`;
      if (!Array.isArray(row) || row.length !== head.length) bad(rp, `must have ${head.length} cells, one for each header`);
      return row.map((c: unknown, i): string | number => {
        const cp = `${rp}[${i}]`;
        if (typeof c === 'number') {
          if (!Number.isFinite(c)) bad(cp, 'numbers must be finite');
          return c;
        }
        return slideText(c, cp, 200, false);
      });
    }),
  };
}

function slide(value: unknown, path: string): SlideSpec {
  if (!isObject(value)) bad(path, 'must be an object with "layout" and "title"');
  const layout = value['layout'];
  if (typeof layout !== 'string' || !Object.hasOwn(LAYOUT_KEYS, layout)) bad(`${path}.layout`, `must be one of: ${Object.keys(LAYOUT_KEYS).join(', ')}`);
  const kind = layout as SlideSpec['layout'];
  onlyKeys(value, path, LAYOUT_KEYS[kind]);
  const title = slideText(value['title'], `${path}.title`, 200, true);
  const notes = value['notes'] === undefined ? {} : { notes: slideText(value['notes'], `${path}.notes`, 5000, false) };
  switch (kind) {
    case 'title':
    case 'section':
      return { layout: kind, title, ...(value['subtitle'] !== undefined ? { subtitle: slideText(value['subtitle'], `${path}.subtitle`, 300, false) } : {}), ...notes };
    case 'bullets':
      return { layout: kind, title, bullets: bulletList(value['bullets'], `${path}.bullets`), ...notes };
    case 'two-column':
      return { layout: kind, title, left: slideColumn(value['left'], `${path}.left`), right: slideColumn(value['right'], `${path}.right`), ...notes };
    case 'table':
      return { layout: kind, title, table: slideTable(value['table'], `${path}.table`), ...notes };
  }
}

function presentation(value: unknown): PresentationSpec {
  if (!isObject(value)) throw new SpecError('The content must be a JSON object: {"slides": [...]}.');
  onlyKeys(value, '(top level)', ['theme', 'slides']);
  const out: PresentationSpec = { slides: [] };
  const theme = value['theme'];
  if (theme !== undefined) {
    if (!isObject(theme)) bad('theme', 'must be an object such as {"accent": "#1F4E79"}');
    onlyKeys(theme, 'theme', ['accent']);
    const accent = theme['accent'];
    if (accent !== undefined && (typeof accent !== 'string' || !HEX.test(accent))) bad('theme.accent', 'must be a colour as #RRGGBB');
    out.theme = typeof accent === 'string' ? { accent } : {};
  }
  const slides = value['slides'];
  if (!Array.isArray(slides) || slides.length < 1 || slides.length > MAX_SLIDES) bad('slides', `must be a list of 1-${MAX_SLIDES} slides`);
  out.slides = slides.map((s: unknown, i) => slide(s, `slides[${i}]`));
  return out;
}

export function parsePresentation(content: string): Parsed<PresentationSpec> {
  return guard(() => presentation(json(content)));
}

// A document's size limits. The Markdown parser and the .docx writer do far
// more than linear work on tables, deep nesting and very many blocks, so a
// document is bounded by structure, not only by the 1 MB cap, which gives the
// model a clear error naming the limit for an ordinary over-size document.
// These checks only approximate the parser's cost and can be got round; the
// guarantee is the server's, which makes every file in a worker with a time
// and memory limit (packages/server/src/office/render.ts).
export const MAX_DOCUMENT_CHARS = 120_000;
export const MAX_DOCUMENT_LINES = 6_000;
/** Rows of one table: from a line with a `|` to the next blank line, as GFM body rows need no pipe. */
export const MAX_DOCUMENT_TABLE_ROWS = 1_000;
/** Cells of one table, counted as its `|` characters, so a wide table is bounded as well as a long one. */
export const MAX_DOCUMENT_TABLE_CELLS = 10_000;
export const MAX_DOCUMENT_INDENT = 24;
export const MAX_DOCUMENT_QUOTE_DEPTH = 8;
/** Emphasis, strikethrough, code, link, footnote and HTML marks (`*`, `_`, `~`, backtick, `[`, `<`) outside code blocks: the parser's work on them grows fast, so they are counted for the whole document. */
export const MAX_DOCUMENT_MARKS = 10_000;

const number = (n: number): string => n.toLocaleString('en-US');

/** The opening or closing fence on a line: its character and length, or null. */
function fenceOf(line: string): { char: string; length: number; rest: string } | null {
  let i = 0;
  while (i < line.length && i < 4 && line.charCodeAt(i) === 32) i++;
  if (i > 3) return null;
  const char = line[i];
  if (char !== '`' && char !== '~') return null;
  let j = i;
  while (line[j] === char) j++;
  return j - i >= 3 ? { char, length: j - i, rest: line.slice(j) } : null;
}

/**
 * Why a document's Markdown is too big to make into a Word file, or null. One
 * linear pass over the lines, with no Markdown parser. Indentation, quotes,
 * tables and marks inside a fenced code block are ordinary code and aren't
 * counted.
 */
function documentProblem(content: string): string | null {
  if (content.length > MAX_DOCUMENT_CHARS) {
    return `The document has ${number(content.length)} characters; Grunt makes Word files of at most ${number(MAX_DOCUMENT_CHARS)} characters. Split it into more than one document.`;
  }
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > MAX_DOCUMENT_LINES) {
    return `The document has ${number(lines.length)} lines; Grunt makes Word files of at most ${number(MAX_DOCUMENT_LINES)} lines. Split it into more than one document.`;
  }
  let fence: { char: string; length: number } | null = null;
  let tableRows = 0;
  let tableCells = 0;
  let marks = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const found = fenceOf(line);
    if (fence) {
      if (found && found.char === fence.char && found.length >= fence.length && found.rest.trim() === '') fence = null;
      continue;
    }
    if (found && !(found.char === '`' && found.rest.includes('`'))) {
      fence = found;
      tableRows = tableCells = 0;
      continue;
    }
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c === 42 || c === 95 || c === 126 || c === 96 || c === 91 || c === 60) marks++;
    }
    if (marks > MAX_DOCUMENT_MARKS) {
      return `The document has more than ${number(MAX_DOCUMENT_MARKS)} formatting marks (* _ ~ backtick [ <) outside code blocks (it passes that at line ${number(n + 1)}); Grunt makes Word files with at most ${number(MAX_DOCUMENT_MARKS)}. Split it into more than one document.`;
    }
    // Leading whitespace and `>` markers: a tab is 4 columns, one space after a `>` belongs to it.
    let column = 0;
    let widest = 0;
    let quote = 0;
    let i = 0;
    for (; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 32) column++;
      else if (c === 9) column += 4;
      else if (c === 62) {
        quote++;
        widest = Math.max(widest, column);
        column = 0;
        if (line.charCodeAt(i + 1) === 32) i++;
      } else break;
    }
    if (quote > MAX_DOCUMENT_QUOTE_DEPTH) {
      return `Line ${number(n + 1)} of the document is quoted ${number(quote)} levels deep; Grunt makes Word files with quotes at most ${MAX_DOCUMENT_QUOTE_DEPTH} levels deep.`;
    }
    widest = Math.max(widest, column);
    if (widest > MAX_DOCUMENT_INDENT) {
      return `Line ${number(n + 1)} of the document is indented ${number(widest)} columns; Grunt makes Word files with indents of at most ${MAX_DOCUMENT_INDENT} columns.`;
    }
    // A table starts at a line with a `|` and, as in GFM, runs to the next blank line: its body rows need no pipe.
    if (line.trim() === '') {
      tableRows = tableCells = 0;
      continue;
    }
    let pipes = 0;
    for (let k = 0; k < line.length; k++) if (line.charCodeAt(k) === 124) pipes++;
    if (pipes === 0 && tableRows === 0) continue;
    tableRows++;
    tableCells += pipes;
    if (tableRows > MAX_DOCUMENT_TABLE_ROWS) {
      return `The document has a table of more than ${number(MAX_DOCUMENT_TABLE_ROWS)} rows (it passes that at line ${number(n + 1)}); Grunt makes Word files with tables of at most ${number(MAX_DOCUMENT_TABLE_ROWS)} rows. Split the table.`;
    }
    if (tableCells > MAX_DOCUMENT_TABLE_CELLS) {
      return `The document has a table of more than ${number(MAX_DOCUMENT_TABLE_CELLS)} cells (it passes that at line ${number(n + 1)}); Grunt makes Word files with tables of at most ${number(MAX_DOCUMENT_TABLE_CELLS)} cells. Split the table.`;
    }
  }
  return null;
}

/** Why `content` can't be an artifact of `kind`, or null. A spreadsheet or presentation is parsed; a document's size is bounded. */
export function checkOfficeContent(kind: string, content: string): string | null {
  if (kind === 'spreadsheet') {
    const parsed = parseSpreadsheet(content);
    return parsed.ok ? null : parsed.error;
  }
  if (kind === 'document') return documentProblem(content);
  if (kind === 'presentation') {
    const parsed = parsePresentation(content);
    return parsed.ok ? null : parsed.error;
  }
  return null;
}

/** Appended to ARTIFACTS_GUIDANCE: fixed text, so it never churns the system prompt. */
export const OFFICE_GUIDANCE = [
  'Office files: for a Word document, Excel spreadsheet or PowerPoint deck the user wants as a file, make a "document", "spreadsheet" or "presentation" artifact. Grunt makes the .docx, .xlsx or .pptx when the user downloads or saves it. Use "markdown" for notes read in Grunt.',
  '- "document": Markdown: headings, paragraphs, bold, italic, lists, tables, links, code. Images are not put in the file. At most 120,000 characters and 6,000 lines: split a bigger one.',
  '- "spreadsheet": JSON, e.g. {"sheets":[{"name":"Costs","columns":[{"width":24},{"width":12}],"freeze":{"rows":1},"rows":[[{"value":"Item","bold":true},{"value":"Cost","bold":true}],["Widgets",12],["Gadgets",30.5],["Total","=SUM(B2:B3)"]]}]}. rows[0] is row 1 and rows[0][0] is A1. A cell is null, text, a number, true/false, or an object with one of "value", "formula" or "date" (YYYY-MM-DD or YYYY-MM-DDTHH:MM) and optional "format" (an Excel number format such as "#,##0.00"), "bold", "italic", "wrap", "align" (left, center, right), "color" and "fill" (#RRGGBB). Text starting with "=" is a formula; {"value":"=..."} is literal text.',
  "- Formulas use Excel's English function names with commas, and 'Sheet name'!A1 for another sheet. Grunt can't calculate them; Excel does when the file is opened, so check every reference. Only Excel's built-in worksheet functions are allowed, and not WEBSERVICE, FILTERXML, IMAGE, HYPERLINK, RTD, CALL, REGISTER, EXEC, STOCKHISTORY, TRANSLATE, DETECTLANGUAGE, COPILOT, INFO, CELL or INDIRECT; LET, LAMBDA and its helpers, '@' and the '#' spill operator aren't supported yet. Use cell references (there are no named ranges); DDE (|), links to other workbooks and table references ([) are refused.",
  '- "presentation": JSON, e.g. {"theme":{"accent":"#1F4E79"},"slides":[{"layout":"title","title":"Q3 review"},{"layout":"bullets","title":"Highlights","bullets":["Revenue up 12%",{"text":"Two new clients","level":1}],"notes":"Mention churn."}]}. Layouts: title and section (title, subtitle), bullets (title, bullets), two-column (title, left and right, each {"heading","bullets"}), table (title, table: {"header","rows"}). A bullet is text or {"text","level":0-2}; "notes" are speaker notes. Keep slides to about six short bullets.',
  '- Errors name the place in the JSON to fix.',
].join('\n');
