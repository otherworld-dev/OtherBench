import { attr, scanXml } from './xml.js';
import { markdownTable, type OfficeParts, type TextOut } from './parts.js';

/**
 * Word (spec 2026-10-12-office-files §1): body text, headings, lists and
 * tables from word/document.xml. Not headers, footers, footnotes or comments.
 * Deleted text, field codes, moved-away text, tracked formatting changes and
 * the second copy of a text box (mc:Fallback) are skipped.
 *
 * The work is linear in the part's size however hostile it is, and nothing is
 * buffered past the text cap: what the reader holds (open paragraphs, table
 * cells) is limited to what could still fit in the output, a table nested in a
 * cell is flattened into that cell as it goes (not copied up level by level),
 * and a table too big for the cap is cut and the text stopped.
 */

const SKIP = new Set(['delText', 'instrText', 'moveFrom', 'Fallback', 'pPrChange']);
const MAX_LIST_LEVEL = 8;
/** Output characters per table cell at the least, empty or not: " | " (so the check on a table's padded size never cuts one that would fit). */
const CELL_CHARS = 3;

/** Style id -> heading level, from style *names* ("heading 2", any case; "Title" is 1), so a localised document's ids don't matter. */
export function headingLevels(stylesXml: string | null): Map<string, number> {
  const levels = new Map<string, number>();
  if (stylesXml === null) return levels;
  const st = { id: null as string | null };
  scanXml(stylesXml, {
    open(local, attrs) {
      if (local === 'style') st.id = attr(attrs, 'styleId') ?? null;
      else if (local === 'name' && st.id !== null) {
        const name = (attr(attrs, 'val') ?? '').trim();
        const heading = /^heading\s*([1-9])$/i.exec(name);
        if (heading) levels.set(st.id, Number(heading[1]));
        else if (/^title$/i.test(name)) levels.set(st.id, 1);
      }
    },
    close(local) {
      if (local === 'style') st.id = null;
    },
  });
  return levels;
}

interface Para {
  text: string;
  heading: number;
  listLevel: number | null;
}

interface Tbl {
  rows: string[][];
  row: string[] | null;
  cell: string[] | null;
  /** Characters held in finished cell pieces (counted in `held`). */
  chars: number;
  width: number;
  /** Rows were left out because the table is too big for the cap. */
  over: boolean;
}

function lineOf(p: Para): string {
  const text = p.text.trimEnd();
  if (text === '') return '';
  if (p.heading > 0) return `${'#'.repeat(Math.min(p.heading, 6))} ${text}`;
  if (p.listLevel !== null) return `${'  '.repeat(Math.min(p.listLevel, MAX_LIST_LEVEL))}- ${text}`;
  return text;
}

