import type { JSX, ReactNode } from 'react';

/**
 * The line a /clear or /compact leaves in the thread: a thin rule with a small
 * muted label, and a compact's focus under it. `id` is the DOM id the outline's
 * "Go to" scrolls to; `aside` sits at the line's right end, outside the
 * separator (whose children are presentational), e.g. the branch switcher.
 */
export function ContextLine({ kind, focus, at, id, aside }: { kind: 'clear' | 'compact'; focus?: string; at: number; id?: string; aside?: ReactNode }): JSX.Element {
  const label = kind === 'clear' ? 'Context cleared' : 'Context compacted';
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div id={id} data-context-line={kind} className="my-2 flex items-start gap-2 text-xs text-[var(--text-muted)]">
      <div role="separator" className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-px flex-1 bg-[var(--border)]" />
          <span className="label-caps">{label}</span>
          <time dateTime={new Date(at).toISOString()} className="text-[var(--text-faint)]">
            {time}
          </time>
          <span aria-hidden="true" className="h-px flex-1 bg-[var(--border)]" />
        </div>
        {kind === 'compact' && focus && <p className="mt-1 text-center whitespace-pre-wrap">{focus}</p>}
      </div>
      {aside}
    </div>
  );
}
