import type { JSX } from 'react';
import type { TodoItem, TodoStatus } from '@otherbench/core/types/thread.js';

/** Steps shown before the rest are summed up (a Claude Code list can be longer than update_todos allows). */
export const TODO_SHOWN_MAX = 50;

const MARK: Record<TodoStatus, string> = { completed: '✓', in_progress: '◐', pending: '○' };
const WORD: Record<TodoStatus, string> = { completed: 'Done', in_progress: 'In progress', pending: 'To do' };

/** "2 of 5 done". */
export function todoCounts(todos: readonly TodoItem[]): string {
  return `${todos.filter((t) => t.status === 'completed').length} of ${todos.length} done`;
}

/**
 * A reply's checklist (spec 2026-10-12-thread-cards-design §7): open while
 * the reply streams, folded to its one-line count once it ends. Status words
 * are in each step's accessible name, not only in the marks.
 */
export function TodoChecklist({ todos, streaming }: { todos: readonly TodoItem[]; streaming: boolean }): JSX.Element {
  const shown = todos.slice(0, TODO_SHOWN_MAX);
  return (
    <details data-testid="todo-checklist" open={streaming} className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-[var(--text-muted)] select-none">Progress · {todoCounts(todos)}</summary>
      <ul aria-label="Progress" className="mt-1 space-y-0.5">
        {shown.map((t, i) => (
          <li key={i} data-status={t.status} aria-label={`${WORD[t.status]}: ${t.content}`} className={`flex items-start gap-1.5 ${t.status === 'completed' ? 'text-[var(--text-muted)]' : ''}`}>
            <span aria-hidden="true" className="w-3 shrink-0 text-center">{MARK[t.status]}</span>
            <span aria-hidden="true" className={t.status === 'in_progress' ? 'font-medium' : ''}>{t.status === 'in_progress' ? t.activeForm : t.content}</span>
          </li>
        ))}
        {todos.length > shown.length && <li className="text-[var(--text-muted)]">and {todos.length - shown.length} more</li>}
      </ul>
    </details>
  );
}
