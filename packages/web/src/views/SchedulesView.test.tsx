import { useState, type JSX } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleView } from '@otherbench/core/ports/store.js';
import type { PeerScheduleRow, PeerSchedules } from '@otherbench/core/types/peer.js';
import type { Connection, Profile } from '@otherbench/core/types/config.js';

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
    peers: { schedules: vi.fn() },
  },
}));

import { api, ApiError } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { SCHEDULES_POLL_MS, SchedulesView } from './SchedulesView.js';

const list = vi.mocked(api.schedules.list);
const patch = vi.mocked(api.schedules.patch);
const run = vi.mocked(api.schedules.run);
const create = vi.mocked(api.schedules.create);
const runs = vi.mocked(api.schedules.runs);
const cancel = vi.mocked(api.turns.cancel);
const peerSchedules = vi.mocked(api.peers.schedules);

function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: 's1', name: 'Weekly report', prompt: 'hello', profileId: 'p1', target: { kind: 'chat', chatId: 'c1' },
    rule: { cadence: 'daily', time: '09:00' }, timezone: 'Europe/London', enabled: true, nextRunAt: Date.parse('2099-10-13T08:00:00Z'), autoMode: false, timeLimitMinutes: 30,
    createdAt: 1, updatedAt: 1, targetName: 'Trip plans', describe: 'Every day at 09:00', running: false, activeRun: null, lastRun: null, warnings: [], ...over,
  };
}

