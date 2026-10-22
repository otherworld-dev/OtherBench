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
vi.mock('./settings/RemoteAccessPanel.js', () => ({ RemoteAccessPanel: () => <div>remote panel</div> }));

import { useAuthStore } from '../state/auth.js';
import { SettingsView } from './SettingsView.js';

afterEach(() => {
  cleanup();
  desktop = false;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
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

  it('has a Sandbox tab after MCP Servers that shows the sandbox panel', () => {
    render(<SettingsView onClose={vi.fn()} />);
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names.indexOf('Nextcloud')).toBe(names.indexOf('MCP Servers') + 1);
    expect(names.indexOf('Sandbox')).toBe(names.indexOf('Nextcloud') + 1);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    expect(screen.getByText('sandbox panel')).toBeInTheDocument();
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

  it('has no Desktop tab in a browser', () => {
    render(<SettingsView onClose={vi.fn()} />);

    expect(screen.queryByRole('tab', { name: 'Desktop' })).toBeNull();
  });

  it('has a Desktop tab inside the desktop app', () => {
    desktop = true;

    render(<SettingsView onClose={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Desktop' })).toBeInTheDocument();
  });
});
