import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { auth: { status: vi.fn(), login: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(), changePassword: vi.fn() } } };
});

import { api } from '../../state/api.js';
import { useAuthStore } from '../../state/auth.js';
import { RemoteAccessPanel } from './RemoteAccessPanel.js';

const FP = 'AB:CD:EF';

beforeEach(() => {
  useAuthStore.setState({
    ...useAuthStore.getInitialState(),
    status: 'ready',
    mode: 'login',
    info: {
      mode: 'login',
      signedIn: true,
      caDownload: true,
      session: { expiresAt: Date.UTC(2026, 9, 13, 8, 0), remember: false },
      remote: { publicUrls: ['https://grunt.lan:4747', 'https://192.168.1.5:4747'], tls: { mode: 'auto', notAfter: Date.UTC(2028, 11, 20), caFingerprint: FP, names: ['grunt.lan', '192.168.1.5'] }, trustProxies: [] },
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
    expect(screen.getByText('https://grunt.lan:4747')).toBeInTheDocument();
    expect(screen.getByText('https://192.168.1.5:4747')).toBeInTheDocument();
    expect(screen.getByText(FP)).toBeInTheDocument();
    expect(screen.getByText(/grunt\.lan, 192\.168\.1\.5/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Download Grunt's certificate" })).toHaveAttribute('href', '/grunt-ca.crt');
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
});
