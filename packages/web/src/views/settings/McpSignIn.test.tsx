import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@grunt/core/ports/store.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';

vi.mock('../../desktop/bridge.js', () => ({ openInBrowser: vi.fn(async () => {}) }));
vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: { mcpServers: { list: vi.fn(), signIn: vi.fn(), cancelSignIn: vi.fn(), completeSignIn: vi.fn(), signOut: vi.fn() } },
  };
});

import { openInBrowser } from '../../desktop/bridge.js';
import { ApiError, api } from '../../state/api.js';
import { McpSignIn } from './McpSignIn.js';

const SIGNED_IN_AT = Date.UTC(2026, 9, 12, 12, 0, 0);

function server(over: Partial<McpServer> = {}): McpServer {
  return { id: 'srv-1', name: 'Hosted Docs', transport: 'http', command: null, args: [], envRefs: {}, url: 'https://mcp.example.com/mcp', headerRefs: {}, enabled: true, status: 'ok', toolsCache: null, oauth: null, ...over };
}

function health(auth: Partial<NonNullable<McpServerHealth['auth']>> | null, over: Partial<McpServerHealth> = {}): McpServerHealth {
  return {
    id: 'srv-1',
    name: 'Hosted Docs',
    transport: 'http',
    enabled: true,
    status: 'ok',
    lastError: null,
    toolCount: 0,
    auth: auth === null ? null : { state: 'none', account: null, signedInAt: null, pending: false, error: null, ...auth },
    ...over,
  };
}

const status = () => screen.getByTestId('mcp-sign-in-status');

beforeEach(() => {
  vi.mocked(api.mcpServers.list).mockReset().mockResolvedValue([]);
  vi.mocked(api.mcpServers.signIn).mockReset();
  vi.mocked(api.mcpServers.cancelSignIn).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.mcpServers.completeSignIn).mockReset().mockResolvedValue({ signedIn: true });
  vi.mocked(api.mcpServers.signOut).mockReset().mockResolvedValue(undefined);
  vi.mocked(openInBrowser).mockClear();
});
afterEach(cleanup);

describe('McpSignIn', () => {
  it('a fixed Authorization header: says so and offers nothing', () => {
    render(<McpSignIn server={server({ headerRefs: { authorization: 'ref' } })} health={health(null)} onChanged={vi.fn()} />);
    expect(status()).toHaveTextContent('Signs in with a fixed Authorization header. Remove the header to sign in with a browser instead.');
    expect(within(screen.getByTestId('mcp-sign-in')).queryByRole('button')).toBeNull();
  });

  it('none and needs_sign_in offer Sign in…', () => {
    const { rerender } = render(<McpSignIn server={server()} health={health({ state: 'none' })} onChanged={vi.fn()} />);
    expect(status()).toHaveTextContent("This server hasn't asked for a sign-in.");
    expect(screen.getByRole('button', { name: 'Sign in…' })).toBeInTheDocument();
    rerender(<McpSignIn server={server()} health={health({ state: 'needs_sign_in' }, { status: 'needs_auth' })} onChanged={vi.fn()} />);
    expect(status()).toHaveTextContent('This server needs you to sign in.');
  });

  it('signed in: names the account and date, with Sign in again and Sign out', () => {
    const { rerender } = render(<McpSignIn server={server()} health={health({ state: 'signed_in', account: 'alice@example.com', signedInAt: SIGNED_IN_AT })} onChanged={vi.fn()} />);
    expect(status()).toHaveTextContent('Signed in as alice@example.com since 12 Oct 2026.');
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    rerender(<McpSignIn server={server()} health={health({ state: 'signed_in', signedInAt: SIGNED_IN_AT })} onChanged={vi.fn()} />);
    expect(status()).toHaveTextContent('Signed in since 12 Oct 2026.');
  });

  it('pending: the browser prompt, the paste-back box, and Cancel / Finish sign-in', () => {
    render(<McpSignIn server={server()} health={health({ state: 'needs_sign_in', pending: true })} onChanged={vi.fn()} />);
    expect(status()).toHaveTextContent("Finish signing in in your browser. This page updates when you're done.");
    expect(screen.getByText(/Signing in on another device\?/)).toBeInTheDocument();
    expect(screen.getByLabelText('Address the sign-in ended on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish sign-in' })).toBeInTheDocument();
  });

  it('shows the last sign-in error in red', () => {
    render(<McpSignIn server={server()} health={health({ state: 'needs_sign_in', error: 'The sign-in provider said: access_denied' })} onChanged={vi.fn()} />);
    expect(screen.getByText('The sign-in provider said: access_denied')).toHaveClass('text-[var(--danger)]');
  });

  it('Sign in… starts the sign-in, opens the page, and shows the pending state with a link to open it again', async () => {
    vi.mocked(api.mcpServers.signIn).mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize?x=1' });
    const user = userEvent.setup();
    render(<McpSignIn server={server()} health={health({ state: 'needs_sign_in' })} onChanged={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Sign in…' }));
    expect(api.mcpServers.signIn).toHaveBeenCalledWith('srv-1');
    expect(openInBrowser).toHaveBeenCalledWith('https://auth.example.com/authorize?x=1');
    expect(await screen.findByText("Finish signing in in your browser. This page updates when you're done.")).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open the sign-in page' }));
    expect(openInBrowser).toHaveBeenCalledTimes(2);
  });

  it('shows why a sign-in could not start', async () => {
    vi.mocked(api.mcpServers.signIn).mockRejectedValue(new ApiError(409, "This server didn't ask for a sign-in."));
    const user = userEvent.setup();
    render(<McpSignIn server={server()} health={health({ state: 'none' })} onChanged={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Sign in…' }));
    expect(await screen.findByText("This server didn't ask for a sign-in.")).toBeInTheDocument();
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('Cancel and Finish sign-in call their routes and report the change', async () => {
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<McpSignIn server={server()} health={health({ state: 'needs_sign_in', pending: true })} onChanged={onChanged} />);

    await user.type(screen.getByLabelText('Address the sign-in ended on'), 'http://127.0.0.1:4747/oauth/callback?state=s&code=c');
    await user.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    expect(api.mcpServers.completeSignIn).toHaveBeenCalledWith('srv-1', 'http://127.0.0.1:4747/oauth/callback?state=s&code=c');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    expect(api.mcpServers.cancelSignIn).toHaveBeenCalledWith('srv-1');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it('Sign out asks first, and only signs out on yes', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<McpSignIn server={server()} health={health({ state: 'signed_in', signedInAt: SIGNED_IN_AT })} onChanged={onChanged} />);

    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(confirm).toHaveBeenCalledWith('Grunt will forget this sign-in. The provider still lists Grunt as allowed until you remove it there.');
    expect(api.mcpServers.signOut).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(api.mcpServers.signOut).toHaveBeenCalledWith('srv-1');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it('while pending, checks every second and reports the change once the sign-in has ended', async () => {
    vi.mocked(api.mcpServers.list).mockResolvedValue([health({ state: 'signed_in', signedInAt: SIGNED_IN_AT, pending: false })]);
    const onChanged = vi.fn();
    render(<McpSignIn server={server()} health={health({ state: 'needs_sign_in', pending: true })} onChanged={onChanged} />);
    await waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 3000 });
  });
});
