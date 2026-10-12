/**
 * The sources Office artifacts are made from (spec 2026-10-12-office-files §3,
 * Deck #928). A `document` is Markdown and has no checks beyond the 1 MB cap.
 * A `spreadsheet` is JSON: sheets of rows of cells, where text starting with
 * "=" is a formula. The artifact tool, your edit (PUT) and the server's
 * renderers parse with this, and the web draws its previews from it, so it
 * imports nothing at all: no Node built-ins, and not artifacts.ts (which pulls
 * in the crypto module). Errors name the JSON path, so the model can fix the
 * one place.
 */

export const OFFICE_KINDS = ['document', 'spreadsheet'] as const;
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
  'CHOOSECOLS CHOOSEROWS DROP EXPAND FORMULATEXT GROUPBY HSTACK PERCENTOF PIVOTBY RANDARRAY SEQUENCE SORTBY TAKE TOCOL TOROW TRIMRANGE UNIQUE VSTACK WRAPCOLS',
  'WRAPROWS XLOOKUP XMATCH',
  // Text
  'ARRAYTOTEXT CONCAT NUMBERVALUE REGEXEXTRACT REGEXREPLACE REGEXTEST TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT UNICHAR UNICODE VALUETOTEXT',
  // Logical, LET and LAMBDA
  'IFNA IFS SWITCH XOR LET LAMBDA MAP REDUCE SCAN BYROW BYCOL MAKEARRAY ISOMITTED',
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
/** A name in a formula: a function, a sheet, a reference, a LET name, a number. Marks and format characters count, so a lookalike stays one (unknown) name. */
const NAME = /[\p{L}\p{M}\p{N}\p{Pc}\p{Cf}.]+/uy;
const SPACES = /\s*/uy;
/** The prefixes a function can carry in the file, any number of times: future, worksheet-only, LAMBDA parameter. */
const FILE_PREFIXES = /^(?:_xl(?:fn|ws|pm)\.)+/i;
const ASCII_NAME = /^[A-Za-z0-9_.]+$/;
const REFUSED = new Set(REFUSED_FUNCTIONS);
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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

/**
 * Why a call to `written` (as it appears before the "(") isn't allowed, or
 * null. Only ASCII names can match: a fullwidth or other lookalike is unknown.
 */
function functionProblem(written: string): string | null {
  const bare = written.replace(FILE_PREFIXES, '');
  const name = ASCII_NAME.test(bare) ? bare.toUpperCase() : undefined;
  if (name !== undefined && REFUSED.has(name)) return `uses ${name}, which Grunt refuses: it could reach the network or another program, or reveal details of this computer, when the file is opened`;
  if (name !== undefined && ALLOWED_FUNCTIONS.has(name)) return null;
  return `uses ${shorten(bare || written)}, which isn't one of Excel's built-in functions Grunt allows`;
}

/**
 * What's wrong with a formula (without its "="), or null. Syntax, sheet names
 * and functions only: Grunt doesn't calculate, so a wrong reference shows in
 * Excel. One pass: every character is read once (whitespace after a name at
 * most twice), so a long formula can't make it slow.
 *
 * A function is a name, optional whitespace, then "(" (or a fullwidth one), so
 * "@WEBSERVICE (", "_xlfn._xlws.FILTERXML(" and "1\WEBSERVICE(" are all seen.
 * A name bound by LET or LAMBDA and then called ("f(2)") is unknown, so
 * refused. Text inside "..." is inert and not looked at.
 */
