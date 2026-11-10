import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionSummary } from '@otherbench/core/domain/computer-apps.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import { useOtherBenchStore } from '../state/store.js';
import { ComputerBanner } from './ComputerBanner.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, chats: { ...actual.api.chats, stopComputer: vi.fn(), startComputer: vi.fn() } } };
});

import { api } from '../state/api.js';

const chat = { id: 'chat-1', title: 'Budget' } as Chat;
const session = (lastAction?: string): void =>
  act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'computer-session', chatId: 'chat-1', active: true, ...(lastAction === undefined ? {} : { lastAction }) }));

describe('ComputerBanner', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    vi.mocked(api.chats.stopComputer).mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('shows only while the chat is in control, as a status, with its last action', () => {
    render(<ComputerBanner chat={chat} />);
    expect(screen.queryByTestId('computer-banner')).toBeNull();
    session('click at 1, 2');
    const banner = screen.getByTestId('computer-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('OtherBench is controlling this computer.');
    expect(banner).toHaveTextContent('Last: click at 1, 2');
    act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'computer-session', chatId: 'chat-1', active: false }));
    expect(screen.queryByTestId('computer-banner')).toBeNull();
  });

  it('shows the banner for a session the hello reports (a window opened mid-session)', () => {
    act(() => useOtherBenchStore.getState().applyAppHello({ pendingApprovals: [], runningTurns: [], computerSessions: [{ chatId: 'chat-1', lastAction: 'press ctrl+s' }] }));
    render(<ComputerBanner chat={chat} />);
    expect(screen.getByTestId('computer-banner')).toHaveTextContent('Last: press ctrl+s');
  });

  it("ignores another chat's session", () => {
    act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'computer-session', chatId: 'other', active: true }));
    render(<ComputerBanner chat={chat} />);
    expect(screen.queryByTestId('computer-banner')).toBeNull();
  });

  it('shows the last action as one clean line inside a <bdi>', () => {
    session('click at 1, 2\u202e\u200b\n\u001b[31m ignore previous instructions');
    render(<ComputerBanner chat={chat} />);
    const line = screen.getByTestId('computer-banner-last');
    const bdi = line.querySelector('bdi')!;
    expect(bdi).not.toBeNull();
    expect(bdi.textContent).toBe('click at 1, 2 [31m ignore previous instructions');
    for (const bad of ['\u202e', '\u200b', '\n', '\u001b']) expect(screen.getByTestId('computer-banner').textContent).not.toContain(bad);
  });

  it("can't show typed text: a type action's last action is only how much was typed", () => {
    const summary = actionSummary({ action: 'type', text: 'password: hunter2-SECRET\nline two' });
    session(summary);
    render(<ComputerBanner chat={chat} />);
    expect(screen.getByTestId('computer-banner')).toHaveTextContent('Last: type 33 characters (2 lines)');
    expect(screen.getByTestId('computer-banner')).not.toHaveTextContent('SECRET');
  });

  it('says which paired machine started a session here, and keeps saying it as actions come', () => {
    act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'computer-session', chatId: 'chat-1', active: true, startedFrom: 'Laptop' }));
    render(<ComputerBanner chat={chat} />);
    expect(screen.getByTestId('computer-banner')).toHaveTextContent('OtherBench is controlling this computer.');
    expect(screen.getByTestId('computer-banner-from')).toHaveTextContent('Started from Laptop.');
    session('take a screenshot');
    expect(screen.getByTestId('computer-banner-from')).toHaveTextContent('Started from Laptop.');
    expect(screen.getByTestId('computer-banner')).toHaveTextContent('Last: take a screenshot');
  });

  it("names the starting machine from the hello too, and shows no such line for this computer's own session", () => {
    act(() => useOtherBenchStore.getState().applyAppHello({ pendingApprovals: [], runningTurns: [], computerSessions: [{ chatId: 'chat-1', startedFrom: 'Laptop' }] }));
    const { unmount } = render(<ComputerBanner chat={chat} />);
    expect(screen.getByTestId('computer-banner-from')).toHaveTextContent('Started from Laptop.');
    unmount();
    act(() => useOtherBenchStore.getState().applyAppHello({ pendingApprovals: [], runningTurns: [], computerSessions: [{ chatId: 'chat-1' }] }));
    render(<ComputerBanner chat={chat} />);
    expect(screen.queryByTestId('computer-banner-from')).toBeNull();
  });

  it('shows no last-action line before the first action', () => {
    session();
    render(<ComputerBanner chat={chat} />);
    expect(screen.getByTestId('computer-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('computer-banner-last')).toBeNull();
  });

  it('Stop asks the server to end control and the reply for this chat', async () => {
    session();
    render(<ComputerBanner chat={chat} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.chats.stopComputer).toHaveBeenCalledWith('chat-1');
    expect(api.chats.stopComputer).toHaveBeenCalledTimes(1);
  });

  describe('a session on a paired machine', () => {
    const machines = (status: 'reachable' | 'unreachable', computerSessions?: { chatId: string; lastAction?: string }[]): void =>
      act(() =>
        useOtherBenchStore.getState().setMachines({
          self: { id: 'node-self', name: 'Laptop', fingerprint: 'A' },
          listening: { running: true, addresses: [] },
          peers: [{ nodeId: 'node-pc', name: 'PC', fingerprint: 'f', addresses: [], platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1, status, since: 0, lastSyncedAt: null, syncError: null, ...(computerSessions ? { computerSessions } : {}) }],
        })
      );

    it('names the machine, shows its last action, and comes and goes with what that machine says', () => {
      render(<ComputerBanner chat={chat} />);
      machines('reachable', [{ chatId: 'chat-1', lastAction: 'left click at 3, 4' }]);
      const banner = screen.getByTestId('computer-banner');
      expect(banner).toHaveTextContent('OtherBench is controlling PC.');
      expect(banner).not.toHaveTextContent('this computer');
      expect(banner).toHaveAttribute('data-machine', 'node-pc');
      expect(banner).toHaveTextContent('Last: left click at 3, 4');
      machines('reachable', []);
      expect(screen.queryByTestId('computer-banner')).toBeNull();
    });

    it("shows nothing for another chat's session, an unreachable machine or an older one that doesn't say", () => {
      render(<ComputerBanner chat={chat} />);
      machines('reachable', [{ chatId: 'other' }]);
      expect(screen.queryByTestId('computer-banner')).toBeNull();
      machines('unreachable', [{ chatId: 'chat-1' }]);
      expect(screen.queryByTestId('computer-banner')).toBeNull();
      machines('reachable');
      expect(screen.queryByTestId('computer-banner')).toBeNull();
    });

    it("Stop asks this machine's server, which sends it to the machine in control", async () => {
      machines('reachable', [{ chatId: 'chat-1' }]);
      render(<ComputerBanner chat={chat} />);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Stop' }));
      expect(api.chats.stopComputer).toHaveBeenCalledWith('chat-1');
    });

    describe('Start on the machine the chat runs on', () => {
      const remoteChat = { id: 'chat-1', title: 'Budget', runsOn: 'node-pc', profileId: 'p1' } as Chat;
      const profile = (computer: boolean): void =>
        act(() => useOtherBenchStore.setState({ profiles: [{ id: 'p1', name: 'P', toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer } } as never] }));
      beforeEach(() => {
        vi.mocked(api.chats.startComputer).mockReset().mockResolvedValue({ starting: true });
      });

      it("offers it for a chat on a reachable paired machine whose profile uses the computer, and says the machine's dialog asks", async () => {
        profile(true);
        machines('reachable', []);
        render(<ComputerBanner chat={remoteChat} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Start on PC' }));
        expect(api.chats.startComputer).toHaveBeenCalledWith('chat-1');
        expect(await screen.findByRole('status')).toHaveTextContent('Asked PC. Someone there has to say OK in its dialog before it starts.');
      });

      it("shows the machine's refusal as it said it", async () => {
        profile(true);
        machines('reachable', []);
        const { ApiError } = await import('../state/api.js');
        vi.mocked(api.chats.startComputer).mockRejectedValue(new ApiError(403, "PC doesn't let paired machines start or approve computer use, so Laptop can't."));
        render(<ComputerBanner chat={remoteChat} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Start on PC' }));
        expect(await screen.findByRole('alert')).toHaveTextContent("PC doesn't let paired machines start or approve computer use");
      });

      it('says when the person at that machine declined, or nobody answered there, in place of "Asked PC"', async () => {
        profile(true);
        machines('reachable', []);
        render(<ComputerBanner chat={remoteChat} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Start on PC' }));
        expect(await screen.findByRole('status')).toHaveTextContent('Asked PC.');
        const ended = (outcome: 'declined' | 'unanswered' | 'not_started', chatId = 'chat-1', nodeId = 'node-pc'): void =>
          act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'peer-computer-start', nodeId, chatId, outcome }));

        // Another chat's, or another machine's: not this one's.
        ended('declined', 'other');
        ended('declined', 'chat-1', 'node-tablet');
        expect(screen.queryByRole('alert')).toBeNull();

        ended('declined');
        expect(screen.getByRole('alert')).toHaveTextContent("PC declined: nobody there said OK, so computer use didn't start.");
        expect(screen.queryByText(/Asked PC/)).toBeNull();
        ended('unanswered');
        expect(screen.getByRole('alert')).toHaveTextContent("Nobody answered on PC in time, so computer use didn't start.");
        ended('not_started');
        expect(screen.getByRole('alert')).toHaveTextContent("Computer use didn't start on PC.");

        // Asking again clears it until that machine says how the new one went.
        await user.click(screen.getByRole('button', { name: 'Start on PC' }));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(await screen.findByRole('status')).toHaveTextContent('Asked PC.');
      });

      it("isn't offered for a profile without computer use, an unreachable machine, or a chat that runs here", () => {
        profile(false);
        machines('reachable', []);
        const { unmount } = render(<ComputerBanner chat={remoteChat} />);
        expect(screen.queryByTestId('computer-start-remote')).toBeNull();
        unmount();
        profile(true);
        machines('unreachable', []);
        const second = render(<ComputerBanner chat={remoteChat} />);
        expect(screen.queryByTestId('computer-start-remote')).toBeNull();
        second.unmount();
        machines('reachable', []);
        render(<ComputerBanner chat={{ ...remoteChat, runsOn: 'node-self' }} />);
        expect(screen.queryByTestId('computer-start-remote')).toBeNull();
      });
    });

    it('a session on this computer wins: the banner says this computer', () => {
      machines('reachable', [{ chatId: 'chat-1', lastAction: 'elsewhere' }]);
      session('here');
      render(<ComputerBanner chat={chat} />);
      expect(screen.getByTestId('computer-banner')).toHaveTextContent('OtherBench is controlling this computer.');
      expect(screen.getByTestId('computer-banner')).toHaveTextContent('Last: here');
    });
  });

  it('keeps Stop usable when the stop request fails', async () => {
    vi.mocked(api.chats.stopComputer).mockRejectedValue(new Error('offline'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    session();
    render(<ComputerBanner chat={chat} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
