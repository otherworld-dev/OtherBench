import { useState, type JSX } from 'react';
import { isDesktop } from '../desktop/bridge.js';
import { ConnectionsPanel } from './settings/ConnectionsPanel.js';
import { AppearancePanel } from './settings/AppearancePanel.js';
import { DesktopPanel } from './settings/DesktopPanel.js';
import { LocationsPanel } from './settings/LocationsPanel.js';
import { MachinesPanel } from './settings/MachinesPanel.js';
import { McpServersPanel } from './settings/McpServersPanel.js';
import { ModelsPanel } from './settings/ModelsPanel.js';
import { ProfilesPanel } from './settings/ProfilesPanel.js';
import { ProjectsPanel } from './settings/ProjectsPanel.js';

type Tab = 'connections' | 'models' | 'profiles' | 'projects' | 'locations' | 'machines' | 'mcpServers' | 'appearance' | 'desktop';

const TAB_LABEL: Record<Tab, string> = {
  connections: 'Connections',
  models: 'Models',
  profiles: 'Profiles',
  projects: 'Projects',
  locations: 'Locations',
  machines: 'Machines',
  mcpServers: 'MCP Servers',
  appearance: 'Appearance',
  desktop: 'Desktop',
};

export interface SettingsViewProps {
  onClose: () => void;
}

/**
 * Full-screen overlay housing the settings panels (Connections, Models,
 * Profiles, MCP Servers) -- before this, every connection/model/profile/MCP
 * server had to be created with `curl` against the REST API, the single
 * biggest usability gap in the product. Deliberately a sibling of
 * `UsageView`: same full-screen overlay shell, same tab-strip-in-header
 * pattern, same "click a header button in App.tsx" entry point -- so
 * switching between the two while working feels like the same surface, not
 * two different apps bolted together.
 */
export function SettingsView({ onClose }: SettingsViewProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('connections');
  // The Desktop tab only exists inside the desktop app.
  const tabs = (Object.keys(TAB_LABEL) as Tab[]).filter((t) => t !== 'desktop' || isDesktop());

  return (
    <div data-testid="settings-view" className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold">Settings</h2>
          <div role="tablist" className="flex gap-1">
            {tabs.map((t) => (
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
        {tab === 'projects' && <ProjectsPanel />}
        {tab === 'locations' && <LocationsPanel />}
        {tab === 'machines' && <MachinesPanel />}
        {tab === 'mcpServers' && <McpServersPanel />}
        {tab === 'appearance' && <AppearancePanel />}
        {tab === 'desktop' && <DesktopPanel />}
      </div>
    </div>
  );
}
