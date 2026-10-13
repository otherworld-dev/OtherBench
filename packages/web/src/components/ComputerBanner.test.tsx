import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionSummary } from '@grunt/core/domain/computer-apps.js';
import type { Chat } from '@grunt/core/ports/store.js';
import { useGruntStore } from '../state/store.js';
import { ComputerBanner } from './ComputerBanner.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, chats: { ...actual.api.chats, stopComputer: vi.fn() } } };
});

import { api } from '../state/api.js';

const chat = { id: 'chat-1', title: 'Budget' } as Chat;
const session = (lastAction?: string): void =>
  act(() => useGruntStore.getState().applyAppEvent({ type: 'computer-session', chatId: 'chat-1', active: true, ...(lastAction === undefined ? {} : { lastAction }) }));

describe('ComputerBanner', () => {
  beforeEach(() => {
    useGruntStore.setState(useGruntStore.getInitialState(), true);
    vi.mocked(api.chats.stopComputer).mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('shows only while the chat is in control, as a status, with its last action', () => {
    render(<ComputerBanner chat={chat} />);
    expect(screen.queryByTestId('computer-banner')).toBeNull();
    session('click at 1, 2');
    const banner = screen.getByTestId('computer-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('Grunt is controlling this computer.');
    expect(banner).toHaveTextContent('Last: click at 1, 2');
    act(() => useGruntStore.getState().applyAppEvent({ type: 'computer-session', chatId: 'chat-1', active: false }));
    expect(screen.queryByTestId('computer-banner')).toBeNull();
  });

  it('shows the banner for a session the hello reports (a window opened mid-session)', () => {
    act(() => useGruntStore.getState().applyAppHello({ pendingApprovals: [], runningTurns: [], computerSessions: [{ chatId: 'chat-1', lastAction: 'press ctrl+s' }] }));
    render(<ComputerBanner chat={chat} />);
    expect(screen.getByTestId('computer-banner')).toHaveTextContent('Last: press ctrl+s');
  });

  it("ignores another chat's session", () => {
    act(() => useGruntStore.getState().applyAppEvent({ type: 'computer-session', chatId: 'other', active: true }));
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
