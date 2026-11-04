import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
