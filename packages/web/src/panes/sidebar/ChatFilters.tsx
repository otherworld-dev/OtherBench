import type { Dispatch, JSX, SetStateAction } from 'react';
import type { PeersOverview } from '../../state/api.js';

/** A filter chip under the search box, on or off. */
function chipClass(on: boolean): string {
  return `chip px-2 py-0.5 text-xs ${on ? 'chip-on' : ''}`;
}

export interface ChatFiltersProps {
  statusOnly: boolean;
  setStatusOnly: Dispatch<SetStateAction<boolean>>;
  machines: PeersOverview | null;
  machineFilter: string | null;
  setMachine: Dispatch<SetStateAction<string | null>>;
}

/** The chips under the sidebar's search box: only chats with a status, or that run on one machine (with peers paired). */
export function ChatFilters({ statusOnly, setStatusOnly, machines, machineFilter, setMachine }: ChatFiltersProps): JSX.Element {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="chat-filters">
      <button type="button" aria-pressed={statusOnly} onClick={() => setStatusOnly((on) => !on)} className={chipClass(statusOnly)}>
        Needs you / working
      </button>
      {machines && machines.peers.length > 0 && (
        <select
          aria-label="Machine"
          value={machineFilter ?? ''}
          onChange={(e) => setMachine(e.target.value === '' ? null : e.target.value)}
          className={`${chipClass(machineFilter !== null)} bg-[var(--bg-raised)]`}
        >
          <option value="">Any machine</option>
          <option value={machines.self.id}>{machines.self.name} (this machine)</option>
          {machines.peers.map((p) => (
            <option key={p.nodeId} value={p.nodeId}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
