/** What a Deck column's title means, so "In Progress" and "WIP" count as Doing. */
export type ColumnKind = 'doing' | 'todo' | 'backlog' | 'done' | 'other';

const DOING = new Set(['doing', 'in progress', 'in-progress', 'wip']);
const TODO = new Set(['to do', 'todo', 'to-do']);

export function columnKind(title: string): ColumnKind {
  const t = title.trim().toLowerCase();
  if (DOING.has(t)) return 'doing';
  if (TODO.has(t)) return 'todo';
  if (t === 'backlog') return 'backlog';
  if (t === 'done') return 'done';
  return 'other';
}
