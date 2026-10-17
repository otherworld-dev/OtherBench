import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper } from '@otherbench/core/types/background.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, chats: { ...actual.api.chats, stopHelper: vi.fn() } } };
});
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { BackgroundHelpers } from './BackgroundHelpers.js';

const implementer: BackgroundHelper = { taskId: 'k1', callId: 't1', kind: 'local_agent', label: 'implementer', startedAt: 1_000, lastActivity: 'Fixing the sha check' };
const devServer: BackgroundHelper = { taskId: 'k2', callId: null, kind: 'local_bash', label: 'npm run dev', startedAt: 61_000, lastActivity: null };
const request: ApprovalRequest = { id: 'r1', chatId: 'c1', messageId: 'm-old', toolName: 'Bash', risk: 'execute', source: 'agent', args: { command: 'npm test' }, summary: 'npm test', subagent: { callId: 't1', label: 'implementer', parentProfileId: 'p' } };

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(73_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(api.chats.stopHelper).mockReset();
});

describe('BackgroundHelpers', () => {
  it('lists the helpers running in the background with their time and last activity', () => {
    useOtherBenchStore.getState().setChatBackground('c1', [implementer, devServer], []);
    render(<BackgroundHelpers chatId="c1" onResolveApproval={vi.fn()} />);
    const rows = screen.getAllByTestId('background-helper');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('implementer');
    expect(rows[0]).toHaveTextContent('1m 12s');
    expect(rows[0]).toHaveTextContent('Fixing the sha check');
    expect(rows[1]).toHaveTextContent('npm run dev');
    expect(rows[1]).toHaveTextContent('command');
    expect(rows[1]).toHaveTextContent('12s');
  });

  it('Stop stops a helper and shows why when it fails', async () => {
    vi.useRealTimers();
    useOtherBenchStore.getState().setChatBackground('c1', [implementer], []);
    vi.mocked(api.chats.stopHelper).mockRejectedValueOnce(new ApiError(404, 'That background task is not running.'));
    render(<BackgroundHelpers chatId="c1" onResolveApproval={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop implementer' }));
    expect(api.chats.stopHelper).toHaveBeenCalledWith('c1', 'k1');
    expect(await screen.findByRole('alert')).toHaveTextContent('That background task is not running.');
  });

  it("shows a helper's approval card under it", () => {
    useOtherBenchStore.getState().setChatBackground('c1', [implementer], [request]);
    render(<BackgroundHelpers chatId="c1" onResolveApproval={vi.fn()} />);
    const row = screen.getByTestId('background-helper');
    expect(row).toHaveTextContent('needs your approval');
    expect(screen.getByTestId('approval-prompt-r1')).toBeInTheDocument();
  });

  it('is hidden with nothing running', () => {
    render(<BackgroundHelpers chatId="c1" onResolveApproval={vi.fn()} />);
    expect(screen.queryByTestId('background-helpers')).not.toBeInTheDocument();
  });

  it('follows the chat stream: helpers, approval cards for replies that are not streaming, and a reload when messages changed', () => {
    const s = useOtherBenchStore.getState();
    s.loadMessages('c1', [{ id: 'm-old', chatId: 'c1', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 1 }], null);
    act(() => {
      s.applyChatEvent('c1', { type: 'helpers', chatId: 'c1', helpers: [implementer] });
      s.applyChatEvent('c1', { messageId: 'm-old', type: 'approval-request', request, background: true });
      s.applyChatEvent('c1', { type: 'messages-changed', chatId: 'c1' });
    });
    const state = useOtherBenchStore.getState();
    expect(state.chatHelpers['c1']).toEqual([implementer]);
    expect(state.backgroundApprovals['c1']).toEqual([request]);
    expect(state.extras['m-old']?.pendingApprovals ?? []).toEqual([]);
    expect(state.chatReloads['c1']).toBe(1);
    act(() => s.applyChatEvent('c1', { messageId: 'm-old', type: 'approval-resolved', requestId: 'r1', choice: 'once', background: true }));
    expect(useOtherBenchStore.getState().backgroundApprovals['c1']).toEqual([]);
  });

  it("gives a reply's own approval card to the reply, even one this window hasn't loaded yet", () => {
    const s = useOtherBenchStore.getState();
    act(() => s.applyChatEvent('c1', { messageId: 'm-unseen', type: 'approval-request', request: { ...request, messageId: 'm-unseen' } }));
    expect(useOtherBenchStore.getState().backgroundApprovals['c1'] ?? []).toEqual([]);
  });
});
