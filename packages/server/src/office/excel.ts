import { attr, prefixedAttr, scanXml } from './xml.js';
import type { OfficeParts, TextOut } from './parts.js';

/**
 * Excel (spec 2026-10-12-office-files §1): every sheet's cells as CSV, plus
 * its formulas with their cached values. Not charts or comments.
 *
 * The work is linear in the part's size however hostile it is, and nothing is
 * buffered past the text cap. Every string the reader builds is clipped to the
 * room left in the output, a sheet is read only until what it holds (cell
 * values and formula lines, each of which appears in the output) comes to that
 * room, and the CSV loop ends the moment the output is full, so a `<row r>` of
 * a million costs no more than the cap. No regex runs over a file-controlled
 * string except single-pass ones that can't backtrack.
 */

/** Columns past this are left out (and said so). */
const MAX_COLUMNS = 200;
/** The largest row and column index a worksheet can have (XFD1048576); a reference outside is not a cell. */
const SHEET_MAX_ROW = 1_048_576;
const SHEET_MAX_COLUMN = 16_383;
/** The last day Excel can show (9999-12-31) as a serial. */
const MAX_SERIAL = 2_958_465;
/** Characters of a number format code that are looked at (Excel's own limit is 255). */
const MAX_FORMAT_CODE = 255;

const isBuiltInDate = (id: number): boolean => (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);

/**
 * A custom number format is a date or time when d, m, y, h or s is left once quoted text, [..] sections and escaped
 * characters are ignored. One pass over the code (an unterminated quote or bracket runs to the end of it), so no
 * input makes it do more than one step per character.
 */
export function isDateFormatCode(code: string): boolean {
  let quoted = false;
  let bracketed = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (quoted) {
      if (ch === '"') quoted = false;
    } else if (bracketed) {
      if (ch === ']') bracketed = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '[') bracketed = true;
    else if (ch === '\\') i++;
    else if (ch === 'd' || ch === 'D' || ch === 'm' || ch === 'M' || ch === 'y' || ch === 'Y' || ch === 'h' || ch === 'H' || ch === 's' || ch === 'S') return true;
  }
  return false;
}

/** An Excel serial date as ISO: YYYY-MM-DD, or YYYY-MM-DD HH:MM when it has a time. 1900 counts Excel's phantom 29 Feb 1900. A serial Excel can't show as a date is returned as a number. */
export function serialToIso(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial) || serial < 0 || serial > MAX_SERIAL) return String(serial);
  const day = Math.floor(serial);
  const minutes = Math.round((serial - day) * 1440);
  const base = date1904 ? Date.UTC(1904, 0, 1) : day >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  const iso = new Date(base + day * 86_400_000 + minutes * 60_000).toISOString();
  // Past year 9999 (the 1904 epoch gets there sooner than the serial limit) the year gets a sign: not a date Excel shows.
  if (iso[0] === '+' || iso[0] === '-') return String(serial);
  return serial === day ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** A0-based column index as letters: 0 is A, 26 is AA. */
