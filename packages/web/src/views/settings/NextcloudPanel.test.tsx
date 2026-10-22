import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { nextcloud: { get: vi.fn(), put: vi.fn(), test: vi.fn() } } };
});

import { ApiError, api } from '../../state/api.js';
import { NextcloudPanel } from './NextcloudPanel.js';

const nc = vi.mocked(api.nextcloud);
const SAVED = { baseUrl: 'https://cloud.example.com', user: 'adam', passwordSet: true };

beforeEach(() => {
  for (const fn of Object.values(nc)) fn.mockReset();
  nc.get.mockResolvedValue(SAVED);
  nc.put.mockResolvedValue(SAVED);
});
afterEach(cleanup);

describe('NextcloudPanel', () => {
  it('shows saved values and never pre-fills the password', async () => {
    render(<NextcloudPanel />);
    expect(await screen.findByDisplayValue('https://cloud.example.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('adam')).toBeInTheDocument();
    expect(screen.getByLabelText('App password')).toHaveValue('');
    expect(screen.getByLabelText('App password')).toHaveAttribute('type', 'password');
    expect(screen.getByText('A password is currently set.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Clear password' })).toBeInTheDocument();
  });

  it('Save leaves the password out unless typed', async () => {
    const user = userEvent.setup();
    render(<NextcloudPanel />);
    await screen.findByDisplayValue('adam');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(nc.put).toHaveBeenLastCalledWith({ baseUrl: 'https://cloud.example.com', user: 'adam' });
    await user.type(screen.getByLabelText('App password'), 'abc-123');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(nc.put).toHaveBeenLastCalledWith({ baseUrl: 'https://cloud.example.com', user: 'adam', password: 'abc-123' });
    expect(screen.getByLabelText('App password')).toHaveValue('');
  });

  it('Clear password sends null', async () => {
    const user = userEvent.setup();
    render(<NextcloudPanel />);
    await screen.findByDisplayValue('adam');
    await user.click(screen.getByRole('checkbox', { name: 'Clear password' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(nc.put).toHaveBeenLastCalledWith({ baseUrl: 'https://cloud.example.com', user: 'adam', password: null });
  });

  it('Test shows the result per app', async () => {
    nc.test.mockResolvedValue({ ok: true, message: 'Connected as adam.', apps: { deck: true, collectives: true, bookmarks: false } });
    const user = userEvent.setup();
    render(<NextcloudPanel />);
    await screen.findByDisplayValue('adam');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Connected as adam.')).toBeInTheDocument();
    expect(screen.getByTestId('nextcloud-apps')).toHaveTextContent('Deck ✓ / Collectives ✓ / Bookmarks ✗');
  });

  it('a 400 for an http URL shows the server message', async () => {
    nc.put.mockRejectedValue(new ApiError(400, 'The server address must start with https://.'));
    const user = userEvent.setup();
    render(<NextcloudPanel />);
    const url = await screen.findByDisplayValue('https://cloud.example.com');
    await user.clear(url);
    await user.type(url, 'http://cloud.example.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The server address must start with https://.')).toBeInTheDocument();
  });
});
