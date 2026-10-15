import { createContext, useContext, useEffect, useId, useState, type JSX, type ReactNode } from 'react';
import { setSectionOpen, useSectionChoice } from '../state/inspectorSections.js';

export type SummaryTone = 'normal' | 'warn' | 'danger';

interface Summary {
  text: string | null;
  tone: SummaryTone;
}

const ReportSummary = createContext<(summary: Summary | null) => void>(() => {});

/**
 * Puts a one-line summary in the enclosing section's header, so a closed
 * section still says what it holds. A `warn` or `danger` tone colours the
 * header and opens the section unless it was closed by hand: closing one
 * hides the detail, never the problem (the Inspector's honest-state rule).
 * Does nothing outside a Section.
 */
export function useSectionSummary(text: string | null, tone: SummaryTone = 'normal'): void {
  const report = useContext(ReportSummary);
  useEffect(() => report({ text, tone }), [report, text, tone]);
  useEffect(() => () => report(null), [report]);
}

const TONE_CLASS: Record<SummaryTone, string> = {
  normal: 'text-[var(--text-muted)]',
  warn: 'text-[var(--warn)]',
  danger: 'text-[var(--danger)]',
};

export interface SectionProps {
  title: string;
  /** Starts open until opened or closed by hand. */
  defaultOpen?: boolean;
  /** False for a short section that is always shown whole, with a plain heading. */
  collapsible?: boolean;
  /** Tooltip on the header: the explanation that used to sit in the body. */
  hint?: string;
  children: ReactNode;
}

/**
 * One Inspector section. A collapsible one is a header button (title, then
 * the body's summary) over a body that stays mounted while hidden, so its
 * polling and its summary keep running. Open or closed by hand is remembered
 * per title.
 */
export function Section({ title, defaultOpen = false, collapsible = true, hint, children }: SectionProps): JSX.Element {
  const bodyId = useId();
  const [summary, setSummary] = useState<Summary | null>(null);
  const choice = useSectionChoice(title);
  const tone = summary?.tone ?? 'normal';
  // Once a problem has opened it, it stays open when the problem clears, until closed by hand: clearing one is
  // often done from inside the section (unticking a failing MCP server), which mustn't shut under the pointer.
  const [raised, setRaised] = useState(false);
  if (tone !== 'normal' && !raised) setRaised(true);
  const open = !collapsible || (choice ?? (defaultOpen || tone !== 'normal' || raised));

  if (!collapsible) {
    return (
      <section className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
        <h3 className="label-caps mb-2 text-[var(--text-muted)]" title={hint}>
          {title}
        </h3>
        {children}
      </section>
    );
  }

  return (
    <section className="border-b border-[var(--border)] px-4 py-2 last:border-b-0">
      <h3 className="label-caps text-[var(--text-muted)]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          title={hint}
          onClick={() => setSectionOpen(title, !open)}
          className="flex w-full min-w-0 items-center gap-1.5 py-1 text-left hover:text-[var(--text)]"
        >
          <span aria-hidden="true" className="w-3 shrink-0 text-[0.625rem]">
            {open ? '▾' : '▸'}
          </span>
          <span className={`shrink-0 ${tone === 'normal' ? '' : TONE_CLASS[tone]}`}>{title}</span>{' '}
          {summary?.text && (
            <span data-tone={tone} className={`ml-auto min-w-0 truncate pl-2 font-sans text-xs font-normal tracking-normal normal-case ${TONE_CLASS[tone]}`}>
              {summary.text}
            </span>
          )}
        </button>
      </h3>
      <div id={bodyId} hidden={!open} className="pt-1 pb-1">
        <ReportSummary.Provider value={setSummary}>{children}</ReportSummary.Provider>
      </div>
    </section>
  );
}
