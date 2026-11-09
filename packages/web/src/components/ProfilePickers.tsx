import type { Dispatch, JSX, SetStateAction } from 'react';
import type { Connection, Profile } from '@otherbench/core/types/config.js';

/** True when the profile runs through Claude Code (its own tools, needs a workspace) rather than OtherBench's tool layer. */
export function isClaudeCodeProfile(profile: Profile, connections: Connection[]): boolean {
  return connections.find((c) => c.id === profile.connectionId)?.kind === 'claude_code';
}

export interface ProfilePickerProps {
  profiles: Profile[];
  connections: Connection[];
  primaryProfile: Profile | null;
  selectedProfileIds: string[];
  pickerOpen: boolean;
  setPickerOpen: Dispatch<SetStateAction<boolean>>;
  choosePrimaryProfile: (profileId: string) => Promise<void>;
}

/** The composer toolbar's profile chip and its list: which profile the next message goes to. */
export function ProfilePicker({ profiles, connections, primaryProfile, selectedProfileIds, pickerOpen, setPickerOpen, choosePrimaryProfile }: ProfilePickerProps): JSX.Element {
  return (
    /* Laid out at its least and grown back to the full name, so the name is cut before anything wraps. */
    <div className="relative min-w-14 max-w-max shrink grow basis-14">
      <button
        type="button"
        onClick={() => setPickerOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={pickerOpen}
        title={primaryProfile ? `${primaryProfile.name} · ${primaryProfile.modelId}` : undefined}
        // line-clamp with break-all, not truncate: it looks the same, but the name can shrink to a letter, so the
        // toolbar wraps by its other controls' widths rather than the full name's.
        className="chip max-w-full line-clamp-1 break-all px-2 py-0.5 font-mono text-[0.6875rem] text-[var(--text)]"
      >
        {primaryProfile ? `${primaryProfile.name} · ${primaryProfile.modelId}` : 'Choose a profile'}
      </button>
      {pickerOpen && (
        <ul role="listbox" aria-label="Profile" className="absolute bottom-full z-10 mb-1 w-56 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg">
          {profiles.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={p.id === selectedProfileIds[0]}
                onClick={() => void choosePrimaryProfile(p.id)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-sunken)]"
              >
                {p.name} <span className="text-[var(--text-muted)]">· {p.modelId}</span>
                <span className="label-caps ml-1 text-[0.6875rem] text-[var(--text-faint)]">{isClaudeCodeProfile(p, connections) ? 'CC tools' : 'OtherBench tools'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ComparePickerProps {
  profiles: Profile[];
  comparedProfiles: Profile[];
  selectedProfileIds: string[];
  comparePickerOpen: boolean;
  setComparePickerOpen: Dispatch<SetStateAction<boolean>>;
  togglePickerProfile: (id: string) => void;
}

/** The profiles the next message is compared against, as chips, and the `+` list that picks them. */
export function ComparePicker({ profiles, comparedProfiles, selectedProfileIds, comparePickerOpen, setComparePickerOpen, togglePickerProfile }: ComparePickerProps): JSX.Element {
  return (
    <>
      {comparedProfiles.map((p) => (
        <span key={p.id} className="chip chip-on shrink-0 px-2 py-0.5 font-mono text-[0.6875rem]">
          + {p.name}
        </span>
      ))}

      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setComparePickerOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={comparePickerOpen}
          aria-label="Compare"
          title="Compare against other profiles"
          className="chip chip-add px-2 py-0.5 font-mono text-[0.6875rem]"
        >
          +
        </button>
        {comparePickerOpen && (
          <ul role="listbox" aria-label="Compare profiles" aria-multiselectable="true" className="absolute bottom-full z-10 mb-1 w-56 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg">
            {profiles
              .filter((p) => p.id !== selectedProfileIds[0])
              .map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--bg-sunken)]">
                    <input type="checkbox" checked={selectedProfileIds.includes(p.id)} onChange={() => togglePickerProfile(p.id)} />
                    {p.name}
                  </label>
                </li>
              ))}
          </ul>
        )}
      </div>
    </>
  );
}
