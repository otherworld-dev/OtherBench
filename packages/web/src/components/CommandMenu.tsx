import type { JSX } from 'react';
import type { CommandRow } from '@otherbench/core/domain/context-lines.js';

/** Case-insensitive: names or aliases starting with `query` first, then names containing it; input order within each group. */
export function filterCommands(commands: CommandRow[], query: string): CommandRow[] {
  const q = query.toLowerCase();
  const names = (c: CommandRow): string[] => [c.name, ...c.aliases].map((n) => n.toLowerCase());
  const prefix = commands.filter((c) => names(c).some((n) => n.startsWith(q)));
  const rest = commands.filter((c) => !prefix.includes(c) && c.name.toLowerCase().includes(q));
  return [...prefix, ...rest];
}

export function commandOptionId(id: string, name: string): string {
  return `${id}-opt-${name}`;
}

export interface CommandMenuProps {
  commands: CommandRow[];
  query: string;
  activeIndex: number;
  onPick: (command: CommandRow) => void;
  id: string;
  warning?: string | null;
}

export function CommandMenu({ commands, query, activeIndex, onPick, id, warning = null }: CommandMenuProps): JSX.Element | null {
  const shown = filterCommands(commands, query);
  if (shown.length === 0) return null;
  return (
    <ul id={id} role="listbox" aria-label="Commands" className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-80 max-w-full overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg">
      {shown.map((c, i) => (
        <li
          key={c.name}
          id={commandOptionId(id, c.name)}
          role="option"
          aria-selected={i === activeIndex}
          // mousedown, so the box keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          className={`cursor-pointer px-3 py-1.5 text-sm ${i === activeIndex ? 'bg-[var(--bg-sunken)]' : 'hover:bg-[var(--bg-sunken)]'}`}
        >
          <span className="font-mono">/{c.name}</span>
          {c.argumentHint && <span className="ml-1 font-mono text-[var(--text-faint)]">{c.argumentHint}</span>}
          {c.description && <span className="block truncate text-xs text-[var(--text-muted)]">{c.description}</span>}
        </li>
      ))}
      {warning && (
        <li role="presentation" className="px-3 py-1 text-xs text-[var(--text-faint)]">
          {warning}
        </li>
      )}
    </ul>
  );
}
