import writeXlsxFile, { type Cell as XlsxCell } from 'write-excel-file/node';
import { OfficeRenderError } from './errors.js';
import { formulaForFile, parseCellDate, xmlSafe, type Cell, type SpreadsheetSpec } from '@grunt/core/domain/office-spec.js';

/**
 * A `spreadsheet` artifact as an .xlsx (spec 2026-10-12-office-files §4).
 * Formulas are written without their "=" (OOXML has no "="), with no
 * cached values, and the workbook
 * asks Excel to calculate everything on open (`fullCalcOnLoad`), so the
 * values are Excel's own. Probe, 2026-10-12: Excel 16 showed computed
 * values for SUM, IF with <, & and quotes, and a reference into a sheet
 * whose name has a space.
 *
 * Every formula's text is core's `formulaForFile(...).text` and nothing else.
 * The library would alter it on the way to the file (it drops "discouraged"
 * XML characters such as U+007F-U+009F and U+FFFD, and writes a CR as a
 * literal one, which an XML reader turns into LF), so the sheet's `<f>`
 * elements are written again from the same texts (see `xmlFormula`).
 */

/** A formula's text as XML character data that reads back as exactly that text: "&", "<" and ">" escaped, a CR and everything outside printable ASCII as character references. */
function xmlFormula(text: string): string {
  if (xmlSafe(text) !== text) throw new Error('A formula has a character an .xlsx file cannot hold.');
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

/** The workbook asks Excel to calculate on open, and each sheet's `<f>` elements are the checked texts, in cell order. */
function features(formulasBySheet: string[][]) {
  return [
    {
      files: {
        transform: {
          'xl/workbook.xml': {
            transformElementAttributes: (tag: string, attrs: Record<string, string | number>) => (tag === 'calcPr' ? { ...attrs, fullCalcOnLoad: 1 } : attrs),
          },
          'xl/worksheets/sheet{id}.xml': {
            transform: (xml: string, _options: unknown, { sheetIndex }: { sheetIndex: number }) => {
              const texts = formulasBySheet[sheetIndex] ?? [];
              let next = 0;
              const out = xml.replace(/<f>[\s\S]*?<\/f>/g, () => {
                const text = texts[next++];
                if (text === undefined) throw new Error('The .xlsx writer made more formulas than the sheet has.');
                return `<f>${xmlFormula(text)}</f>`;
              });
              if (next !== texts.length) throw new Error('The .xlsx writer made fewer formulas than the sheet has.');
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
  /** The checked text of each formula written to the current sheet, in the order the cells are written. */
  formulas: string[];
}

/** The one place a formula's file text comes from: core's formulaForFile, which has checked it. A formula it refuses (a version that came by sync, never checked) is an OfficeRenderError. */
function formulaCell(formula: string, ctx: Context): { type: 'Formula'; value: string } {
  const written = formulaForFile(formula, ctx.sheetNames);
  if (!written.ok) throw new OfficeRenderError(written.error);
  ctx.formulas.push(written.text);
  return { type: 'Formula', value: written.text };
}

function toCell(cell: Cell, ctx: Context): XlsxCell {
  if (cell === null) return null;
  if (typeof cell === 'string') return cell.startsWith('=') ? formulaCell(cell, ctx) : { type: String, value: xmlSafe(cell) };
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
  if (cell.formula !== undefined) return { ...style, ...format, ...formulaCell(cell.formula, ctx) };
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
  const formulasBySheet: string[][] = [];
  const sheets = spec.sheets.map((s) => {
    const ctx: Context = { sheetNames, formulas: [] };
    formulasBySheet.push(ctx.formulas);
    return {
      sheet: xmlSafe(s.name),
      ...(s.columns ? { columns: s.columns.map((c) => (c.width === undefined ? {} : { width: c.width })) } : {}),
      ...(s.freeze?.rows ? { stickyRowsCount: s.freeze.rows } : {}),
      ...(s.freeze?.columns ? { stickyColumnsCount: s.freeze.columns } : {}),
      data: s.rows.length > 0 ? s.rows.map((row) => row.map((cell) => toCell(cell, ctx))) : [[null]],
    };
  });
  return writeXlsxFile(sheets, { fontFamily: 'Calibri', fontSize: 11, features: features(formulasBySheet) }).toBuffer();
}
