import { attr, prefixedAttr, scanXml } from './xml.js';
import { markdownTable, type OfficeParts, type TextOut } from './parts.js';

/**
 * PowerPoint (spec 2026-10-12-office-files §1): every slide's text, tables
 * and speaker notes, in the presentation's order. Not masters or layouts.
 *
 * The work is linear in the file's size however hostile it is, and nothing is
 * buffered past the text cap. Every string the reader builds is clipped to the
 * room left in the output (a slide is read only until what it holds comes to
 * that room), a table is cut once its padded size can't fit, and a part is
 * read and parsed once however many slides in the list point at it (a list of
 * a hundred thousand ids for one slide costs one read, and the output ends at
 * the cap anyway). No regex runs over a file-controlled string.
 */

const MAX_LEVEL = 8;
/** Output characters per table cell at the least, empty or not: " | " (so the check on a table's padded size never cuts one that would fit). */
const CELL_CHARS = 3;
const TABLE_CUT = '[Grunt left out the rest of this table: it is over the text limit.]';

/** An indent level from an attribute: a hostile one (negative, huge, not a number) is clamped, never passed to repeat(). */
const levelOf = (value: string | undefined): number => Math.min(MAX_LEVEL, Math.max(0, Math.trunc(Number(value ?? 0)) || 0));

/** A handler's result: false (stop the scan) unless the reading can go on. */
const goOn = (ok: boolean): false | undefined => (ok ? undefined : false);

/** Counts what a reader holds against a budget (the room left in the output plus one): text that doesn't fit is dropped and `over` says so. */
class Budget {
  held = 0;
  over = false;

  constructor(readonly limit: number) {}

  /** The part of `text` that fits. */
  take(text: string): string {
    if (text === '') return '';
    const free = this.limit - this.held;
    if (free <= 0) {
      this.over = true;
      return '';
    }
    const kept = text.length > free ? text.slice(0, free) : text;
    if (kept.length < text.length) this.over = true;
    this.held += kept.length;
    return kept;
  }

  /** Characters already held and counted. */
  add(chars: number): void {
    this.held += chars;
    if (this.held >= this.limit) this.over = true;
  }
}

interface Shape {
  title: boolean;
  paras: string[];
}

interface Para {
  text: string;
  lvl: number;
}

interface Tbl {
  rows: string[][];
  row: string[] | null;
  cell: string[] | null;
  /** Characters held in finished cell pieces (counted in the budget). */
  chars: number;
  width: number;
  over: boolean;
}

interface Slide {
  title: string | null;
  hidden: boolean;
  lines: string[];
  /** Text was dropped for lack of room: nothing after this slide can fit. */
  over: boolean;
}

