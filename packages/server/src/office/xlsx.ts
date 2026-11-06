import writeXlsxFile, { type Cell as XlsxCell } from 'write-excel-file/node';
import { OfficeRenderError } from './errors.js';
import { formulaForFile, parseCellDate, xmlSafe, type Cell, type SpreadsheetSpec } from '@otherbench/core/domain/office-spec.js';
import { cachedFormulaValues, type CachedValue } from './formula-values.js';

/**
 * A `spreadsheet` artifact as an .xlsx (spec 2026-10-12-office-files §4).
 * Formulas are written without their "=" (OOXML has no "="), and the
 * workbook asks Excel to calculate everything on open (`fullCalcOnLoad`), so
 * the values are Excel's own. Probe, 2026-10-12: Excel 16 showed computed
 * values for SUM, IF with <, & and quotes, and a reference into a sheet
 * whose name has a space. A formula in the subset `formula-values.ts`
 * calculates also gets a cached value (`<v>`, with `t="b"` or `t="str"` for
 * TRUE/FALSE and text), which is what viewers that don't calculate show
 * (Protected View, preview panes, phones, Drive); the rest get none.
 *
 * Every formula's text is core's `formulaForFile(...).text` and nothing else.
 * The library would alter it on the way to the file (it drops "discouraged"
 * XML characters such as U+007F-U+009F and U+FFFD, and writes a CR as a
 * literal one, which an XML reader turns into LF), so the sheet's `<f>`
 * elements are written again from the same texts (see `xmlText`).
 */

/** A formula's text (or a cached value's) as XML character data that reads back as exactly that text: "&", "<" and ">" escaped, a CR and everything outside printable ASCII as character references. */
function xmlText(text: string): string {
  if (xmlSafe(text) !== text) throw new Error('A formula or its value has a character an .xlsx file cannot hold.');
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (char === '\t' || char === '\n' || (code >= 0x20 && code < 0x7f)) out += char;
    else out += `&#${code};`;
  }
  return out;
}

interface WrittenFormula {
  text: string;
  value: CachedValue | null;
}

/** A formula cell as written: its `<f>` is the checked text, then its cached value if it has one. The library writes a formula cell with no `t`. */
function formulaXml(attrs: string, formula: WrittenFormula): string {
  const value = /(?:^|\s)t="/.test(attrs) ? null : formula.value;
  const type = value === null || value.t === 'n' ? '' : ` t="${value.t}"`;
  return `<c ${attrs}${type}><f>${xmlText(formula.text)}</f>${value === null ? '' : `<v>${xmlText(value.v)}</v>`}</c>`;
}

/** The workbook asks Excel to calculate on open, and each sheet's formula cells are written again from the checked texts and cached values, in cell order. */
function features(formulasBySheet: WrittenFormula[][]) {
  return [
    {
      files: {
        transform: {
          'xl/workbook.xml': {
            transformElementAttributes: (tag: string, attrs: Record<string, string | number>) => (tag === 'calcPr' ? { ...attrs, fullCalcOnLoad: 1 } : attrs),
          },
          'xl/worksheets/sheet{id}.xml': {
            transform: (xml: string, _options: unknown, { sheetIndex }: { sheetIndex: number }) => {
              const formulas = formulasBySheet[sheetIndex] ?? [];
              let next = 0;
              const out = xml.replace(/<c ([^>]*)><f>[\s\S]*?<\/f><\/c>/g, (_cell, attrs: string) => {
                const formula = formulas[next++];
                if (formula === undefined) throw new Error('The .xlsx writer made more formulas than the sheet has.');
                return formulaXml(attrs, formula);
              });
              if (next !== formulas.length || (xml.match(/<f>/g)?.length ?? 0) !== formulas.length) throw new Error('The .xlsx writer made fewer formulas than the sheet has.');
              return out;
            },
          },
        },
      },
    },
  ];
}

