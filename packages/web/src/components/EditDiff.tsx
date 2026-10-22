import type { JSX } from 'react';
import type { EditDiffInfo } from '../lib/editDiff.js';

export type EditDiffStatus = 'applied' | 'pending' | 'failed';

const ROW = {
  add: 'bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]',
  del: 'bg-[var(--diff-del-bg)] text-[var(--diff-del-text)]',
  ctx: 'text-[var(--text-muted)]',
  gap: 'text-[var(--text-faint)]',
} as const;
const MARK = { add: '+', del: '−', ctx: ' ', gap: ' ' } as const;

/**
 * A file edit as a compact red/green diff (spec 2026-10-20-code-tab-design, Goal 5), shown in
 * every chat outside the "Used N tools" fold. It is what the call asked for: a failed
 * result marks it so, and one with no result yet is pending. Text is rendered as text, never HTML.
 * It starts folded to its header (path and counts) unless `defaultOpen`; the header expands it.
 */
export function EditDiff({ info, status = 'applied', defaultOpen = false }: { info: EditDiffInfo; status?: EditDiffStatus; defaultOpen?: boolean }): JSX.Element {
  return (
    <details
      data-testid="edit-diff"
      open={defaultOpen}
      className={`group my-1 overflow-hidden rounded border text-xs ${status === 'failed' ? 'border-[var(--danger)]' : 'border-[var(--border)]'} bg-[var(--bg-raised)]`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 select-none group-open:border-b group-open:border-[var(--border)] [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className="min-w-0 flex-1 truncate font-mono font-medium" title={info.path}>
          <bdi>{info.path}</bdi>
        </span>
        {info.isNewFile && <span className="text-[var(--text-muted)]">wrote</span>}
        {status === 'failed' && <span className="text-[var(--danger)]">failed</span>}
        {status === 'pending' && <span className="text-[var(--text-muted)]">pending</span>}
        <span className="tabular-nums">{`+${info.added} −${info.removed}`}</span>
      </summary>
      {/* Relative, so the rows' sr-only labels (absolute) are clipped here too: otherwise a long diff's labels
          sit far below this box and stretch the thread's scroller with empty space. */}
      <div className="relative max-h-72 overflow-auto font-mono">
        {info.lines.map((l, i) => (
          <div key={i} data-diff={l.kind} className={`flex whitespace-pre px-2 ${ROW[l.kind]}`}>
            <span aria-hidden="true" className="w-4 shrink-0 select-none">
              {MARK[l.kind]}
            </span>
            {l.kind === 'add' && <span className="sr-only">added</span>}
            {l.kind === 'del' && <span className="sr-only">removed</span>}
            <span>{l.kind === 'gap' ? '…' : l.text}</span>
          </div>
        ))}
        {info.truncated !== undefined && <div className="px-2 text-[var(--text-muted)]">{`+${info.truncated} more lines`}</div>}
      </div>
    </details>
  );
}
