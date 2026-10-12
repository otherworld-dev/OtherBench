import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleView } from '@grunt/core/ports/store.js';
import type { Connection, Profile } from '@grunt/core/types/config.js';

vi.mock('../state/api.js', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string
    ) {
      super(message);
    }
  },
  api: {
    schedules: { list: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn(), runs: vi.fn(), run: vi.fn() },
    turns: { cancel: vi.fn() },
  },
}));

import { api, ApiError } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { SchedulesView } from './SchedulesView.js';

const list = vi.mocked(api.schedules.list);
const patch = vi.mocked(api.schedules.patch);
const run = vi.mocked(api.schedules.run);
const create = vi.mocked(api.schedules.create);

function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: 's1', name: 'Weekly report', prompt: 'hello', profileId: 'p1', target: { kind: 'chat', chatId: 'c1' },
    rule: { cadence: 'daily', time: '09:00' }, timezone: 'Europe/London', enabled: true, nextRunAt: Date.parse('2099-10-13T08:00:00Z'),
    createdAt: 1, updatedAt: 1, targetName: 'Trip plans', describe: 'Every day at 09:00', running: false, lastRun: null, warnings: [], ...over,
  };
}

const profile: Profile = { id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null };
const connection: Connection = { id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ profiles: [profile], connections: [connection] });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('SchedulesView', () => {
  it('says there are none yet', async () => {
    list.mockResolvedValue([]);
    render(<SchedulesView onClose={vi.fn()} />);
    expect(await screen.findByText(/No schedules yet/)).toBeInTheDocument();
  });

  it('shows each schedule: its rule, target, profile and next run in its zone, or Paused', async () => {
    list.mockResolvedValue([view(), view({ id: 's2', name: 'Monthly', enabled: false, nextRunAt: null, target: { kind: 'project', projectId: 'pr' }, targetName: 'Alpha' })]);
    render(<SchedulesView onClose={vi.fn()} />);
    const row = await screen.findByTestId('schedule-row-s1');
    expect(row).toHaveTextContent('Every day at 09:00');
    expect(row).toHaveTextContent('Chat: Trip plans');
    expect(row).toHaveTextContent('Mock');
    expect(within(row).getByTestId('schedule-next')).toHaveTextContent('Tuesday 13 October 2099, 09:00 (Europe/London)');
    const paused = screen.getByTestId('schedule-row-s2');
    expect(paused).toHaveTextContent('New chat each run in Alpha');
    expect(within(paused).getByTestId('schedule-next')).toHaveTextContent('Next run: Paused');
  });

  it('pauses and resumes', async () => {
    list.mockResolvedValue([view(), view({ id: 's2', enabled: false, nextRunAt: null })]);
    patch.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<SchedulesView onClose={vi.fn()} />);
    await user.click(within(await screen.findByTestId('schedule-row-s1')).getByRole('button', { name: 'Pause' }));
    expect(patch).toHaveBeenCalledWith('s1', { enabled: false });
    await user.click(within(screen.getByTestId('schedule-row-s2')).getByRole('button', { name: 'Resume' }));
    expect(patch).toHaveBeenCalledWith('s2', { enabled: true });
  });

  it("shows Run now's refusal inline", async () => {
    list.mockResolvedValue([view()]);
    run.mockRejectedValue(new ApiError(409, 'A reply is being written in this chat. Try again when it has finished.'));
    const user = userEvent.setup();
    render(<SchedulesView onClose={vi.fn()} />);
    const row = await screen.findByTestId('schedule-row-s1');
    await user.click(within(row).getByRole('button', { name: 'Run now' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('A reply is being written in this chat.');
  });

  it('opens the editor on its prefilled chat, with the profile warnings, and saves a new schedule', async () => {
    list.mockResolvedValue([]);
    useGruntStore.setState({ chats: [{ id: 'c1', title: 'Trip plans', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    create.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<SchedulesView prefill={{ kind: 'chat', chatId: 'c1' }} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    expect(dialog).toHaveTextContent('Chat: Trip plans');
    expect(dialog).toHaveTextContent('This profile asks before every tool call, so every tool call will be refused.');
    await user.type(within(dialog).getByLabelText('Name'), 'Weekly report');
    await user.type(within(dialog).getByLabelText('Prompt'), 'hello');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: 'Weekly report', prompt: 'hello', profileId: 'p1', target: { chatId: 'c1' }, rule: { cadence: 'daily', time: '09:00' } })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