const profile: Profile = { id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null };
const connection: Connection = { id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ profiles: [profile], connections: [connection] });
  peerSchedules.mockResolvedValue([]);
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

  it('says which schedules run in auto mode, only where the profile is Claude Code', async () => {
    useOtherBenchStore.setState({
      profiles: [profile, { ...profile, id: 'p-cc', name: 'Claude', connectionId: 'cc' }],
      connections: [connection, { ...connection, id: 'cc', name: 'Claude Code', kind: 'claude_code' }],
    });
    list.mockResolvedValue([view({ profileId: 'p-cc', autoMode: true }), view({ id: 's2', autoMode: true }), view({ id: 's3', profileId: 'p-cc' })]);
    render(<SchedulesView onClose={vi.fn()} />);
    expect(await screen.findByTestId('schedule-row-s1')).toHaveTextContent('Claude · Auto mode');
    expect(screen.getByTestId('schedule-row-s2')).not.toHaveTextContent('Auto mode');
    expect(screen.getByTestId('schedule-row-s3')).not.toHaveTextContent('Auto mode');
  });

  it('says when a schedule has no time limit, or one other than the usual 30 minutes', async () => {
    list.mockResolvedValue([view(), view({ id: 's2', timeLimitMinutes: null }), view({ id: 's3', timeLimitMinutes: 120 })]);
    render(<SchedulesView onClose={vi.fn()} />);
    expect(await screen.findByTestId('schedule-row-s1')).not.toHaveTextContent('time limit');
    expect(screen.getByTestId('schedule-row-s2')).toHaveTextContent('Mock · No time limit');
    expect(screen.getByTestId('schedule-row-s3')).toHaveTextContent('Mock · Time limit 2 hours');
  });

  it("shows a timed-out run in the history with what stopped it", async () => {
    list.mockResolvedValue([view()]);
    runs.mockResolvedValue([
      {
        id: 'r1', scheduleId: 's1', trigger: 'scheduled', dueAt: 1, startedAt: Date.parse('2026-10-12T08:00:00Z'), finishedAt: 2, status: 'timed_out',
        detail: "Stopped at the schedule's time limit of 30 minutes.", chatId: 'c1', createdChat: false, userMessageId: 'u1', messageId: 'm1', refusedCalls: 0,
      },
    ]);
    const user = userEvent.setup();
    render(<SchedulesView onClose={vi.fn()} />);
    await user.click(within(await screen.findByTestId('schedule-row-s1')).getByRole('button', { name: 'History' }));
    const item = await screen.findByTestId('schedule-run-r1');
    expect(within(item).getByTestId('run-status')).toHaveTextContent('Timed out');
    expect(item).toHaveTextContent("Stopped at the schedule's time limit of 30 minutes.");
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

  it('keeps Stop, for the run still being written, after a slot it overran was recorded as not started', async () => {
    const skipped = {
      id: 'r2', scheduleId: 's1', trigger: 'scheduled' as const, dueAt: 2, startedAt: 2, finishedAt: 2, status: 'not_started' as const,
      detail: 'The previous run was still going.', chatId: null, createdChat: false, userMessageId: null, messageId: null, refusedCalls: 0,
    };
    list.mockResolvedValue([view({ running: true, activeRun: { runId: 'r1', messageId: 'm1' }, lastRun: skipped })]);
    cancel.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SchedulesView onClose={vi.fn()} />);
    const row = await screen.findByTestId('schedule-row-s1');
    expect(within(row).queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Stop' }));
    expect(cancel).toHaveBeenCalledWith('m1');
  });

  it('opens the editor on its prefilled chat, with the profile warnings, and saves a new schedule', async () => {
    list.mockResolvedValue([]);
    useOtherBenchStore.setState({ chats: [{ id: 'c1', title: 'Trip plans', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, unread: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    create.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<SchedulesView prefill={{ kind: 'chat', chatId: 'c1' }} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    expect(dialog).toHaveTextContent('Chat: Trip plans');
    expect(dialog).toHaveTextContent('This profile asks before every tool call, so every tool call will be refused.');
    // Auto is Claude Code's: not offered on this profile.
    expect(within(dialog).queryByRole('checkbox', { name: /auto mode/i })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Weekly report');
    await user.type(within(dialog).getByLabelText('Prompt'), 'hello');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: 'Weekly report', prompt: 'hello', profileId: 'p1', target: { chatId: 'c1' }, rule: { cadence: 'daily', time: '09:00' }, autoMode: false, timeLimitMinutes: 30 })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('takes a cron rule, showing a typo in place of the next three runs as it is typed, and saves it', async () => {
    list.mockResolvedValue([]);
    useOtherBenchStore.setState({ chats: [{ id: 'c1', title: 'Trip plans', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, unread: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    create.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<SchedulesView prefill={{ kind: 'chat', chatId: 'c1' }} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    expect(within(within(dialog).getByTestId('schedule-preview')).getAllByRole('listitem')).toHaveLength(3);
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), 'Cron rule');
    expect(within(dialog).queryByLabelText('Time')).not.toBeInTheDocument();
    const rule = within(dialog).getByLabelText('Cron rule');
    await user.clear(rule);
    await user.type(rule, '0 9 * * 1-');
    expect(within(dialog).getByTestId('schedule-preview')).toHaveTextContent('The day of week field\'s "1-" isn\'t a value, a range or "*".');
    await user.type(rule, '5');
    const preview = within(dialog).getByTestId('schedule-preview');
    expect(preview).toHaveTextContent('Next runs');
    const runs = within(preview).getAllByRole('listitem');
    expect(runs).toHaveLength(3);
    for (const item of runs) expect(item).toHaveTextContent(/^(Monday|Tuesday|Wednesday|Thursday|Friday) .*, 09:00$/);

    await user.type(within(dialog).getByLabelText('Name'), 'Standup');
    await user.type(within(dialog).getByLabelText('Prompt'), 'hello');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ rule: { cadence: 'cron', cron: '0 9 * * 1-5' } })));
  });

  it('takes an every-N-hours rule, on chosen days', async () => {
    list.mockResolvedValue([]);
    useOtherBenchStore.setState({ chats: [{ id: 'c1', title: 'Trip plans', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, unread: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    create.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<SchedulesView prefill={{ kind: 'chat', chatId: 'c1' }} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    await user.selectOptions(within(dialog).getByLabelText('Repeats'), 'Every few hours');
    const every = within(dialog).getByLabelText('Every (hours)');
    await user.clear(every);
    await user.type(every, '4');
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '08:00' } });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Sat' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Sun' }));
    for (const item of within(within(dialog).getByTestId('schedule-preview')).getAllByRole('listitem')) {
      expect(item).toHaveTextContent(/^(Monday|Tuesday|Wednesday|Thursday|Friday) .*, (08|12|16|20):00$/);
    }
    await user.type(within(dialog).getByLabelText('Name'), 'Check');
    await user.type(within(dialog).getByLabelText('Prompt'), 'hello');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ rule: { cadence: 'hourly', time: '08:00', everyHours: 4, weekdays: [1, 2, 3, 4, 5] } }))
    );
  });

  it('sets a new schedule\'s time limit, 30 minutes unless changed, and No limit sends null', async () => {
    list.mockResolvedValue([]);
    useOtherBenchStore.setState({ chats: [{ id: 'c1', title: 'Trip plans', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, unread: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }] });
    create.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<SchedulesView prefill={{ kind: 'chat', chatId: 'c1' }} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    const limit = within(dialog).getByLabelText('Time limit');
    expect(limit).toHaveDisplayValue('30 minutes');
    expect(dialog).toHaveTextContent('A run still going after this is stopped, as Stop would, and marked Timed out.');
    await user.selectOptions(limit, 'No limit');
    expect(dialog).toHaveTextContent('A run goes on until it finishes or you stop it, however long that takes.');
    await user.type(within(dialog).getByLabelText('Name'), 'Nightly');
    await user.type(within(dialog).getByLabelText('Prompt'), 'hello');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Nightly', timeLimitMinutes: null })));
  });

  it("edits a schedule's time limit, sending only that", async () => {
    list.mockResolvedValue([view({ timeLimitMinutes: 45 })]);
    patch.mockResolvedValue(view({ timeLimitMinutes: 240 }));
    const user = userEvent.setup();
    render(<SchedulesView onClose={vi.fn()} />);
    await user.click(within(await screen.findByTestId('schedule-row-s1')).getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit schedule' });
    const limit = within(dialog).getByLabelText('Time limit');
    // A limit set some other way is shown as it is, not swapped for a listed one.
    expect(limit).toHaveDisplayValue('45 minutes');
    await user.selectOptions(limit, '4 hours');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('s1', { timeLimitMinutes: 240 }));
  });

  it("offers Auto for a Claude Code profile: ticking it changes the warnings and is saved with the schedule", async () => {
    list.mockResolvedValue([]);
    useOtherBenchStore.setState({
      profiles: [{ ...profile, id: 'p-cc', name: 'Claude', connectionId: 'cc' }],
      connections: [{ ...connection, id: 'cc', name: 'Claude Code', kind: 'claude_code' }],
      chats: [{ id: 'c1', title: 'Trip plans', profileId: 'p-cc', headMessageId: null, workspace: null, runsOn: 'n', pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, unread: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }],
    });
    create.mockResolvedValue(view());
    const user = userEvent.setup();
    render(<SchedulesView prefill={{ kind: 'chat', chatId: 'c1' }} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
    const auto = within(dialog).getByRole('checkbox', { name: /auto mode/i });
    expect(auto).not.toBeChecked();
    expect(dialog).toHaveTextContent('This profile asks before every tool call, so every tool call will be refused.');
    await user.click(auto);
    expect(dialog).not.toHaveTextContent('every tool call will be refused');
    expect(dialog).toHaveTextContent("Auto mode decides Claude Code's tool calls.");
    await user.type(within(dialog).getByLabelText('Name'), 'Triage');
    await user.type(within(dialog).getByLabelText('Prompt'), 'hello');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p-cc', autoMode: true })));
  });

  describe('the editor dialog', () => {
    it('still closes on Esc after a press on its non-control area', async () => {
      list.mockResolvedValue([]);
      const user = userEvent.setup();
      render(<SchedulesView onClose={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: 'New schedule' }));
      const dialog = await screen.findByRole('dialog', { name: 'New schedule' });

      await user.click(within(dialog).getByRole('heading', { name: 'New schedule' }));
      expect(document.body).not.toBe(document.activeElement);
      await user.click(within(dialog).getByText('Name'));
      await user.pointer({ keys: '[MouseLeft]', target: dialog.parentElement! });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('schedules-view')).toBeInTheDocument();
    });

    it('wraps Tab from the last control to the first, and Shift+Tab back', async () => {
      list.mockResolvedValue([]);
      const user = userEvent.setup();
      render(<SchedulesView onClose={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: 'New schedule' }));
      const dialog = await screen.findByRole('dialog', { name: 'New schedule' });
      const name = within(dialog).getByLabelText('Name');
      const save = within(dialog).getByRole('button', { name: 'Save' });

      expect(name).toHaveFocus();
      await user.tab({ shift: true });
      expect(save).toHaveFocus();
      await user.tab();
      expect(name).toHaveFocus();
    });

    it('hands focus back to the button that opened it', async () => {
      list.mockResolvedValue([]);
      const user = userEvent.setup();
      render(<SchedulesView onClose={vi.fn()} />);
      const opener = await screen.findByRole('button', { name: 'New schedule' });
      await user.click(opener);
      await user.keyboard('{Escape}');
      expect(opener).toHaveFocus();
    });
  });

  describe('the 30 s poll', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-reads the list on the interval and stops once the overlay is closed', async () => {
      vi.useFakeTimers();
      list.mockResolvedValue([]);
      function Host(): JSX.Element | null {
        const [open, setOpen] = useState(true);
        return open ? <SchedulesView onClose={() => setOpen(false)} /> : null;
      }
      render(<Host />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(list).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SCHEDULES_POLL_MS);
      });
      expect(list).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole('button', { name: 'Close schedules' }));
      expect(screen.queryByTestId('schedules-view')).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SCHEDULES_POLL_MS * 3);
      });
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  describe("the paired machine's schedules", () => {
    function peerRow(over: Partial<PeerScheduleRow> = {}): PeerScheduleRow {
      return {
        id: 'ps1', name: 'Nightly backup', describe: 'Every day at 02:00', timezone: 'Europe/London', enabled: true, nextRunAt: Date.parse('2099-10-13T01:00:00Z'), invalid: false,
        target: { kind: 'chat', chatId: 'pc-chat' }, profileId: 'pc-profile', autoMode: false, timeLimitMinutes: 30, running: false, lastRun: null,
        targetName: 'Backups', profileName: 'Claude', ...over,
      };
    }
    function machine(over: Partial<PeerSchedules> = {}): PeerSchedules {
      return { nodeId: 'node-pc', name: 'PC', status: 'reachable', shared: true, manage: false, timezone: 'Europe/London', schedules: [peerRow()], ...over };
    }

    it('shows them in their own section, marked as running there, with what a row shows and no way to change them', async () => {
      list.mockResolvedValue([view()]);
      peerSchedules.mockResolvedValue([
        machine({
          schedules: [
            peerRow({ lastRun: { status: 'error', startedAt: Date.now() - 5 * 60_000, chatId: 'pc-chat' }, timeLimitMinutes: 120, autoMode: true }),
            peerRow({ id: 'ps2', name: 'Monthly', enabled: false, nextRunAt: null, target: { kind: 'project', projectId: 'pr' }, targetName: null, profileName: null }),
          ],
        }),
      ]);
      render(<SchedulesView onClose={vi.fn()} />);
      const section = await screen.findByTestId('peer-schedules-node-pc');
      expect(within(section).getByRole('heading')).toHaveTextContent('On PC · runs there');
      expect(section).toHaveTextContent('To run, edit, pause or delete one, do it in OtherBench on PC.');
      const row = within(section).getByTestId('peer-schedule-row-ps1');
      expect(row).toHaveTextContent('Nightly backup');
      expect(row).toHaveTextContent('Every day at 02:00');
      expect(row).toHaveTextContent('Chat: Backups · Claude · Auto mode · Time limit 2 hours');
      expect(within(row).getByTestId('schedule-next')).toHaveTextContent('Tuesday 13 October 2099, 02:00 (Europe/London)');
      expect(within(row).getByTestId('schedule-last')).toHaveTextContent('Last run: Failed');
      // Not synced here: said so, not left blank.
      const other = within(section).getByTestId('peer-schedule-row-ps2');
      expect(other).toHaveTextContent('New chat each run in a project not on this machine yet · a profile not on this machine yet');
      expect(within(other).getByTestId('schedule-next')).toHaveTextContent('Next run: Paused');
      // Read-only: only Open, for the last run's chat; none of the local row's buttons.
      expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open']);
      for (const name of ['Run now', 'Pause', 'Resume', 'Edit', 'History', 'Delete…', 'Stop']) expect(within(section).queryByRole('button', { name })).not.toBeInTheDocument();
      // The local row keeps its own.
      expect(within(screen.getByTestId('schedule-row-s1')).getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    });

    it("opens the last run's chat here", async () => {
      const onClose = vi.fn();
      list.mockResolvedValue([]);
      peerSchedules.mockResolvedValue([machine({ schedules: [peerRow({ lastRun: { status: 'complete', startedAt: Date.now(), chatId: 'pc-chat' } })] })]);
      render(<SchedulesView onClose={onClose} />);
      fireEvent.click(await within(await screen.findByTestId('peer-schedule-row-ps1')).findByRole('button', { name: 'Open' }));
      expect(useOtherBenchStore.getState().activeChatId).toBe('pc-chat');
      expect(onClose).toHaveBeenCalled();
    });

    it("says the machine isn't reachable instead of showing rows", async () => {
      list.mockResolvedValue([]);
      peerSchedules.mockResolvedValue([machine({ status: 'unreachable', shared: false, schedules: [] })]);
      render(<SchedulesView onClose={vi.fn()} />);
      const section = await screen.findByTestId('peer-schedules-node-pc');
      expect(within(section).getByTestId('peer-schedules-unreachable')).toHaveTextContent('PC isn’t reachable, so its schedules can’t be shown.');
      expect(within(section).queryByTestId('peer-schedule-row-ps1')).not.toBeInTheDocument();
    });

    it("says when the machine has none, or is an older build that doesn't share them", async () => {
      list.mockResolvedValue([]);
      peerSchedules.mockResolvedValue([machine({ schedules: [] }), machine({ nodeId: 'node-old', name: 'Old', shared: false, schedules: [] })]);
      render(<SchedulesView onClose={vi.fn()} />);
      expect(await screen.findByTestId('peer-schedules-node-pc')).toHaveTextContent('PC has no schedules.');
      expect(screen.getByTestId('peer-schedules-node-old')).toHaveTextContent('Old doesn’t share its schedules.');
    });

    it("shows nothing when no machine is paired, or the list can't be read", async () => {
      list.mockResolvedValue([]);
      render(<SchedulesView onClose={vi.fn()} />);
      await screen.findByText(/No schedules yet/);
      await waitFor(() => expect(peerSchedules).toHaveBeenCalled());
      expect(screen.queryByTestId('peer-schedules')).not.toBeInTheDocument();
      cleanup();
      peerSchedules.mockClear();
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      peerSchedules.mockRejectedValue(new Error('Pairing is not available on this server.'));
      render(<SchedulesView onClose={vi.fn()} />);
      await screen.findByText(/No schedules yet/);
      await waitFor(() => expect(quiet).toHaveBeenCalled());
      expect(screen.queryByTestId('peer-schedules')).not.toBeInTheDocument();
      quiet.mockRestore();
    });

    it('re-reads them when the machine says they changed or its reachability changes, and leaves the local list alone', async () => {
      list.mockResolvedValue([]);
      peerSchedules.mockResolvedValue([machine()]);
      render(<SchedulesView onClose={vi.fn()} />);
      await screen.findByTestId('peer-schedule-row-ps1');
      await waitFor(() => expect(list).toHaveBeenCalled());
      const listed = list.mock.calls.length;
      peerSchedules.mockResolvedValue([machine({ status: 'unreachable', shared: false, schedules: [] })]);
      act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'peer-status', nodeId: 'node-pc', status: 'unreachable', since: 1 }));
      expect(await screen.findByTestId('peer-schedules-unreachable')).toBeInTheDocument();
      peerSchedules.mockResolvedValue([machine({ schedules: [peerRow({ name: 'Renamed there' })] })]);
      act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'peer-schedules', nodeId: 'node-pc' }));
      expect(await screen.findByText('Renamed there')).toBeInTheDocument();
      expect(list.mock.calls.length).toBe(listed);
    });
  });
});