export function readWord(parts: OfficeParts, out: TextOut): void {
  const headings = headingLevels(parts.text('word/styles.xml'));
  const xml = parts.text('word/document.xml');
  if (xml === null) return;
  const st = {
    skip: 0,
    inRun: 0,
    inText: 0,
    inPPr: 0,
    /** Depth of tables nested in a cell: their text goes into that cell. */
    nest: 0,
    /** Characters buffered in open paragraphs and table cells. */
    held: 0,
    /** Text was dropped for lack of room: stop once what's held is written. */
    over: false,
    paras: [] as Para[],
    table: null as Tbl | null,
  };

  // Buffers take no more than what could still fit in the output; the rest is dropped and the reading ends.
  const take = (text: string): string => {
    if (text === '') return '';
    const free = out.room + 1 - st.held;
    if (free <= 0) {
      st.over = true;
      return '';
    }
    const kept = text.length > free ? text.slice(0, free) : text;
    if (kept.length < text.length) st.over = true;
    st.held += kept.length;
    return kept;
  };

  // Paragraphs in a table cell go into the cell; blank lines never repeat.
  const emit = (text: string): boolean => {
    const t = st.table;
    if (t?.cell) {
      const s = text.trim();
      if (s !== '') {
        t.cell.push(s);
        t.chars += s.length;
        st.held += s.length;
      }
      return true;
    }
    if (text === '' && (out.last === undefined || out.last === '')) return true;
    return out.line(text);
  };

  // Writes the table out as Markdown; false once the reading should stop.
  const finishTable = (t: Tbl): boolean => {
    st.table = null;
    st.held -= t.chars;
    emit('');
    for (const line of markdownTable(t.rows)) if (!out.line(line)) return false;
    if (t.over) out.line('[Grunt left out the rest of this table: it is over the text limit.]');
    if (t.over || st.over) {
      out.stop();
      return false;
    }
    return emit('');
  };

  // The table is too big for the cap: write what fits and stop, without reading the rest of it.
  const tooBig = (t: Tbl): boolean => {
    t.over = true;
    st.over = true;
    return finishTable(t);
  };

  scanXml(xml, {
    open(local, attrs) {
      if (st.skip > 0) {
        st.skip++;
        return;
      }
      if (SKIP.has(local)) {
        st.skip = 1;
        return;
      }
      const p = st.paras.at(-1);
      switch (local) {
        case 'p':
          st.paras.push({ text: '', heading: 0, listLevel: null });
          return;
        case 'pPr':
          st.inPPr++;
          return;
        case 'pStyle': {
          if (!p) return;
          const id = attr(attrs, 'val') ?? '';
          const byId = /^heading([1-9])$/i.exec(id);
          p.heading = headings.get(id) ?? (byId ? Number(byId[1]) : 0);
          return;
        }
        case 'numPr':
          if (p && p.listLevel === null) p.listLevel = 0;
          return;
        case 'ilvl':
          if (p) p.listLevel = Math.min(MAX_LIST_LEVEL, Math.max(0, Math.trunc(Number(attr(attrs, 'val') ?? 0)) || 0));
          return;
        case 'numId':
          if (p && attr(attrs, 'val') === '0') p.listLevel = null;
          return;
        case 'r':
          st.inRun++;
          return;
        case 't':
          st.inText++;
          return;
        case 'tab':
          // Only a tab in a run is a character; one in w:pPr/w:tabs is a tab stop.
          if (st.inRun > 0 && st.inPPr === 0 && p) p.text += take('\t');
          return;
        case 'br':
        case 'cr':
          if (st.inRun > 0 && p) p.text += take('\n');
          return;
        case 'tbl':
          if (st.table !== null || st.nest > 0) st.nest++;
          else st.table = { rows: [], row: null, cell: null, chars: 0, width: 0, over: false };
          return;
        case 'tr':
          if (st.table && st.nest === 0) st.table.row = [];
          return;
        case 'tc':
          if (st.table && st.nest === 0) st.table.cell = [];
          return;
      }
    },
    close(local) {
      if (st.skip > 0) {
        st.skip--;
        return;
      }
      switch (local) {
        case 'r':
          st.inRun = Math.max(0, st.inRun - 1);
          return;
        case 't':
          st.inText = Math.max(0, st.inText - 1);
          return;
        case 'pPr':
          st.inPPr = Math.max(0, st.inPPr - 1);
          return;
        case 'p': {
          const p = st.paras.pop();
          if (!p) return;
          st.held -= p.text.length;
          if (!emit(st.table?.cell ? p.text : lineOf(p))) return false;
          if (st.over && st.paras.length === 0 && st.table === null) {
            out.stop();
            return false;
          }
          return;
        }
        case 'tc': {
          const t = st.table;
          if (t?.row && t.cell && st.nest === 0) {
            t.row.push(t.cell.join(' '));
            t.cell = null;
            // A row with more cells than the cap has room for can't be written whatever is in them.
            if (t.row.length * CELL_CHARS > Math.max(0, out.room) + 1) return tooBig(t);
          }
          return;
        }
        case 'tr': {
          const t = st.table;
          if (t?.row && st.nest === 0) {
            const row = t.row;
            t.row = null;
            // The padded table must still fit; a row that would make it too big is left out.
            const width = Math.max(t.width, row.length);
            if ((t.rows.length + 1) * width * CELL_CHARS > Math.max(0, out.room) + 1) return tooBig(t);
            t.rows.push(row);
            t.width = width;
          }
          return;
        }
        case 'tbl': {
          if (st.nest > 0) {
            st.nest--;
            return;
          }
          return st.table ? finishTable(st.table) : undefined;
        }
      }
    },
    text(text) {
      if (st.skip === 0 && st.inText > 0) {
        const p = st.paras.at(-1);
        if (p) p.text += take(text);
      }
    },
  });
  if (st.over) out.stop();
}
