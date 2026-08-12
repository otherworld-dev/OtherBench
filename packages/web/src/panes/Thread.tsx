import { useMemo, type JSX } from 'react';
import { activePath, siblingsOf } from '@grunt/core/domain/tree.js';
import type { Chat } from '@grunt/core/ports/store.js';
import { useGruntStore } from '../state/store.js';

function textOf(parts: { type: string; text?: string }[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

/**
 * Centre pane -- task 19 ships a plain-text placeholder that can display a
 * message tree (including one with siblings from a compare turn) without
 * breaking; task 20 replaces the message rendering with Markdown, a
 * streaming caret, and the composer. `siblingsOf` is exercised here
 * specifically so a compare turn's sibling set never throws -- see
 * packages/core/src/domain/tree.ts.
 */
export function Thread({ chat }: { chat: Chat | null }): JSX.Element {
  const messages = useGruntStore((s) => s.messages);

  const path = useMemo(() => {
    if (!chat?.headMessageId) return [];
    try {
      return activePath(Object.values(messages), chat.headMessageId);
    } catch {
      return [];
    }
  }, [chat, messages]);

  if (!chat) {
    return (
      <main className="flex h-full w-full flex-1 items-center justify-center text-sm text-[var(--text-faint)]">
        Select a chat, or start a new one, to begin.
      </main>
    );
  }

  return (
    <main className="flex h-full w-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6">
        {path.length === 0 ? (
          <p className="text-sm text-[var(--text-faint)]">No messages yet -- say something below.</p>
        ) : (
          path.map((m) => {
            const allMessages = Object.values(messages);
            const siblingCount = (() => {
              try {
                return siblingsOf(allMessages, m.id).length;
              } catch {
                return 1;
              }
            })();
            return (
              <article key={m.id} data-role={m.role} data-status={m.status} className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <span className="font-medium">{m.role === 'user' ? 'You' : m.producedBy?.profileName ?? 'Assistant'}</span>
                  {m.status === 'streaming' && <span aria-label="streaming">…</span>}
                  {m.status === 'error' && <span className="text-[var(--danger)]">error</span>}
                  {siblingCount > 1 && (
                    // Seam for task 27's tab strip: for now just a plain
                    // count so a compare turn is visible and doesn't break
                    // the thread renderer.
                    <span data-testid="compare-seam" className="rounded border border-[var(--border)] px-1">
                      {siblingCount} variants
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm">{textOf(m.parts) || (m.status === 'streaming' ? '' : '(no text)')}</p>
              </article>
            );
          })
        )}
      </div>
    </main>
  );
}
