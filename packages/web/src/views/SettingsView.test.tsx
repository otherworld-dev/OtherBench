import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

let desktop = false;
vi.mock('../desktop/bridge.js', () => ({ isDesktop: () => desktop }));
vi.mock('./settings/ConnectionsPanel.js', () => ({ ConnectionsPanel: () => <div>connections</div> }));
vi.mock('./settings/ModelsPanel.js', () => ({ ModelsPanel: () => <div>models</div> }));
vi.mock('./settings/ProfilesPanel.js', () => ({ ProfilesPanel: () => <div>profiles</div> }));
vi.mock('./settings/MemoryPanel.js', () => ({ MemoryPanel: () => <div>memory panel</div> }));
vi.mock('./settings/McpServersPanel.js', () => ({ McpServersPanel: () => <div>mcp</div> }));
vi.mock('./settings/SandboxPanel.js', () => ({ SandboxPanel: () => <div>sandbox panel</div> }));
vi.mock('./settings/DesktopPanel.js', () => ({ DesktopPanel: () => <div>desktop panel</div> }));
vi.mock('./settings/BrowserNotificationsPanel.js', () => ({ BrowserNotificationsPanel: () => <div>browser notifications panel</div> }));
vi.mock('./settings/RemoteAccessPanel.js', () => ({ RemoteAccessPanel: () => <div>remote panel</div> }));
vi.mock('./settings/FeaturesPanel.js', () => ({ FeaturesPanel: () => <div>features panel</div> }));
vi.mock('./settings/NextcloudPanel.js', () => ({ NextcloudPanel: () => <div>nextcloud panel</div> }));
vi.mock('./settings/AddonsPanel.js', () => ({ AddonsPanel: () => <div>addons panel</div> }));
let addons: { id: string; name: string; version: string | null; status: 'loaded' | 'failed'; error: string | null; settingsPage: boolean }[] = [];
vi.mock('../state/addons.js', () => ({ useAddons: () => addons }));

import { useAuthStore } from '../state/auth.js';
import { useFeatures } from '../state/features.js';
import { SettingsView } from './SettingsView.js';

afterEach(() => {
  cleanup();
  desktop = false;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useFeatures.setState({ github: true, nextcloud: true });
});

describe('SettingsView', () => {
  it('is a dialog: named, focus on the chosen tab, and Escape closes it', async () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(screen.getByTestId('settings-view'));
    expect(screen.getByRole('tab', { name: 'Connections' })).toHaveFocus();
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves through its tabs with the arrow keys, Home and End, one tab stop for the list', async () => {
    render(<SettingsView onClose={vi.fn()} />);
    const user = userEvent.setup();
    const tabs = screen.getAllByRole('tab');
    const first = tabs[0]!;
    const last = tabs.at(-1)!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(tabs.filter((t) => t.tabIndex === 0)).toEqual([first]);
    // The panel belongs to its tab.
    expect(screen.getByRole('tabpanel', { name: 'Connections' })).toHaveTextContent('connections');

    await user.keyboard('{ArrowLeft}'); // wraps to the last
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Notifications' })).toHaveTextContent('browser notifications panel');
    expect(screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toEqual([last]);

    await user.keyboard('{ArrowRight}'); // and back round to the first
    expect(first).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Connections' })).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(last).toHaveFocus();
    await user.keyboard('{Home}');
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('has a Memory tab after Profiles that shows the memory settings, and no Projects tab', () => {
    render(<SettingsView onClose={vi.fn()} />);
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names.indexOf('Memory')).toBe(names.indexOf('Profiles') + 1);
    expect(names).not.toContain('Projects');

    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(screen.getByText('memory panel')).toBeInTheDocument();
  });

  it('has Features, Nextcloud and Sandbox tabs after MCP Servers, Sandbox showing the sandbox panel', () => {
    render(<SettingsView onClose={vi.fn()} />);
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names.indexOf('Features')).toBe(names.indexOf('MCP Servers') + 1);
    expect(names.indexOf('Nextcloud')).toBe(names.indexOf('Features') + 1);
    expect(names.indexOf('Sandbox')).toBe(names.indexOf('Nextcloud') + 1);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    expect(screen.getByText('sandbox panel')).toBeInTheDocument();
  });

  it('shows the Features panel, and no Nextcloud tab while Nextcloud is turned off', () => {
    useFeatures.setState({ nextcloud: false });
    render(<SettingsView onClose={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: 'Nextcloud' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Features' }));
    expect(screen.getByText('features panel')).toBeInTheDocument();
  });

  it('has no Add-ons tab when no add-on is installed', () => {
    addons = [];
    render(<SettingsView onClose={vi.fn()} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).not.toContain('Add-ons');
  });

  it('has an Add-ons tab after Sandbox when one is installed, loaded or not', () => {
    addons = [{ id: 'glow', name: 'Glow', version: '1', status: 'failed', error: 'x', settingsPage: false }];
    render(<SettingsView onClose={vi.fn()} />);
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names.indexOf('Add-ons')).toBe(names.indexOf('Sandbox') + 1);
    fireEvent.click(screen.getByRole('tab', { name: 'Add-ons' }));
    expect(screen.getByText('addons panel')).toBeInTheDocument();
    addons = [];
  });

  it('has a Remote access tab only in sign-in mode', () => {
    const { unmount } = render(<SettingsView onClose={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: 'Remote access' })).toBeNull();
    unmount();

    useAuthStore.setState({ mode: 'login' });
    render(<SettingsView onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Remote access' }));
    expect(screen.getByText('remote panel')).toBeInTheDocument();
  });

  it('has no Desktop tab in a browser, but a Notifications tab for browser notifications', () => {
    render(<SettingsView onClose={vi.fn()} />);

    expect(screen.queryByRole('tab', { name: 'Desktop' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }));
    expect(screen.getByText('browser notifications panel')).toBeInTheDocument();
  });

  it('has a Desktop tab inside the desktop app, and no browser Notifications tab', () => {
    desktop = true;

    render(<SettingsView onClose={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Desktop' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Notifications' })).toBeNull();
  });
});
