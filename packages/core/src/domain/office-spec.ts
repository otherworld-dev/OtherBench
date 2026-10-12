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
/** Functions that could reach the network or another program when the file is opened. */
export const REFUSED_FUNCTIONS: readonly string[] = ['WEBSERVICE', 'FILTERXML', 'IMAGE', 'HYPERLINK', 'RTD', 'CALL', 'REGISTER', 'REGISTER.ID', 'EXEC'];

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
const WORD = /[A-Za-z_\\][A-Za-z0-9_.]*/y;
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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
 * What's wrong with a formula (without its "="), or null. Syntax and sheet
 * names only: Grunt doesn't calculate, so a wrong reference shows in Excel.
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
    WORD.lastIndex = i;
    const word = WORD.exec(body);
    if (word) {
      // A word that starts mid-token (after a digit: "1abc") is skipped whole, not looked at, so every character is read once.
      if (!/[A-Za-z0-9_.]/.test(body[i - 1] ?? '')) {
        const after = body[i + word[0].length];
        if (after === '!') {
          if (!sheetNames.has(word[0].toLowerCase())) return `refers to sheet "${word[0]}", which isn't in the workbook`;
        } else if (after === '(') {
          const fn = word[0].toUpperCase().replace(/^_XL(?:FN|WS)\./, '');
          if (REFUSED_FUNCTIONS.includes(fn)) return `uses ${fn}, which Grunt refuses: it could reach the network or another program when the file is opened`;
        }
      }
      i += word[0].length;
      continue;
    }
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
  "- Formulas use Excel's English function names with commas, and 'Sheet name'!A1 for another sheet. Grunt can't calculate them; Excel does when the file is opened, so check every reference. WEBSERVICE, IMAGE, HYPERLINK, RTD, CALL, REGISTER, EXEC, FILTERXML, DDE (|) and links to other workbooks ([) are refused.",
  '- Errors name the place in the JSON to fix.',
].join('\n');