function columnLetters(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** One CSV field, quoted as RFC 4180 says when it needs to be. */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A cell reference ("B4", "$B$4"): zero-based column and one-based row, or null when it isn't one or lies outside a worksheet. */
function parseRef(ref: string): { row: number; col: number } | null {
  if (ref.length > 12) return null;
  let i = ref[0] === '$' ? 1 : 0;
  let col = 0;
  let letters = 0;
  for (; i < ref.length && letters < 4; i++, letters++) {
    const code = ref.charCodeAt(i) | 32;
    if (code < 97 || code > 122) break;
    col = col * 26 + (code - 96);
  }
  if (letters === 0 || letters > 3) return null;
  if (ref[i] === '$') i++;
  if (i >= ref.length) return null;
  let row = 0;
  for (; i < ref.length; i++) {
    const digit = ref.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return null;
    row = row * 10 + digit;
  }
  return row >= 1 && row <= SHEET_MAX_ROW && col <= SHEET_MAX_COLUMN + 1 ? { row, col: col - 1 } : null;
}

/** `cur` plus `text`, never longer than `limit` characters. */
function append(cur: string, text: string, limit: number): string {
  const free = limit - cur.length;
  if (free <= 0) return cur;
  return cur + (text.length > free ? text.slice(0, free) : text);
}

/** The shared strings, each clipped to `limit` characters (a longer one can't fit in the output anyway). */
function sharedStrings(xml: string | null, limit: number): string[] {
  const out: string[] = [];
  if (xml === null) return out;
  const st = { cur: null as string | null, inT: 0, inPh: 0 };
  scanXml(xml, {
    open(local) {
      if (local === 'si') {
        st.cur = '';
        st.inT = 0;
        st.inPh = 0;
      } else if (local === 't') st.inT++;
      else if (local === 'rPh') st.inPh++;
    },
    close(local) {
      if (local === 'si') {
        out.push(st.cur ?? '');
        st.cur = null;
      } else if (local === 't') st.inT = Math.max(0, st.inT - 1);
      else if (local === 'rPh') st.inPh = Math.max(0, st.inPh - 1);
    },
    text(text) {
      if (st.cur !== null && st.inT > 0 && st.inPh === 0) st.cur = append(st.cur, text, limit);
    },
  });
  return out;
}

/** Which cellXfs indexes show a date. */
function dateStyles(xml: string | null): Set<number> {
  const out = new Set<number>();
  if (xml === null) return out;
  const custom = new Map<number, string>();
  const xfs: number[] = [];
  const st = { inXfs: false };
  scanXml(xml, {
    open(local, attrs) {
      if (local === 'numFmt') custom.set(Number(attr(attrs, 'numFmtId')), attr(attrs, 'formatCode') ?? '');
      else if (local === 'cellXfs') st.inXfs = true;
      else if (local === 'xf' && st.inXfs) xfs.push(Number(attr(attrs, 'numFmtId') ?? 0));
    },
    close(local) {
      if (local === 'cellXfs') st.inXfs = false;
    },
  });
  // Each number format is decided once, however many styles use it, and only its first characters are looked at (Excel limits a format code to 255): a huge code used by thousands of styles would otherwise cost codes x styles.
  const isDate = new Map<number, boolean>();
  xfs.forEach((id, index) => {
    let date = isDate.get(id);
    if (date === undefined) {
      const code = custom.get(id);
      date = code !== undefined ? isDateFormatCode(code.slice(0, MAX_FORMAT_CODE)) : isBuiltInDate(id);
      isDate.set(id, date);
    }
    if (date) out.add(index);
  });
  return out;
}

interface Book {
  shared: string[];
  dates: Set<number>;
  date1904: boolean;
}

interface CellState {
  row: number;
  col: number;
  t: string;
  s: number;
  v: string | null;
  f: string | null;
  sharedIndex: string | null;
  inline: string;
}

/** A cell's reference as the canonical "B4". */
const refOf = (c: CellState): string => `${columnLetters(c.col)}${c.row}`;

function cellText(c: CellState, book: Book): string {
  switch (c.t) {
    case 's':
      return c.v === null ? '' : (book.shared[Number(c.v)] ?? '');
    case 'inlineStr':
      return c.inline;
    case 'b':
      return c.v === '1' ? 'TRUE' : c.v === '0' ? 'FALSE' : '';
    case 'str':
    case 'e':
    case 'd':
      return c.v ?? '';
    default: {
      if (c.v === null) return '';
      const v = c.v.trim();
      if (v === '') return '';
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= MAX_SERIAL && book.dates.has(c.s)) return serialToIso(n, book.date1904);
      return v;
    }
  }
}

