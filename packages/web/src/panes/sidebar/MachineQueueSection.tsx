import type { JSX, ReactNode } from 'react';

interface MachineQueueSectionProps {
  machineKey: string;
  name: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** The chats' rows, rendered only while open. */
  children: ReactNode;
}

/**
 * Another machine's chats in the Needs you list: a heading with its name and count, closed until the user opens it,
 * so that machine's work is known about without crowding out this one's.
 */
export function MachineQueueSection({ machineKey, name, count, open, onToggle, children }: MachineQueueSectionProps): JSX.Element {
  const listId = `needs-you-machine-list-${machineKey}`;
  return (
    <div data-testid={`needs-you-machine-${machineKey}`}>
      <h3>
        <button
          type="button"
          data-testid={`needs-you-machine-heading-${machineKey}`}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          title={`${count} ${count === 1 ? 'chat needs' : 'chats need'} you on ${name}`}
          onClick={onToggle}
          className="flex w-full items-center gap-1 rounded-sm py-[3px] pr-2 pl-2 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="truncate">{name}</span>
          <span className="ml-auto font-normal tabular-nums">{count}</span>
        </button>
      </h3>
      {open && <ul id={listId}>{children}</ul>}
    </div>
  );
}
