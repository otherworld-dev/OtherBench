import { Component, Fragment, type ErrorInfo, type JSX, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  /** What this piece is, as the fallback names it: "this message", "this chat", "Settings". */
  what: string;
  /**
   * How the fallback sits: `inline` in the flow (a message), `block` filling its box (a pane), `overlay` over the
   * window as the full-screen views do, `page` for the whole window.
   */
  variant?: 'inline' | 'block' | 'overlay' | 'page';
  /** The content that couldn't be drawn (a message), offered as JSON behind "Show raw content". */
  raw?: unknown;
  /** Closes the piece (an overlay): the fallback offers Close, as the view's own header would have. */
  onClose?: () => void;
  /** What the piece shows (a pane's chat id): when it changes, a failed piece is tried again by itself. */
  resetKey?: unknown;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped by Try again: the children mount afresh under a new key. */
  attempt: number;
  rawShown: boolean;
  resetKey: unknown;
}

const VARIANT_CLASS: Record<NonNullable<ErrorBoundaryProps['variant']>, string> = {
  inline: 'rounded border border-[var(--danger)] bg-[var(--bg)] px-3 py-2',
  block: 'flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center',
  overlay: 'fixed inset-0 z-30 flex flex-col items-center justify-center gap-2 overflow-auto bg-[var(--bg)] p-6 text-center',
  page: 'flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center font-sans',
};

/** The content as text to read: JSON where it can be, else whatever it prints as. */
function rawText(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}

/**
 * Keeps a throw while drawing one piece of the window (an unexpected part from a newer paired machine, a
 * malformed tool result) to that piece: the rest stays up, and the piece says what failed with a Try again that
 * mounts it afresh. Placed per pane, per message, per full-screen view and round the whole app (main.tsx), so
 * the smallest piece that can fail is the one that does. A class: React has no hook for catching a render error.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, attempt: 0, rawShown: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    // Something else is shown here now: whatever failed for the last one says nothing about this one.
    return { resetKey: props.resetKey, error: null, rawShown: false, attempt: state.error ? state.attempt + 1 : state.attempt };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[otherbench-web] couldn't show ${this.props.what}:`, error, info.componentStack);
  }

  override render(): JSX.Element {
    const { what, variant = 'block', raw, onClose, children } = this.props;
    const { error, attempt, rawShown } = this.state;
    if (error === null) return <Fragment key={attempt}>{children}</Fragment>;
    return (
      <div role="alert" data-testid="error-boundary" className={`text-sm ${VARIANT_CLASS[variant]}`}>
        <p className="text-[var(--danger)]">{`Couldn't show ${what}.`}</p>
        <p className="max-w-full break-words text-xs text-[var(--text-faint)]">{error.message}</p>
        <div className={`mt-1 flex flex-wrap gap-2 ${variant === 'inline' ? '' : 'justify-center'}`}>
          <button type="button" onClick={() => this.setState((s) => ({ error: null, rawShown: false, attempt: s.attempt + 1 }))} className="btn px-2 py-0.5 text-xs">
            Try again
          </button>
          {raw !== undefined && (
            <button type="button" aria-expanded={rawShown} onClick={() => this.setState((s) => ({ rawShown: !s.rawShown }))} className="btn px-2 py-0.5 text-xs">
              {rawShown ? 'Hide raw content' : 'Show raw content'}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className="btn px-2 py-0.5 text-xs">
              Close
            </button>
          )}
        </div>
        {raw !== undefined && rawShown && (
          <pre className="mt-2 max-h-80 max-w-full overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--bg-sunken)] p-2 text-left font-mono text-xs [overflow-wrap:anywhere]">
            {rawText(raw)}
          </pre>
        )}
      </div>
    );
  }
}
