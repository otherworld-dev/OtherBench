import { useRef, type JSX } from 'react';
import { revealPath } from '../desktop/bridge.js';
import { useToasts, type Toast } from '../lib/toasts.js';
import { openChat } from '../overview/openFromOverview.js';

/** The toasts (lib/toasts.ts), bottom right, read out politely by screen readers. */
export function Toaster(): JSX.Element {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-3 right-3 z-50 flex max-w-[min(26rem,calc(100vw-1.5rem))] flex-col gap-2">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} />
      ))}
    </div>
  );
}

/**
 * One toast. It waits while the pointer is over it or focus is in it (Deck d1113, WCAG 2.2.1), so a keyboard user
 * can reach Undo. When one of its buttons takes it away with focus inside, focus goes back where it came from, unless
 * the button's action moved it somewhere already.
 */
function ToastView({ toast: t }: { toast: Toast }): JSX.Element {
  const dismiss = useToasts((s) => s.dismiss);
  const pause = useToasts((s) => s.pause);
  const resume = useToasts((s) => s.resume);
  const hovered = useRef(false);
  const focused = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);

  const done = (): void => {
    const back = focused.current ? returnTo.current : null;
    dismiss(t.id);
    if (!back) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (back.isConnected && (active === null || active === document.body)) back.focus();
    }, 0);
  };

  return (
    <div
      data-testid="toast"
      onMouseEnter={() => {
        hovered.current = true;
        pause(t.id);
      }}
      onMouseLeave={() => {
        hovered.current = false;
        if (!focused.current) resume(t.id);
      }}
      onFocus={(e) => {
        if (focused.current) return;
        focused.current = true;
        const from = e.relatedTarget;
        returnTo.current = from instanceof HTMLElement && !e.currentTarget.contains(from) ? from : null;
        pause(t.id);
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        focused.current = false;
        if (!hovered.current) resume(t.id);
      }}
      className={`pointer-events-auto flex items-center gap-2 rounded border bg-[var(--bg-raised)] px-3 py-2 text-sm shadow-lg ${t.tone === 'error' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--border)]'}`}
    >
      {t.chatId ? (
        <button
          type="button"
          className="min-w-0 flex-1 break-words text-left underline decoration-dotted underline-offset-2"
          onClick={() => {
            openChat(t.chatId!);
            done();
          }}
        >
          {t.text}
        </button>
      ) : (
        <span className="min-w-0 flex-1 break-words">{t.text}</span>
      )}
      {t.action && (
        <button
          type="button"
          className="btn shrink-0 px-2 py-0.5"
          onClick={() => {
            t.action!.run();
            done();
          }}
        >
          {t.action.label}
        </button>
      )}
      {t.path && (
        <button type="button" className="btn shrink-0 px-2 py-0.5" onClick={() => void revealPath(t.path!)}>
          Show in folder
        </button>
      )}
      <button type="button" aria-label="Dismiss" className="btn shrink-0 px-1.5 py-0.5" onClick={done}>
        ×
      </button>
    </div>
  );
}
