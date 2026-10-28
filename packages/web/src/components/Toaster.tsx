import type { JSX } from 'react';
import { revealPath } from '../desktop/bridge.js';
import { useToasts } from '../lib/toasts.js';
import { openChat } from '../overview/openFromOverview.js';

/** The toasts (lib/toasts.ts), bottom right, read out politely by screen readers. */
export function Toaster(): JSX.Element {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-3 right-3 z-50 flex max-w-[min(26rem,calc(100vw-1.5rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          className={`pointer-events-auto flex items-center gap-2 rounded border bg-[var(--bg-raised)] px-3 py-2 text-sm shadow-lg ${t.tone === 'error' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--border)]'}`}
        >
          {t.chatId ? (
            <button
              type="button"
              className="min-w-0 flex-1 break-words text-left underline decoration-dotted underline-offset-2"
              onClick={() => {
                openChat(t.chatId!);
                dismiss(t.id);
              }}
            >
              {t.text}
            </button>
          ) : (
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
          )}
          {t.path && (
            <button type="button" className="btn shrink-0 px-2 py-0.5" onClick={() => void revealPath(t.path!)}>
              Show in folder
            </button>
          )}
          <button type="button" aria-label="Dismiss" className="btn shrink-0 px-1.5 py-0.5" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
