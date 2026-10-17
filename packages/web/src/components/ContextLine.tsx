import type { JSX } from 'react';

/** The line a /clear or /compact leaves in the thread: a thin rule with a small muted label, and a compact's focus under it. */
export function ContextLine({ kind, focus, at }: { kind: 'clear' | 'compact'; focus?: string; at: number }): JSX.Element {
  const label = kind === 'clear' ? 'Context cleared' : 'Context compacted';
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div role="separator" className="my-2 text-xs text-[var(--text-muted)]">
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
  );
}
