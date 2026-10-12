import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { columnName, parseSpreadsheet, type Cell, type OfficeKind, type SheetSpec } from '@grunt/core/domain/office-spec.js';
import { MarkdownBody } from '../components/MarkdownBody.js';

/**
 * Office artifacts drawn from their source (spec 2026-10-12-office-files §5),
 * not from the made file: close to the file, not exact, and formulas show as
 * formulas because Grunt doesn't work them out. Everything is React text: no
 * HTML from the source, no links or images in a sheet, no iframe.
 */

export const PREVIEW_MAX_ROWS = 1000;
export const PREVIEW_MAX_COLUMNS = 100;
const ROW_PX = 24;
const ROW_HEADER_PX = 44;
const CHAR_PX = 7;
const HEAD = 'border border-[var(--border)] bg-[var(--bg-raised)] px-1 font-normal text-[var(--text-faint)]';

/** Dark text on white in both themes, as the file will be. */
const PAPER = {
  background: '#ffffff',
  color: '#1d1b18',
  '--text': '#1d1b18',
  '--text-muted': '#5c564c',
  '--text-faint': '#8d8578',
  '--border': '#d9d3c8',
  '--bg': '#ffffff',
  '--bg-raised': '#f4f1ec',
  '--bg-sunken': '#ece7df',
} as CSSProperties;

export function OfficePreview({ kind, content }: { kind: OfficeKind; content: string }): JSX.Element {
  switch (kind) {
    case 'document':
      return <DocumentPreview content={content} />;
    case 'spreadsheet':
      return <SpreadsheetPreview content={content} />;
  }
}

function Unreadable({ error }: { error: string }): JSX.Element {
  return (
    <div role="alert" className="space-y-1 p-3 text-sm">
      <p className="text-[var(--danger)]">This can't be previewed: {error}</p>
      <p className="text-[var(--text-faint)]">Use Source to see it.</p>
    </div>
  );
}

function DocumentPreview({ content }: { content: string }): JSX.Element {
  return (
    <div className="flex justify-center bg-[var(--bg-sunken)] p-4">
      <div data-testid="office-page" style={PAPER} className="w-full max-w-[21cm] rounded-sm px-12 py-10 shadow-md">
        <MarkdownBody text={content} />
      </div>
    </div>
  );
}

function cellView(cell: Cell): { text: string; formula: boolean; style: CSSProperties } {
  if (cell === null) return { text: '', formula: false, style: {} };
  if (typeof cell === 'string') return { text: cell, formula: cell.startsWith('='), style: {} };
  if (typeof cell === 'number') return { text: String(cell), formula: false, style: { textAlign: 'right' } };
  if (typeof cell === 'boolean') return { text: cell ? 'TRUE' : 'FALSE', formula: false, style: { textAlign: 'center' } };
  const style: CSSProperties = {
    ...(cell.bold ? { fontWeight: 700 } : {}),
    ...(cell.italic ? { fontStyle: 'italic' } : {}),
    ...(cell.align ? { textAlign: cell.align } : {}),
    ...(cell.color ? { color: cell.color } : {}),
    ...(cell.fill ? { background: cell.fill } : {}),
    ...(cell.wrap ? { whiteSpace: 'pre-wrap' } : {}),
  };
  if (cell.formula !== undefined) return { text: cell.formula.startsWith('=') ? cell.formula : `=${cell.formula}`, formula: true, style };
  if (cell.date !== undefined) return { text: cell.date.replace('T', ' '), formula: false, style };
  const value = cell.value;
  const text = value === undefined || value === null ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  return { text, formula: false, style: typeof value === 'number' && !cell.align ? { textAlign: 'right', ...style } : style };
}

function SheetTable({ sheet }: { sheet: SheetSpec }): JSX.Element {
  const width = sheet.rows.reduce((w, row) => Math.max(w, row.length), 0);
  const cols = Math.min(width, PREVIEW_MAX_COLUMNS);
  const rows = sheet.rows.slice(0, PREVIEW_MAX_ROWS);
  const frozenRows = Math.min(sheet.freeze?.rows ?? 0, rows.length);
  const frozenCols = Math.min(sheet.freeze?.columns ?? 0, cols);
  const colPx = (i: number): number => Math.round((sheet.columns?.[i]?.width ?? 10) * CHAR_PX);
  const lefts: number[] = [];
  for (let i = 0, left = ROW_HEADER_PX; i < cols; i++) {
    lefts.push(left);
    left += colPx(i);
  }
  const cut = [
    ...(sheet.rows.length > PREVIEW_MAX_ROWS ? [`the first ${PREVIEW_MAX_ROWS.toLocaleString('en-US')} rows`] : []),
    ...(width > PREVIEW_MAX_COLUMNS ? [`the first ${PREVIEW_MAX_COLUMNS} columns`] : []),
  ];
  // Frozen rows and columns stay put as the sheet scrolls, as in Excel.
  const sticky = (top: number | null, left: number | null): CSSProperties => ({
    ...(top !== null || left !== null ? { position: 'sticky', background: 'var(--bg)', zIndex: (top !== null ? 2 : 0) + (left !== null ? 1 : 0) } : {}),
    ...(top !== null ? { top } : {}),
    ...(left !== null ? { left } : {}),
  });

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {cut.length > 0 && <p className="px-3 py-1 text-xs text-[var(--warn)]">Showing {cut.join(' and ')}.</p>}
      <table className="border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr style={{ height: ROW_PX }}>
            <th aria-label="Row" style={{ ...sticky(0, 0), width: ROW_HEADER_PX }} className={HEAD} />
            {Array.from({ length: cols }, (_, i) => (
              <th key={i} scope="col" style={{ ...sticky(0, i < frozenCols ? lefts[i]! : null), width: colPx(i) }} className={HEAD}>
                {columnName(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const top = r < frozenRows ? ROW_PX * (r + 1) : null;
            return (
              <tr key={r} style={{ height: ROW_PX }}>
                <th scope="row" style={sticky(top, 0)} className={HEAD}>
                  {r + 1}
                </th>
                {Array.from({ length: cols }, (_, i) => {
                  const view = cellView(row[i] ?? null);
                  return (
                    <td
                      key={i}
                      title={view.formula ? view.text : undefined}
                      style={{ ...sticky(top, i < frozenCols ? lefts[i]! : null), ...view.style }}
                      className="overflow-hidden border border-[var(--border)] px-1 whitespace-nowrap"
                    >
                      {view.formula ? <span className="font-mono text-[var(--text-faint)]">{view.text}</span> : view.text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SpreadsheetPreview({ content }: { content: string }): JSX.Element {
  const parsed = useMemo(() => parseSpreadsheet(content), [content]);
  const [tab, setTab] = useState(0);
  if (!parsed.ok) return <Unreadable error={parsed.error} />;
  const sheets = parsed.spec.sheets;
  const index = Math.min(tab, sheets.length - 1);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Sheets" className="flex flex-wrap gap-1 border-b border-[var(--border)] px-2 pt-1 text-xs">
        {sheets.map((s, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => setTab(i)}
            className={`rounded-t px-2 py-0.5 ${i === index ? 'bg-[var(--bg-raised)] font-medium' : 'text-[var(--text-faint)]'}`}
          >
            {s.name}
          </button>
        ))}
      </div>
      <p className="px-3 py-1 text-xs text-[var(--text-faint)]">Formulas are worked out when the file is opened in Excel, LibreOffice or Google Sheets.</p>
      <SheetTable sheet={sheets[index]!} />
    </div>
  );
}
