import { attr, scanXml } from './xml.js';
import { markdownTable, type OfficeParts, type TextOut } from './parts.js';

/**
 * Word (spec 2026-10-12-office-files §1): body text, headings, lists and
 * tables from word/document.xml. Not headers, footers, footnotes or comments.
 * Deleted text, field codes, moved-away text and the second copy of a text
 * box (mc:Fallback) are skipped.
 */

const SKIP = new Set(['delText', 'instrText', 'moveFrom', 'Fallback']);

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
}

function lineOf(p: Para): string {
  const text = p.text.replace(/\s+$/, '');
  if (text === '') return '';
  if (p.heading > 0) return `${'#'.repeat(Math.min(p.heading, 6))} ${text}`;
  if (p.listLevel !== null) return `${'  '.repeat(Math.min(p.listLevel, 8))}- ${text}`;
  return text;
}

export function readWord(parts: OfficeParts, out: TextOut): void {
  const headings = headingLevels(parts.text('word/styles.xml'));
  const xml = parts.text('word/document.xml');
  if (xml === null) return;
  const st = { skip: 0, inRun: 0, inText: 0, paras: [] as Para[], tables: [] as Tbl[] };

  // Paragraphs in a table cell go into the cell; blank lines never repeat.
  const emit = (text: string): boolean => {
    const cell = st.tables.at(-1)?.cell;
    if (cell) {
      if (text.trim() !== '') cell.push(text.trim());
      return true;
    }
    if (text === '' && (out.last === undefined || out.last === '')) return true;
    return out.line(text);
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
          if (p) p.listLevel = Number(attr(attrs, 'val') ?? 0) || 0;
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
          // Only a tab in a run is a character; one in w:tabs is a tab stop.
          if (st.inRun > 0 && p) p.text += '\t';
          return;
        case 'br':
        case 'cr':
          if (st.inRun > 0 && p) p.text += '\n';
          return;
        case 'tbl':
          st.tables.push({ rows: [], row: null, cell: null });
          return;
        case 'tr': {
          const t = st.tables.at(-1);
          if (t) t.row = [];
          return;
        }
        case 'tc': {
          const t = st.tables.at(-1);
          if (t) t.cell = [];
          return;
        }
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
        case 'p': {
          const p = st.paras.pop();
          if (!p) return;
          return emit(st.tables.at(-1)?.cell ? p.text : lineOf(p));
        }
        case 'tc': {
          const t = st.tables.at(-1);
          if (t?.row && t.cell) {
            t.row.push(t.cell.join(' '));
            t.cell = null;
          }
          return;
        }
        case 'tr': {
          const t = st.tables.at(-1);
          if (t?.row) {
            t.rows.push(t.row);
            t.row = null;
          }
          return;
        }
        case 'tbl': {
          const t = st.tables.pop();
          if (!t) return;
          const outer = st.tables.at(-1);
          if (outer?.cell) {
            // A table in a cell is flattened into that cell.
            outer.cell.push(t.rows.map((row) => row.join(' ')).join(' '));
            return;
          }
          emit('');
          for (const line of markdownTable(t.rows)) if (!out.line(line)) return false;
          return emit('');
        }
      }
    },
    text(text) {
      if (st.skip === 0 && st.inText > 0) {
        const p = st.paras.at(-1);
        if (p) p.text += text;
      }
    },
  });
}