function readSlide(xml: string, limit: number): Slide {
  const b = new Budget(limit);
  const st = {
    title: null as string | null,
    hidden: false,
    lines: [] as string[],
    shape: null as Shape | null,
    para: null as Para | null,
    table: null as Tbl | null,
    /** Depth of tables nested in a cell: their text goes into that cell. */
    nest: 0,
    skip: 0,
    inT: 0,
  };

  const pushLine = (line: string): void => {
    st.lines.push(line);
    b.add(line.length);
  };

  // The shape's paragraphs are lines, or the slide's title when it's the first title placeholder.
  const flushShape = (): void => {
    const shape = st.shape;
    st.shape = null;
    if (!shape) return;
    if (shape.title && st.title === null) {
      const joined = shape.paras.map((p) => p.trim()).join(' ');
      if (joined !== '') {
        st.title = joined;
        return;
      }
    }
    for (const p of shape.paras) st.lines.push(p);
  };

  // A table whose padded size can't fit in what's left is cut, however its cells are filled.
  const tooBig = (t: Tbl): boolean => {
    const rows = t.rows.length + 1;
    const width = Math.max(1, t.width, t.row?.length ?? 0);
    return rows * width * CELL_CHARS + t.chars > b.limit - (b.held - t.chars);
  };

  // Writes the table out as Markdown; false once the reading should stop.
  const finishTable = (t: Tbl): boolean => {
    st.table = null;
    b.held -= t.chars;
    for (const line of markdownTable(t.rows)) pushLine(line);
    if (t.over) {
      pushLine(TABLE_CUT);
      b.over = true;
    }
    return !b.over;
  };

  const cutTable = (t: Tbl): boolean => {
    t.over = true;
    return finishTable(t);
  };

  scanXml(xml, {
    open(local, attrs) {
      if (st.skip > 0) {
        st.skip++;
        return;
      }
      switch (local) {
        case 'Fallback':
          st.skip = 1;
          return;
        case 'sld': {
          const show = attr(attrs, 'show');
          st.hidden = show === '0' || show === 'false';
          return;
        }
        case 'sp':
          flushShape();
          st.shape = { title: false, paras: [] };
          return;
        case 'ph': {
          const type = attr(attrs, 'type');
          if (st.shape) st.shape.title = type === 'title' || type === 'ctrTitle';
          return;
        }
        case 'tbl':
          if (st.table !== null || st.nest > 0) st.nest++;
          else st.table = { rows: [], row: null, cell: null, chars: 0, width: 0, over: false };
          return;
        case 'tr':
          if (st.table && st.nest === 0) st.table.row = [];
          return;
        case 'tc':
          if (st.table?.row && st.nest === 0) st.table.cell = [];
          return;
        case 'p':
          if (st.para) b.held -= st.para.text.length;
          st.para = { text: '', lvl: 0 };
          return;
        case 'pPr':
          if (st.para) st.para.lvl = levelOf(attr(attrs, 'lvl'));
          return;
        case 't':
          st.inT++;
          return;
        case 'br':
          if (st.para) st.para.text += b.take(' ');
          return;
      }
    },
    close(local) {
      if (st.skip > 0) {
        st.skip--;
        return;
      }
      switch (local) {
        case 't':
          st.inT = Math.max(0, st.inT - 1);
          return;
        case 'p': {
          const para = st.para;
          st.para = null;
          if (!para) return;
          b.held -= para.text.length;
          const text = para.text.trim();
          const t = st.table;
          if (text !== '') {
            if (t?.cell) {
              t.cell.push(text);
              t.chars += text.length;
              b.add(text.length);
            } else if (st.shape) {
              const line = `${'  '.repeat(para.lvl)}${text}`;
              st.shape.paras.push(line);
              b.add(line.length);
            } else pushLine(text);
          }
          // Out of room: what's open is written and the reading ends (a table is ended by its own checks).
          return b.over && t === null ? false : undefined;
        }
        case 'tc': {
          const t = st.table;
          if (t?.row && t.cell && st.nest === 0) {
            t.row.push(t.cell.join(' '));
            t.cell = null;
            // A row with more cells than there is room for can't be written whatever is in them.
            if (tooBig(t)) return goOn(cutTable(t));
          }
          return;
        }
        case 'tr': {
          const t = st.table;
          if (t?.row && st.nest === 0) {
            // A row with no cells still costs a line (tooBig counts at least one column).
            if (tooBig(t)) return goOn(cutTable(t));
            t.width = Math.max(1, t.width, t.row.length);
            t.rows.push(t.row);
            t.row = null;
          }
          return;
        }
        case 'tbl': {
          if (st.nest > 0) {
            st.nest--;
            return;
          }
          const t = st.table;
          if (!t) return;
          return goOn(finishTable(t));
        }
        case 'sp':
          flushShape();
          return;
      }
    },
    text(text) {
      if (st.skip === 0 && st.inT > 0 && st.para) st.para.text += b.take(text);
    },
  });
  // Reading ended with a shape open (out of room in its last paragraph): what it holds still counts.
  flushShape();
  return { title: st.title, hidden: st.hidden, lines: st.lines, over: b.over };
}