interface Context {
  sheetNames: ReadonlySet<string>;
  /** The checked text and cached value of each formula written to the current sheet, in the order the cells are written. */
  formulas: WrittenFormula[];
  /** The cached value of the formula at a zero-based row and column of the current sheet, or null. */
  cached: (row: number, col: number) => CachedValue | null;
}

/** The one place a formula's file text comes from: core's formulaForFile, which has checked it. A formula it refuses (a version that came by sync, never checked) is an OfficeRenderError. */
function formulaCell(formula: string, ctx: Context, row: number, col: number): { type: 'Formula'; value: string } {
  const written = formulaForFile(formula, ctx.sheetNames);
  if (!written.ok) throw new OfficeRenderError(written.error);
  ctx.formulas.push({ text: written.text, value: ctx.cached(row, col) });
  return { type: 'Formula', value: written.text };
}

function toCell(cell: Cell, ctx: Context, row: number, col: number): XlsxCell {
  if (cell === null) return null;
  if (typeof cell === 'string') return cell.startsWith('=') ? formulaCell(cell, ctx, row, col) : { type: String, value: xmlSafe(cell) };
  if (typeof cell === 'number') return { type: Number, value: cell };
  if (typeof cell === 'boolean') return { type: Boolean, value: cell };
  const style = {
    ...(cell.bold ? { fontWeight: 'bold' as const } : {}),
    ...(cell.italic ? { fontStyle: 'italic' as const } : {}),
    ...(cell.wrap ? { wrap: true } : {}),
    ...(cell.align ? { align: cell.align } : {}),
    ...(cell.color ? { textColor: cell.color } : {}),
    ...(cell.fill ? { backgroundColor: cell.fill } : {}),
  };
  // The library takes a number format only on number, date and formula cells, and "@" (text) on a string cell; any other
  // combination throws, so a format that means nothing for the cell's type is left out rather than failing the whole file.
  const format = cell.format ? { format: xmlSafe(cell.format) } : {};
  if (cell.formula !== undefined) return { ...style, ...format, ...formulaCell(cell.formula, ctx, row, col) };
  if (cell.date !== undefined) {
    // Checked by parseSpreadsheet; the library's serial numbers are UTC-based, so the wall-clock time goes in as UTC.
    const date = parseCellDate(cell.date)!;
    return { ...style, type: Date, value: new Date(date.utcMs), format: cell.format ? xmlSafe(cell.format) : date.hasTime ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd' };
  }
  const value = cell.value;
  if (typeof value === 'string') return { ...style, ...(cell.format === '@' ? format : {}), type: String, value: xmlSafe(value) };
  if (typeof value === 'number') return { ...style, ...format, type: Number, value };
  if (typeof value === 'boolean') return { ...style, type: Boolean, value };
  return Object.keys(style).length > 0 ? style : null;
}

export async function renderXlsx(spec: SpreadsheetSpec): Promise<Buffer> {
  const sheetNames = new Set(spec.sheets.map((s) => s.name));
  const cached = cachedFormulaValues(spec);
  const formulasBySheet: WrittenFormula[][] = [];
  const sheets = spec.sheets.map((s, sheetIndex) => {
    const ctx: Context = { sheetNames, formulas: [], cached: (row, col) => cached(sheetIndex, row, col) };
    formulasBySheet.push(ctx.formulas);
    return {
      sheet: xmlSafe(s.name),
      ...(s.columns ? { columns: s.columns.map((c) => (c.width === undefined ? {} : { width: c.width })) } : {}),
      ...(s.freeze?.rows ? { stickyRowsCount: s.freeze.rows } : {}),
      ...(s.freeze?.columns ? { stickyColumnsCount: s.freeze.columns } : {}),
      data: s.rows.length > 0 ? s.rows.map((row, r) => row.map((cell, c) => toCell(cell, ctx, r, c))) : [[null]],
    };
  });
  return writeXlsxFile(sheets, { fontFamily: 'Calibri', fontSize: 11, features: features(formulasBySheet) }).toBuffer();
}
