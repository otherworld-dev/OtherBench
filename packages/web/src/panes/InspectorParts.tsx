import type { JSX, ReactNode } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { machineName } from '../state/machines.js';
import { useOtherBenchStore } from '../state/store.js';

export function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-[var(--text-faint)]">{children}</p>;
}

/** "Show all (N)" / "Show fewer" toggle shared by the capped Inspector lists. */
export function ShowAllToggle({ total, limit, expanded, onToggle }: { total: number; limit: number; expanded: boolean; onToggle: () => void }): JSX.Element | null {
  if (total <= limit) return null;
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className="mt-2 text-xs text-[var(--text-muted)] underline hover:text-[var(--text)]">
      {expanded ? 'Show fewer' : `Show all (${total})`}
    </button>
  );
}

/**
 * Above Tool grants, MCP servers and Audit trail for a chat that runs on a paired machine: those are each machine's
 * own, and what the sections show is that machine's, read from there, so this says whose they are.
 */
export function ElsewhereNote({ chat, what }: { chat: Chat | null; what: string }): JSX.Element | null {
  const machines = useOtherBenchStore((s) => s.machines);
  if (!chat || !machines || chat.runsOn === machines.self.id) return null;
  return (
    <p data-testid="inspector-elsewhere-note" className="mb-2 text-xs text-[var(--text-muted)]">
      This chat runs on {machineName(machines, chat.runsOn)}. {what}
    </p>
  );
}