/** One worksheet; false once the text is full. */
function readSheet(xml: string, name: string, hidden: boolean, book: Book, out: TextOut): boolean {
  // Cell values and formula lines each appear in the output, so once they come to the room left the text is full whatever else is in the sheet.
  const budget = Math.max(0, out.room) + 1;
  const cells = new Map<number, Map<number, string>>();
  const formulas: string[] = [];
  const masters = new Map<string, string>();
  const st = {
    row: 0,
    col: -1,
    maxRow: 0,
    maxCol: -1,
    wide: false,
    /** The sheet's own idea of its last cell (<dimension ref="A1:C9"/>), used for the range only when reading stopped early. */
    dim: null as { row: number; col: number } | null,
    held: 0,
    over: false,
    c: null as CellState | null,
    inV: 0,
    inF: 0,
    inIs: 0,
    inT: 0,
    inPh: 0,
  };

  scanXml(xml, {
    open(local, attrs) {
      if (local === 'dimension') {
        const ref = attr(attrs, 'ref') ?? '';
        if (ref.length <= 25) st.dim = parseRef(ref.slice(ref.indexOf(':') + 1));
        return;
      }
      if (local === 'row') {
        const r = Number(attr(attrs, 'r'));
        st.row = Number.isInteger(r) && r > 0 && r <= SHEET_MAX_ROW ? r : st.row + 1;
        st.col = -1;
        st.c = null;
        return;
      }
      if (local === 'c') {
        const ref = attr(attrs, 'r');
        const at = ref ? parseRef(ref) : null;
        if (at) {
          st.row = at.row;
          st.col = at.col;
        } else st.col += 1;
        st.inV = st.inF = st.inIs = st.inT = st.inPh = 0;
        st.c = { row: st.row, col: st.col, t: attr(attrs, 't') ?? 'n', s: Number(attr(attrs, 's') ?? 0), v: null, f: null, sharedIndex: null, inline: '' };
        return;
      }
      const c = st.c;
      if (!c) return;
      if (local === 'v') {
        st.inV++;
        c.v ??= '';
      } else if (local === 'f') {
        st.inF++;
        c.f ??= '';
        c.sharedIndex = attr(attrs, 't') === 'shared' ? (attr(attrs, 'si') ?? null) : null;
      } else if (local === 'is') st.inIs++;
      else if (local === 't') st.inT++;
      else if (local === 'rPh') st.inPh++;
    },
    close(local) {
      const c = st.c;
      if (!c) return;
      if (local === 'v') st.inV = Math.max(0, st.inV - 1);
      else if (local === 'f') st.inF = Math.max(0, st.inF - 1);
      else if (local === 'is') st.inIs = Math.max(0, st.inIs - 1);
      else if (local === 't') st.inT = Math.max(0, st.inT - 1);
      else if (local === 'rPh') st.inPh = Math.max(0, st.inPh - 1);
      else if (local === 'c') {
        st.c = null;
        const value = cellText(c, book);
        if (value !== '') {
          if (c.col < MAX_COLUMNS && c.row <= SHEET_MAX_ROW) {
            let row = cells.get(c.row);
            if (!row) cells.set(c.row, (row = new Map()));
            st.held += value.length - (row.get(c.col)?.length ?? 0);
            row.set(c.col, value);
            st.maxRow = Math.max(st.maxRow, c.row);
            st.maxCol = Math.max(st.maxCol, c.col);
          } else st.wide = true;
        }
        if (c.f !== null) {
          const ref = refOf(c);
          let line: string | null = null;
          if (c.f.trim() !== '') {
            if (c.sharedIndex !== null) masters.set(c.sharedIndex, ref);
            line = `${ref}: =${c.f}${value !== '' ? ` (value ${value})` : ''}`;
          } else if (c.sharedIndex !== null) {
            line = `${ref}: shared formula from ${masters.get(c.sharedIndex) ?? 'another cell'}`;
          }
          if (line !== null) {
            formulas.push(line);
            st.held += line.length;
          }
        }
        if (st.held >= budget) {
          st.over = true;
          return false;
        }
      }
      return;
    },
    text(text) {
      const c = st.c;
      if (!c) return;
      if (st.inV > 0) c.v = append(c.v ?? '', text, budget);
      else if (st.inF > 0) c.f = append(c.f ?? '', text, budget);
      else if (st.inIs > 0 && st.inT > 0 && st.inPh === 0) c.inline = append(c.inline, text, budget);
    },
  });

  // Reading stopped before the end, so the range seen is short: the sheet's own dimension (written at its start) gives the real one.
  // Only when a value was stored: a sheet of formulas with no cached values has no CSV block, so the formula lines aren't pushed out by empty rows.
  if (st.over && st.dim && st.maxCol >= 0) {
    st.maxRow = Math.max(st.maxRow, st.dim.row);
    st.maxCol = Math.max(st.maxCol, Math.min(st.dim.col, MAX_COLUMNS - 1));
  }
  const lastColumn = columnLetters(MAX_COLUMNS - 1);
  if (st.maxCol < 0) {
    const empty = st.wide ? `has cells only past column ${lastColumn}, which Grunt leaves out.` : 'is empty.';
    if (!out.line(`Sheet "${name}"${hidden ? ' (hidden)' : ''} ${empty}`)) return false;
  } else {
    if (!out.line(`Sheet "${name}" (A1:${columnLetters(st.maxCol)}${st.maxRow})${hidden ? ', hidden' : ''} as CSV:`)) return false;
    // Ends as soon as the output is full, so a far-off last row costs no more than the cap.
    for (let r = 1; r <= st.maxRow; r++) {
      const row = cells.get(r);
      const line = row ? Array.from({ length: st.maxCol + 1 }, (_, i) => csvField(row.get(i) ?? '')).join(',') : '';
      if (!out.line(line)) return false;
    }
    if (st.wide && !out.line(`(Columns after ${lastColumn} were left out.)`)) return false;
  }
  if (formulas.length > 0) {
    if (!out.line(`Formulas in "${name}":`)) return false;
    for (const f of formulas) if (!out.line(f)) return false;
  }
  if (st.over) {
    out.stop();
    return false;
  }
  return true;
}

