import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { useOtherBenchStore } from '../state/store.js';
import { useFeatures } from '../state/features.js';

vi.mock('../state/api.js', () => ({
  api: { chats: { handover: vi.fn(), patch: vi.fn() } },
}));

import { api } from '../state/api.js';
import { Message } from './Message.js';
import { pendingHandovers } from '../state/handover.js';

const meta = { engine: 'claude_code' as const, sessionId: 's', backend: 'claude', cwd: '/w' };
const producedBy = { profileId: 'p1', profileName: 'CC', connectionId: 'k1', modelId: 'opus' };
const reply = (extra: Partial<CanonMessage> = {}): CanonMessage => ({
  id: 'a1', chatId: 'c1', parentId: 'u1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }], status: 'complete', error: null,
  producedBy, engineMeta: meta, createdAt: 1, ...extra,
});
const userMsg = (id: string, parentId: string | null, parts: CanonMessage['parts']): CanonMessage => ({
  id, chatId: 'c1', parentId, role: 'user', parts, status: 'complete', error: null, producedBy: null, createdAt: 0,
});

function setup(chat: Record<string, unknown> = {}, messages: CanonMessage[] = [userMsg('u1', null, [{ type: 'text', text: 'go' }]), reply()]): void {
  useOtherBenchStore.setState({
    chats: [{ id: 'c1', title: 'Rig', profileId: 'p1', contextTokens: 420_000, handoverAskAt: null, handoverSuggest: true, ...chat }] as never,
    messages: Object.fromEntries(messages.map((m) => [m.id, m])),
    appRunningTurns: {},
    appBackgroundChats: {},
    chatNotes: {},
  });
}

describe('the fresh chat card', () => {
  const handover = vi.mocked(api.chats.handover);
  const update = vi.mocked(api.chats.patch);
  beforeEach(() => {
    handover.mockReset().mockResolvedValue({ userMessageId: 'u2', assistantMessageIds: ['a2'] });
    update.mockReset().mockResolvedValue({} as never);
    useFeatures.setState({ github: true, nextcloud: true, handoverEnabled: true, handoverThresholdTokens: 300_000 });
    pendingHandovers.clear();
    setup();
  });
  afterEach(cleanup);

  it('offers a fresh chat under the latest reply of a big chat, and starts one', async () => {
    render(<Message message={reply()} />);
    expect(screen.getByTestId('handover-card')).toHaveTextContent('This chat is re-reading ~420k tokens a call. Start a fresh chat with a summary?');
    await userEvent.click(screen.getByRole('button', { name: 'Start fresh chat' }));
    expect(handover).toHaveBeenCalledWith('c1', { messageId: 'a1' });
    expect(pendingHandovers.has('c1')).toBe(true);
  });

  it('shows nothing with no measurement, under an earlier reply, when switched off for the chat, or with the setting off', () => {
    setup({ contextTokens: null });
    const { unmount } = render(<Message message={reply()} />);
    expect(screen.queryByTestId('handover-card')).toBeNull();
    unmount();

    setup({}, [userMsg('u1', null, []), reply(), userMsg('u2', 'a1', [{ type: 'text', text: 'more' }])]);
    const second = render(<Message message={reply()} />);
    expect(screen.queryByTestId('handover-card')).toBeNull();
    second.unmount();

    setup({ handoverSuggest: false });
    const third = render(<Message message={reply()} />);
    expect(screen.queryByTestId('handover-card')).toBeNull();
    third.unmount();

    setup();
    useFeatures.setState({ handoverEnabled: false });
    render(<Message message={reply()} />);
    expect(screen.queryByTestId('handover-card')).toBeNull();
  });

  it('waits while the chat is busy', () => {
    useOtherBenchStore.setState({ appRunningTurns: { other: 'c1' } });
    render(<Message message={reply()} />);
    const start = screen.getByRole('button', { name: 'Start fresh chat' });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', "Wait for this chat to finish what it's doing first.");
  });

  it('asks again at half as much again after Not now, and never after Don\'t ask again', async () => {
    render(<Message message={reply()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(update).toHaveBeenCalledWith('c1', { handoverAskAt: 630_000 });
    await userEvent.click(screen.getByRole('button', { name: "Don't ask again for this chat" }));
    expect(update).toHaveBeenCalledWith('c1', { handoverSuggest: false });
  });

  it('comes back under a summary that failed, for the reply it was asked of', async () => {
    const failed = reply({ id: 'a2', parentId: 'h1', status: 'error', error: { kind: 'unknown', message: 'boom', retryable: false }, parts: [] });
    setup({}, [userMsg('u1', null, []), reply(), userMsg('h1', 'a1', [{ type: 'handover-request' }]), failed]);
    render(<Message message={failed} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start fresh chat' }));
    expect(handover).toHaveBeenCalledWith('c1', { messageId: 'a1' });
  });

  it('is not offered under a summary that finished', () => {
    const done = reply({ id: 'a2', parentId: 'h1' });
    setup({}, [userMsg('u1', null, []), reply(), userMsg('h1', 'a1', [{ type: 'handover-request' }]), done]);
    render(<Message message={done} />);
    expect(screen.queryByTestId('handover-card')).toBeNull();
  });
});

describe('handover lines', () => {
  afterEach(cleanup);

  it('shows the request as a line, not as a message', () => {
    render(<Message message={userMsg('h1', 'a1', [{ type: 'handover-request' }])} />);
    expect(screen.getByText('Handover to a fresh chat')).toBeInTheDocument();
    expect(screen.queryByText('You')).toBeNull();
  });

  it('links to the chat a reply was handed over to', async () => {
    useOtherBenchStore.setState({ activeChatId: 'c1' });
    const setActive = vi.fn<(chatId: string | null) => void>();
    useOtherBenchStore.setState({ setActiveChatId: setActive });
    render(<Message message={reply({ parts: [{ type: 'text', text: 'Summary.' }, { type: 'handover', direction: 'to', chatId: 'c2', title: 'Rig (continued)' }] })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continued in Rig (continued)' }));
    expect(setActive).toHaveBeenCalledWith('c2');
  });
});
