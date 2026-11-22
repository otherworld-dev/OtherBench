import { useId, useState, type JSX, type KeyboardEvent } from 'react';
import { Overlay } from '../components/Overlay.js';
import { isDesktop } from '../desktop/bridge.js';
import { useAddons } from '../state/addons.js';
import { useAuthStore } from '../state/auth.js';
import { useOtherBenchStore } from '../state/store.js';
import { useFeatures } from '../state/features.js';
import { ConnectionsPanel } from './settings/ConnectionsPanel.js';
import { ClaudeAccountsPanel } from './settings/ClaudeAccountsPanel.js';
import { AppearancePanel } from './settings/AppearancePanel.js';
import { BrowserNotificationsPanel } from './settings/BrowserNotificationsPanel.js';
import { DesktopPanel } from './settings/DesktopPanel.js';
import { FeaturesPanel } from './settings/FeaturesPanel.js';
import { LocationsPanel } from './settings/LocationsPanel.js';
import { MachinesPanel } from './settings/MachinesPanel.js';
import { McpServersPanel } from './settings/McpServersPanel.js';
import { NextcloudPanel } from './settings/NextcloudPanel.js';
import { ModelsPanel } from './settings/ModelsPanel.js';
import { ProfilesPanel } from './settings/ProfilesPanel.js';
import { MemoryPanel } from './settings/MemoryPanel.js';
import { ImportPanel } from './settings/ImportPanel.js';
import { SandboxPanel } from './settings/SandboxPanel.js';
import { AddonsPanel } from './settings/AddonsPanel.js';
import { RemoteAccessPanel } from './settings/RemoteAccessPanel.js';

type Tab = 'connections' | 'claudeAccounts' | 'models' | 'profiles' | 'memory' | 'locations' | 'machines' | 'mcpServers' | 'features' | 'nextcloud' | 'sandbox' | 'addons' | 'import' | 'appearance' | 'remote' | 'desktop' | 'notifications';

const TAB_LABEL: Record<Tab, string> = {
  connections: 'Connections',
  claudeAccounts: 'Claude accounts',
  models: 'Models',
  profiles: 'Profiles',
  memory: 'Memory',
  locations: 'Locations',
  machines: 'Machines',
  mcpServers: 'MCP Servers',
  features: 'Features',
  nextcloud: 'Nextcloud',
  sandbox: 'Sandbox',
  addons: 'Add-ons',
  import: 'Import',
  appearance: 'Appearance',
  remote: 'Remote access',
  desktop: 'Desktop',
  notifications: 'Notifications',
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
  const signInMode = useAuthStore((s) => s.mode === 'login');
  const nextcloud = useFeatures((s) => s.nextcloud);
  const addons = useAddons();
  // A chat an add-on's page asks for (a job's, say): shown in place of Settings.
  const openChat = (chatId: string): void => {
    useOtherBenchStore.getState().setActiveChatId(chatId);
    onClose();
  };
  // The Desktop tab only exists inside the desktop app, and Notifications (the browser's) only outside it; Remote access
  // only in sign-in mode; Nextcloud only while it's on; Add-ons only on a machine with one installed.
  const desktop = isDesktop();
  const tabs = (Object.keys(TAB_LABEL) as Tab[]).filter(
    (t) => (t !== 'desktop' || desktop) && (t !== 'notifications' || !desktop) && (t !== 'remote' || signInMode) && (t !== 'nextcloud' || nextcloud) && (t !== 'addons' || addons.length > 0)
  );

  const ids = useId();
  /** Left and Right step through the tabs (round the ends), Home and End go to the first and last; the tab reached is shown. */
  function onTabKey(e: KeyboardEvent<HTMLDivElement>): void {
    const at = tabs.indexOf(tab);
    const to =
      e.key === 'ArrowRight' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    const next = tabs[to];
    if (next === undefined) return;
    e.preventDefault();
    setTab(next);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  }

  return (
    <Overlay label="Settings" testId="settings-view" onEscape={onClose}>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        {/* The tabs wrap rather than push ✕ off the screen in a narrow window or at a large text size. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <h2 className="label-caps text-base">Settings</h2>
          <div role="tablist" aria-label="Settings sections" onKeyDown={onTabKey} className="flex flex-wrap gap-1">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`${ids}-tab-${t}`}
                aria-controls={`${ids}-panel`}
                aria-selected={tab === t}
                // One Tab stop for the list: the arrow keys move within it. Focus starts here when Settings opens.
                tabIndex={tab === t ? 0 : -1}
                {...(tab === t ? { 'data-autofocus': '' } : {})}
                onClick={() => setTab(t)}
                className={`label-caps rounded-sm px-2.5 py-1 ${tab === t ? 'text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]'}`}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <button type="button" aria-label="Close settings" onClick={onClose} className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-xs">
          ✕
        </button>
      </div>

      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`} className="flex-1 overflow-y-auto p-4">
        {tab === 'connections' && <ConnectionsPanel />}
        {tab === 'claudeAccounts' && <ClaudeAccountsPanel />}
        {tab === 'models' && <ModelsPanel />}
        {tab === 'profiles' && <ProfilesPanel />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'locations' && <LocationsPanel />}
        {tab === 'machines' && <MachinesPanel />}
        {tab === 'mcpServers' && <McpServersPanel />}
        {tab === 'features' && <FeaturesPanel />}
        {tab === 'nextcloud' && nextcloud && <NextcloudPanel />}
        {tab === 'sandbox' && <SandboxPanel />}
        {tab === 'addons' && <AddonsPanel addons={addons} onOpenChat={openChat} />}
        {tab === 'import' && <ImportPanel />}
        {tab === 'appearance' && <AppearancePanel />}
        {tab === 'remote' && <RemoteAccessPanel />}
        {tab === 'desktop' && <DesktopPanel />}
        {tab === 'notifications' && <BrowserNotificationsPanel />}
      </div>
    </Overlay>
  );
}