export function formulaProblem(body: string, sheetNames: ReadonlySet<string>): string | null {
  if (body.trim() === '') return 'is empty';
  if (body.length > MAX_FORMULA_CHARS) return `is over ${MAX_FORMULA_CHARS} characters`;
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '"') {
      const end = closeQuote(body, i, '"');
      if (end === -1) return 'has an unclosed double quote';
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      const end = closeQuote(body, i, "'");
      if (end === -1) return 'has an unclosed single quote';
      const name = body.slice(i + 1, end).replace(/''/g, "'");
      if (body[end + 1] === '!' && !sheetNames.has(name.toLowerCase())) return `refers to sheet "${name}", which isn't in the workbook`;
      i = end + 1;
      continue;
    }
    if (ch === '|') return 'uses "|" (a link to another program), which Grunt refuses';
    if (ch === '[') return 'uses "[" (a link to another workbook, or a table reference), which Grunt refuses';
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth < 0) return 'has a ")" with no "(" before it';
      i++;
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(body)?.[0];
    if (name !== undefined) {
      // Names are read whole, so each starts where the last token ended and none hides inside another.
      const end = i + name.length;
      if (body[end] === '!' && !sheetNames.has(name.toLowerCase())) return `refers to sheet "${name}", which isn't in the workbook`;
      SPACES.lastIndex = end;
      SPACES.exec(body);
      const next = body[SPACES.lastIndex];
      if (next === '(' || next === '\uFF08') {
        const problem = functionProblem(name);
        if (problem) return problem;
      }
      i = SPACES.lastIndex;
      continue;
    }
    // Anything else ("@", "\", operators, "!", ":") is one character; the name after it is read on its own.
    i++;
  }
  return depth > 0 ? 'has an unclosed parenthesis' : null;
}

const shorten = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

function checkFormula(formula: string, path: string, sheetNames: ReadonlySet<string>): void {
  const problem = formulaProblem(formula.slice(1), sheetNames);
  if (problem) bad(path, `"${shorten(formula)}" ${problem}`);
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

function sheetName(name: unknown, path: string): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_SHEET_NAME) bad(path, `must be 1-${MAX_SHEET_NAME} characters`);
  if (SHEET_NAME_BAD.test(name)) bad(path, `"${name}" has one of \\ / ? * [ ] :, which Excel doesn't allow in a sheet name`);
  if (name.startsWith("'") || name.endsWith("'")) bad(path, `"${name}" starts or ends with ', which Excel doesn't allow`);
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

/** Why `content` can't be an artifact of `kind`, or null. Only JSON kinds are checked. */
export function checkOfficeContent(kind: string, content: string): string | null {
  if (kind === 'spreadsheet') {
    const parsed = parseSpreadsheet(content);
    return parsed.ok ? null : parsed.error;
  }
  return null;
}

/** Appended to ARTIFACTS_GUIDANCE: fixed text, so it never churns the system prompt. */
export const OFFICE_GUIDANCE = [
  'Office files: for a Word document or Excel spreadsheet the user wants as a file, make a "document" or "spreadsheet" artifact. Grunt makes the .docx or .xlsx when the user downloads or saves it. Use "markdown" for notes read in Grunt.',
  '- "document": Markdown: headings, paragraphs, bold, italic, lists, tables, links, code. Images are not put in the file.',
  '- "spreadsheet": JSON, e.g. {"sheets":[{"name":"Costs","columns":[{"width":24},{"width":12}],"freeze":{"rows":1},"rows":[[{"value":"Item","bold":true},{"value":"Cost","bold":true}],["Widgets",12],["Gadgets",30.5],["Total","=SUM(B2:B3)"]]}]}. rows[0] is row 1 and rows[0][0] is A1. A cell is null, text, a number, true/false, or an object with one of "value", "formula" or "date" (YYYY-MM-DD or YYYY-MM-DDTHH:MM) and optional "format" (an Excel number format such as "#,##0.00"), "bold", "italic", "wrap", "align" (left, center, right), "color" and "fill" (#RRGGBB). Text starting with "=" is a formula; {"value":"=..."} is literal text.',
  "- Formulas use Excel's English function names with commas, and 'Sheet name'!A1 for another sheet. Grunt can't calculate them; Excel does when the file is opened, so check every reference. Only Excel's built-in worksheet functions are allowed, and not WEBSERVICE, FILTERXML, IMAGE, HYPERLINK, RTD, CALL, REGISTER, EXEC, STOCKHISTORY, TRANSLATE, DETECTLANGUAGE, COPILOT, INFO, CELL or INDIRECT. Calling a LET or LAMBDA name, DDE (|) and links to other workbooks ([) are refused too.",
  '- Errors name the place in the JSON to fix.',
].join('\n');
