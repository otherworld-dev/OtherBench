import { useState, type JSX } from 'react';
import { MarkdownBody } from './MarkdownBody.js';

/**
 * The line in the thread where a long chat's request is cut for a model API
 * (docs/features/history-summary.md): the messages above it reach the model
 * as a summary, the ones below word for word. Drawn by the thread under the
 * last message the summary covers; the summary itself opens under the line.
 * Nothing above is gone: this only says what the model is sent.
 */
export function HistorySummaryLine({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div data-history-summary className="my-2 text-xs text-[var(--text-muted)]">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border)]" />
        <span>Earlier messages are summarised for the model from here up</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="underline hover:text-[var(--text)]">
          {open ? 'Hide summary' : 'Show summary'}
        </button>
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border)]" />
      </div>
      {open && (
        <div className="mt-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1">
          <p className="mb-1 text-[var(--text-faint)]">The model reads this in place of the messages above. They are all still in the chat.</p>
          <div className="text-sm">
            <MarkdownBody text={text} />
          </div>
        </div>
      )}
    </div>
  );
}
