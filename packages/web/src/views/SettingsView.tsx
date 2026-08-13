import { useState, type JSX } from 'react';
import { ConnectionsPanel } from './settings/ConnectionsPanel.js';
import { ModelsPanel } from './settings/ModelsPanel.js';
import { ProfilesPanel } from './settings/ProfilesPanel.js';

type Tab = 'connections' | 'models' | 'profiles';

const TAB_LABEL: Record<Tab, string> = {
  connections: 'Connections',
  models: 'Models',
  profiles: 'Profiles',
};

export interface SettingsViewProps {
  onClose: () => void;
}

/**
 * Full-screen overlay housing the three settings panels (Connections,
 * Models, Profiles) -- before this, every connection/model/profile had to
 * be created with `curl` against the REST API, the single biggest
 * usability gap in the product. Deliberately a sibling of `UsageView`:
 * same full-screen overlay shell, same tab-strip-in-header pattern, same
 * "click a header button in App.tsx" entry point -- so switching between
 * the two while working feels like the same surface, not two different
 * apps bolted together.
 */
export function SettingsView({ onClose }: SettingsViewProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('connections');

  return (
    <div data-testid="settings-view" className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold">Settings</h2>
          <div role="tablist" className="flex gap-1">
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${tab === t ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'hover:bg-[var(--bg-sunken)]'}`}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <button type="button" aria-label="Close settings" onClick={onClose} className="rounded border border-[var(--border)] px-2 py-1 text-xs">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'connections' && <ConnectionsPanel />}
        {tab === 'models' && <ModelsPanel />}
        {tab === 'profiles' && <ProfilesPanel />}
      </div>
    </div>
  );
}
