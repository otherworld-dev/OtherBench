import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { TerminalInfo } from '@otherbench/core/types/terminal.js';

vi.mock('./TerminalView.js', () => ({
  TerminalView: ({ terminal, focusToken }: { terminal: TerminalInfo; focusToken: number }) => (
    <div data-testid="terminal-view" data-focus={focusToken}>
      {terminal.id}
    </div>
  ),
}));
vi.mock('./status.js', () => ({
  useTerminalStatus: () => ({
    available: true,
    shells: [
      { id: 'pwsh', label: 'PowerShell 7', default: true },
      { id: 'git-bash', label: 'Git Bash', default: false },
    ],
  }),
}));

import { api, ApiError } from '../../state/api.js';
import { useOtherBenchStore } from '../../state/store.js';
import { TerminalTab } from './TerminalTab.js';

const app: App = { id: 'a1', name: 'App', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
const term = (id: string, over: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, appId: 'a1', name: id, shellId: 'pwsh', exitCode: null, createdAt: 1, ...over });

let list: TerminalInfo[];
beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  list = [];
  vi.spyOn(api.terminals, 'list').mockImplementation(async () => list.map((t) => ({ ...t })));
  vi.spyOn(api.terminals, 'create').mockImplementation(async (_appId, body) => {
    const t = term(`t${list.length + 1}`, { shellId: body.shell ?? 'pwsh' });
    list.push(t);
    return t;
  });
  vi.spyOn(api.terminals, 'kill').mockImplementation(async (_appId, id) => {
    list = list.filter((t) => t.id !== id);
  });
  vi.spyOn(api.terminals, 'rename').mockImplementation(async (_appId, id, name) => {
    const t = list.find((x) => x.id === id)!;
    t.name = name;
    return t;
  });
  vi.spyOn(api.terminals, 'restart').mockImplementation(async (_appId, id) => {
    const t = list.find((x) => x.id === id)!;
    t.exitCode = null;
    return t;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const view = (): HTMLElement => screen.getByTestId('terminal-view');

describe('TerminalTab', () => {
  it('opening with no terminals starts one in the default shell', async () => {
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t1'));
    expect(api.terminals.create).toHaveBeenCalledTimes(1);
    expect(api.terminals.create).toHaveBeenCalledWith('a1', { cols: 80, rows: 24 });
  });

  it('lists, switches and kills, mounting only the selected one', async () => {
    list = [term('t1', { name: 'pwsh' }), term('t2', { name: 'dev' })];
    const user = userEvent.setup();
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t1'));
    expect(api.terminals.create).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('terminal-view')).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: 'dev' }));
    expect(view()).toHaveTextContent('t2');
    await user.click(screen.getByRole('button', { name: 'Close dev' }));
    await waitFor(() => expect(view()).toHaveTextContent('t1'));
    expect(api.terminals.kill).toHaveBeenCalledWith('a1', 't2');
    expect(screen.queryByRole('tab', { name: 'dev' })).not.toBeInTheDocument();
  });

  it('remembers the selected terminal per app', async () => {
    list = [term('t1'), term('t2')];
    const user = userEvent.setup();
    const first = render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t1'));
    await user.click(screen.getByRole('tab', { name: 't2' }));
    first.unmount();
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t2'));
  });

  it('+ opens another in the default shell; the menu offers the detected shells', async () => {
    list = [term('t1')];
    const user = userEvent.setup();
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t1'));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(view()).toHaveTextContent('t2'));
    await user.click(screen.getByRole('button', { name: 'Choose a shell' }));
    await user.click(screen.getByRole('menuitem', { name: 'Git Bash' }));
    await waitFor(() => expect(view()).toHaveTextContent('t3'));
    expect(api.terminals.create).toHaveBeenLastCalledWith('a1', { shell: 'git-bash', cols: 80, rows: 24 });
  });

  it('rename by double-click; Escape cancels', async () => {
    list = [term('t1', { name: 'pwsh' })];
    const user = userEvent.setup();
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t1'));
    await user.dblClick(screen.getByRole('tab', { name: 'pwsh' }));
    const box = screen.getByRole('textbox', { name: 'Terminal name' });
    await user.clear(box);
    await user.type(box, 'server{Enter}');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'server' })).toBeInTheDocument());
    expect(api.terminals.rename).toHaveBeenCalledWith('a1', 't1', 'server');
    await user.dblClick(screen.getByRole('tab', { name: 'server' }));
    await user.type(screen.getByRole('textbox', { name: 'Terminal name' }), 'x{Escape}');
    expect(screen.getByRole('tab', { name: 'server' })).toBeInTheDocument();
    expect(api.terminals.rename).toHaveBeenCalledTimes(1);
  });

  it('shows the exited state, and Restart starts it again', async () => {
    list = [term('t1', { exitCode: 3 })];
    const user = userEvent.setup();
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(screen.getByTestId('terminal-exited')).toHaveTextContent('Process exited with code 3'));
    await user.click(screen.getByRole('button', { name: 'Restart' }));
    expect(api.terminals.restart).toHaveBeenCalledWith('a1', 't1');
    await waitFor(() => expect(screen.queryByTestId('terminal-exited')).not.toBeInTheDocument());
  });

  it('not on this machine: says so and + is off', async () => {
    vi.mocked(api.terminals.create).mockRejectedValue(new ApiError(409, "This app's folder isn't on this machine.", undefined, { code: 'not-on-this-machine' }));
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("This app's folder isn't on this machine"));
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
    expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();
  });

  it('the limit says why', async () => {
    list = [term('t1')];
    const user = userEvent.setup();
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toBeInTheDocument());
    vi.mocked(api.terminals.create).mockRejectedValueOnce(new ApiError(409, 'An app can have at most 10 terminals. Close one first.', undefined, { code: 'terminal-limit' }));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('at most 10 terminals'));
    expect(view()).toHaveTextContent('t1');
  });

  it('refetches on terminals-changed for its app only', async () => {
    list = [term('t1')];
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toBeInTheDocument());
    const calls = vi.mocked(api.terminals.list).mock.calls.length;
    act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'terminals-changed', appId: 'other' }));
    expect(api.terminals.list).toHaveBeenCalledTimes(calls);
    list.push(term('t2', { name: 'elsewhere' }));
    act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'terminals-changed', appId: 'a1' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'elsewhere' })).toBeInTheDocument());
  });

  it('Ctrl+` focuses the terminal, Ctrl+Shift+` opens another', async () => {
    list = [term('t1')];
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toBeInTheDocument());
    const before = Number(view().dataset['focus']);
    act(() => useOtherBenchStore.getState().requestTerminal('focus'));
    await waitFor(() => expect(Number(view().dataset['focus'])).toBeGreaterThan(before));
    act(() => useOtherBenchStore.getState().requestTerminal('new'));
    await waitFor(() => expect(view()).toHaveTextContent('t2'));
  });

  it('a Ctrl+Shift+` pressed before the tab was showing still opens a new terminal when it shows', async () => {
    list = [term('t1')];
    useOtherBenchStore.getState().requestTerminal('new');
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t2'));
    expect(api.terminals.create).toHaveBeenCalledTimes(1);
    expect(useOtherBenchStore.getState().terminalRequest).toBeNull();
  });

  it('a waiting request on an app with no terminals starts just one', async () => {
    useOtherBenchStore.getState().requestTerminal('new');
    render(<TerminalTab app={app} />);
    await waitFor(() => expect(view()).toHaveTextContent('t1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.terminals.create).toHaveBeenCalledTimes(1);
  });

  it("the exited bar sits below the screen, so it doesn't cover the last lines", async () => {
    list = [term('t1', { exitCode: 1 })];
    render(<TerminalTab app={app} />);
    const bar = await screen.findByTestId('terminal-exited');
    expect(view().parentElement?.contains(bar)).toBe(false);
  });
});