interface Notes {
  /** The "Notes: …" line, or null when there are no notes. */
  line: string | null;
  over: boolean;
}

/** The speaker notes: the notes slide's body placeholder only (not the slide image or the number). */
function readNotes(xml: string, limit: number): Notes {
  const b = new Budget(limit);
  const notes: string[] = [];
  const st = { inSp: false, body: false, para: null as string | null, inT: 0 };
  scanXml(xml, {
    open(local, attrs) {
      if (local === 'sp') {
        st.inSp = true;
        st.body = false;
      } else if (local === 'ph' && st.inSp) st.body = attr(attrs, 'type') === 'body';
      else if (local === 'p') {
        if (st.para !== null) b.held -= st.para.length;
        st.para = '';
      } else if (local === 't') st.inT++;
    },
    close(local) {
      if (local === 't') st.inT = Math.max(0, st.inT - 1);
      else if (local === 'p') {
        const para = st.para;
        st.para = null;
        if (para === null) return;
        b.held -= para.length;
        const text = para.trim();
        if (st.body && text !== '') {
          notes.push(text);
          b.add(text.length);
        }
        if (b.over) return false;
      } else if (local === 'sp') {
        st.inSp = false;
        st.body = false;
      }
    },
    text(text) {
      // Only the notes body is kept, so text of other shapes isn't buffered at all.
      if (st.inT > 0 && st.para !== null && st.body) st.para += b.take(text);
    },
  });
  return { line: notes.length > 0 ? `Notes: ${notes.join('\n')}` : null, over: b.over };
}

export function readPowerPoint(parts: OfficeParts, out: TextOut): void {
  const presentation = parts.text('ppt/presentation.xml');
  if (presentation === null) return;
  const ids: string[] = [];
  scanXml(presentation, {
    open(local, attrs) {
      if (local !== 'sldId') return;
      const id = prefixedAttr(attrs, 'id');
      if (id) ids.push(id);
    },
  });
  const rels = parts.rels('ppt/presentation.xml');

  // Each slide and notes part is read once however many ids point at it (a missing or oversize one is remembered too, so its note isn't repeated).
  const slides = new Map<string, (Slide & { notes: Notes | null }) | null>();
  const notesParts = new Map<string, Notes | null>();
  const load = (target: string): (Slide & { notes: Notes | null }) | null => {
    const xml = parts.text(target);
    if (xml === null) return null;
    const slide = readSlide(xml, Math.max(0, out.room) + 1);
    let notes: Notes | null = null;
    if (!slide.over) {
      const notesTarget = [...parts.rels(target).values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
      if (notesTarget) {
        notes = notesParts.get(notesTarget) ?? null;
        if (!notesParts.has(notesTarget)) {
          const notesXml = parts.text(notesTarget);
          notes = notesXml === null ? null : readNotes(notesXml, Math.max(0, out.room) + 1);
          notesParts.set(notesTarget, notes);
        }
      }
    }
    return { ...slide, notes };
  };

  let wrote = false;
  for (const [i, id] of ids.entries()) {
    const target = rels.get(id)?.target;
    if (!target) continue;
    let slide = slides.get(target);
    if (slide === undefined) {
      slide = load(target);
      slides.set(target, slide);
    }
    if (slide === null) {
      if (parts.stopped) return;
      continue;
    }
    // A blank line between slides, and none before the first one written.
    if (wrote && !out.line('')) return;
    wrote = true;
    const head = `Slide ${i + 1}${slide.title ? `: ${slide.title}` : ''}${slide.hidden ? ' (hidden)' : ''}`;
    if (!out.line(head)) return;
    for (const line of slide.lines) if (!out.line(line)) return;
    if (slide.notes?.line && !out.line(slide.notes.line)) return;
    if (slide.over || slide.notes?.over) {
      out.stop();
      return;
    }
    if (parts.stopped) return;
  }
}
