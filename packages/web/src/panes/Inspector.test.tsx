import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { Profile } from '@grunt/core/types/config.js';
import { Inspector } from './Inspector.js';
import { useGruntStore } from '../state/store.js';

vi.mock('../state/api.js', () => ({
  api: {
    usage: {
      get: vi.fn(),
    },
  },
}));

import { api } from '../state/api.js';

const mockedUsageGet = vi.mocked(api.usage.get);

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Chat 1',
    profileId: 'p1',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    name: 'Default',
    description: null,
    colour: null,
    connectionId: 'c1',
    modelId: 'mock-standard',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: true,
    archivedAt: null,
    ...overrides,
  };
}

function makeRollup(overrides: Partial<UsageRollup> = {}): UsageRollup {
  return {
    profiles: [],
    chats: [],
    buckets: [],
    totalMeasuredCost: 0,
    totalCancelledCount: 0,
    totalUnmeasuredErrorCount: 0,
    ...overrides,
  };
}

function makeMessage(id: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id,
    chatId: 'chat-1',
    parentId: 'user-1',
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: { profileId: 'p1', profileName: 'Alpha', connectionId: 'c1', modelId: 'mock-standard' },
    createdAt: 0,
    ...overrides,
  };
}

describe('Inspector session spend', () => {
  beforeEach(() => {
    useGruntStore.setState(useGruntStore.getInitialState(), true);
    mockedUsageGet.mockReset();
  });
  afterEach(cleanup);

  it('shows "No chat selected" when there is no active chat', () => {
    render(<Inspector chat={null} profile={null} collapsed={false} onToggleCollapsed={vi.fn()} />);
    const spendSection = screen.getByRole('heading', { name: 'Running session spend' }).closest('section')!;
    expect(within(spendSection).getByText('No chat selected.')).toBeInTheDocument();
    expect(mockedUsageGet).not.toHaveBeenCalled();
  });

  it('fetches and renders the per-profile spend rollup for the active chat', async () => {
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 4.5,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 4.5, tokensIn: 100, tokensOut: 50, tokensCached: 0, tokensReasoning: 0, completeCount: 2, cancelledCount: 0, unmeasuredErrorCount: 0 }],
      })
    );

    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledWith('chat-1'));
    expect(await screen.findByTestId('session-spend')).toHaveTextContent('$4.50');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('surfaces cancelled and unmeasured-error calls as separate honest callouts, not folded into the total', async () => {
    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 2,
        totalCancelledCount: 1,
        totalUnmeasuredErrorCount: 1,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 2, tokensIn: 10, tokensOut: 10, tokensCached: 0, tokensReasoning: 0, completeCount: 1, cancelledCount: 1, unmeasuredErrorCount: 1 }],
      })
    );

    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    const section = await screen.findByTestId('session-spend');
    expect(section).toHaveTextContent('$2.00');
    expect(section).toHaveTextContent('1 cancelled call');
    expect(section).toHaveTextContent('1 failed call');
  });

  it('shows an honest empty state when nothing has run in this chat yet', async () => {
    mockedUsageGet.mockResolvedValue(makeRollup());
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    expect(await screen.findByText('No usage recorded in this chat yet.')).toBeInTheDocument();
  });

  it('shows an error state when the usage fetch fails, without throwing', async () => {
    mockedUsageGet.mockRejectedValue(new Error('network down'));
    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);

    expect(await screen.findByText(/couldn.t load spend for this chat\./i)).toBeInTheDocument();
  });

  it('re-fetches when an assistant message in this chat reaches a terminal status (a new usage row may now exist)', async () => {
    mockedUsageGet.mockResolvedValue(makeRollup());
    useGruntStore.getState().registerMessage(makeMessage('m1', { status: 'streaming' }));

    render(<Inspector chat={makeChat()} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No usage recorded in this chat yet.')).toBeInTheDocument();

    mockedUsageGet.mockResolvedValue(
      makeRollup({
        totalMeasuredCost: 3,
        profiles: [{ profileId: 'p1', profileName: 'Alpha', modelId: 'model-x', currency: 'USD', measuredCost: 3, tokensIn: 10, tokensOut: 10, tokensCached: 0, tokensReasoning: 0, completeCount: 1, cancelledCount: 0, unmeasuredErrorCount: 0 }],
      })
    );
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'status', status: 'complete' });

    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('session-spend')).toHaveTextContent('$3.00');
  });

  it('re-fetches when switching to a different chat', async () => {
    mockedUsageGet.mockResolvedValue(makeRollup());
    const { rerender } = render(<Inspector chat={makeChat({ id: 'chat-1' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledWith('chat-1'));

    rerender(<Inspector chat={makeChat({ id: 'chat-2' })} profile={makeProfile()} collapsed={false} onToggleCollapsed={vi.fn()} />);
    await waitFor(() => expect(mockedUsageGet).toHaveBeenCalledWith('chat-2'));
  });
});
