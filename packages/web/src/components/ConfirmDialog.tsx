import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';

export interface ConfirmDialogProps {
  /** The question; also the dialog's accessible name. */
  title: string;
  message?: string;
  confirmLabel: string;
  /** May reject: the dialog then stays open and shows the error. The caller closes the dialog on success. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/** A small modal yes/no question. Focus starts on Cancel (the safe choice), Tab stays inside, Esc cancels. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That failed -- please try again.');
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Tab') {
      // Only two controls: Tab and Shift+Tab swap between them.
      e.preventDefault();
      (document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current)?.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onKeyDown={onKeyDown}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        className="w-80 max-w-[90vw] rounded border border-[var(--border)] bg-[var(--bg-raised)] p-4 shadow-lg"
      >
        <p id={titleId} className="text-sm font-medium break-words">
          {title}
        </p>
        {message && (
          <p id={messageId} className="mt-1 text-sm text-[var(--text-muted)]">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="rounded border border-[var(--border)] px-2.5 py-1 text-xs">
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="rounded border border-[var(--danger)] bg-[var(--danger)] px-2.5 py-1 text-xs text-white disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