export function readExcel(parts: OfficeParts, out: TextOut): void {
  const workbook = parts.text('xl/workbook.xml');
  if (workbook === null) return;
  const sheets: { name: string; rid: string; hidden: boolean }[] = [];
  const wb = { date1904: false };
  scanXml(workbook, {
    open(local, attrs) {
      if (local === 'workbookPr') {
        const v = attr(attrs, 'date1904');
        wb.date1904 = v === '1' || v === 'true';
      } else if (local === 'sheet') {
        sheets.push({ name: attr(attrs, 'name') ?? '', rid: prefixedAttr(attrs, 'id') ?? '', hidden: (attr(attrs, 'state') ?? 'visible') !== 'visible' });
      }
    },
  });
  const rels = parts.rels('xl/workbook.xml');
  const relOfType = (suffix: string): string | undefined => [...rels.values()].find((r) => r.type.endsWith(suffix))?.target;
  const clip = Math.max(0, out.room) + 1;
  const book: Book = {
    shared: sharedStrings(parts.text(relOfType('/sharedStrings') ?? 'xl/sharedStrings.xml'), clip),
    dates: dateStyles(parts.text(relOfType('/styles') ?? 'xl/styles.xml')),
    date1904: wb.date1904,
  };
  let wrote = false;
  // A blank line between sheets, and none before the first thing written; false once the text is full.
  const begin = (): boolean => {
    const ok = !wrote || out.line('');
    wrote = true;
    return ok;
  };
  const read = new Map<string, string>();
  for (const sheet of sheets) {
    const rel = rels.get(sheet.rid);
    if (!rel) {
      if (!begin() || !out.line(`Sheet "${sheet.name}" couldn't be found in the file.`)) return;
      continue;
    }
    if (rel.type.endsWith('/chartsheet')) {
      if (!begin() || !out.line(`Sheet "${sheet.name}" is a chart.`)) return;
      continue;
    }
    // Sheets that name one part are read once: the others say so (thousands of entries for one big part would otherwise be thousands of scans).
    const key = rel.target.toLowerCase();
    const first = read.get(key);
    if (first !== undefined) {
      if (!begin() || !out.line(`Sheet "${sheet.name.slice(0, 100)}" is the same part as sheet "${first.slice(0, 100)}".`)) return;
      continue;
    }
    read.set(key, sheet.name);
    const xml = parts.text(rel.target);
    if (xml === null) {
      if (parts.stopped) return;
      continue;
    }
    if (!begin() || !readSheet(xml, sheet.name, sheet.hidden, book, out)) return;
  }
}
