import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let desktop = false;
vi.mock('../desktop/bridge.js', () => ({ isDesktop: () => desktop }));
vi.mock('./settings/ConnectionsPanel.js', () => ({ ConnectionsPanel: () => <div>connections</div> }));
vi.mock('./settings/ModelsPanel.js', () => ({ ModelsPanel: () => <div>models</div> }));
vi.mock('./settings/ProfilesPanel.js', () => ({ ProfilesPanel: () => <div>profiles</div> }));
vi.mock('./settings/ProjectsPanel.js', () => ({ ProjectsPanel: () => <div>projects panel</div> }));
vi.mock('./settings/McpServersPanel.js', () => ({ McpServersPanel: () => <div>mcp</div> }));
vi.mock('./settings/DesktopPanel.js', () => ({ DesktopPanel: () => <div>desktop panel</div> }));

import { SettingsView } from './SettingsView.js';

afterEach(() => {
  cleanup();
  desktop = false;
});

describe('SettingsView', () => {
  it('has a Projects tab after Profiles that shows the projects settings', () => {
    render(<SettingsView onClose={vi.fn()} />);
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names.indexOf('Projects')).toBe(names.indexOf('Profiles') + 1);

    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(screen.getByText('projects panel')).toBeInTheDocument();
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
