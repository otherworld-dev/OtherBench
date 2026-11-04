import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { auth: { status: vi.fn(), login: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(), changePassword: vi.fn(), sessions: vi.fn(), endSession: vi.fn() } } };
});

import { api, ApiError, type SignedInDevice } from '../../state/api.js';
import { useAuthStore } from '../../state/auth.js';
import { RemoteAccessPanel } from './RemoteAccessPanel.js';

const FP = 'AB:CD:EF';

const PHONE: SignedInDevice = { id: 'p1', deviceLabel: 'Chrome on Android', address: '192.0.2.10', createdAt: Date.UTC(2026, 9, 12, 9, 0), lastSeenAt: Date.UTC(2026, 9, 13, 7, 30), expiresAt: Date.UTC(2026, 10, 11), remember: true, current: false };
const LAPTOP: SignedInDevice = { id: 'l1', deviceLabel: 'Firefox on Windows', address: '192.0.2.11', createdAt: Date.UTC(2026, 9, 12, 20, 0), lastSeenAt: Date.UTC(2026, 9, 13, 7, 59), expiresAt: Date.UTC(2026, 9, 13, 8, 0), remember: false, current: true };

beforeEach(() => {
  vi.mocked(api.auth.sessions).mockResolvedValue({ sessions: [LAPTOP, PHONE] });
  useAuthStore.setState({
    ...useAuthStore.getInitialState(),
    status: 'ready',
    mode: 'login',
    info: {
      mode: 'login',
      signedIn: true,
      caDownload: true,
      session: { expiresAt: Date.UTC(2026, 9, 13, 8, 0), remember: false },
      remote: { publicUrls: ['https://otherbench.lan:4747', 'https://192.168.1.5:4747'], tls: { mode: 'auto', notAfter: Date.UTC(2028, 11, 20), caFingerprint: FP, names: ['otherbench.lan', '192.168.1.5'] }, trustProxies: [] },
    },
  }, true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RemoteAccessPanel', () => {
  it('shows the session, the public URLs and the certificate', () => {
    render(<RemoteAccessPanel />);

    expect(screen.getByText(/^Signed in until /)).toBeInTheDocument();
    expect(screen.getByText('https://otherbench.lan:4747')).toBeInTheDocument();
    expect(screen.getByText('https://192.168.1.5:4747')).toBeInTheDocument();
    expect(screen.getByText(FP)).toBeInTheDocument();
    expect(screen.getByText(/otherbench\.lan, 192\.168\.1\.5/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Download OtherBench's certificate" })).toHaveAttribute('href', '/otherbench-ca.crt');
  });

  it('names the trusted proxies behind a proxy', () => {
    useAuthStore.setState({ info: { mode: 'login', signedIn: true, remote: { publicUrls: ['https://box.tail.ts.net'], tls: { mode: 'proxy' }, trustProxies: ['127.0.0.1'] } } });
    render(<RemoteAccessPanel />);

    expect(screen.getByText(/HTTPS proxy/)).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
  });

  it('signs out everywhere', async () => {
    vi.mocked(api.auth.logoutAll).mockResolvedValueOnce(undefined);
    render(<RemoteAccessPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));

    await vi.waitFor(() => expect(useAuthStore.getState().status).toBe('signed-out'));
    expect(api.auth.logoutAll).toHaveBeenCalledTimes(1);
  });

  it('lists the signed-in devices, marking this one', async () => {
    render(<RemoteAccessPanel />);

    const list = await screen.findByRole('list', { name: 'Signed-in devices' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Firefox on Windows');
    expect(rows[0]).toHaveTextContent('This device');
    expect(rows[0]).toHaveTextContent('192.0.2.11');
    expect(rows[1]).toHaveTextContent('Chrome on Android');
    expect(rows[1]).not.toHaveTextContent('This device');
    expect(rows[1]).toHaveTextContent(/Signed in .* · Last seen /);
  });

  it('signs another device out and lists again', async () => {
    vi.mocked(api.auth.endSession).mockResolvedValueOnce(undefined);
    render(<RemoteAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Chrome on Android' }));

    await vi.waitFor(() => expect(api.auth.sessions).toHaveBeenCalledTimes(2));
    expect(api.auth.endSession).toHaveBeenCalledWith('p1');
    expect(useAuthStore.getState().status).toBe('ready');
  });

  it('takes "already signed out" as done', async () => {
    vi.mocked(api.auth.endSession).mockRejectedValueOnce(new ApiError(404, 'That device is already signed out.'));
    render(<RemoteAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Chrome on Android' }));

    await vi.waitFor(() => expect(api.auth.sessions).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("signs this device out with the ordinary Sign out", async () => {
    vi.mocked(api.auth.logout).mockResolvedValueOnce(undefined);
    render(<RemoteAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Firefox on Windows (this device)' }));

    await vi.waitFor(() => expect(useAuthStore.getState().status).toBe('signed-out'));
    expect(api.auth.logout).toHaveBeenCalledTimes(1);
    expect(api.auth.endSession).not.toHaveBeenCalled();
  });
});
