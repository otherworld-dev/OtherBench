import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryUpdateOutcome, ProjectMemoryView } from '@grunt/core/domain/memory.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      usage: { get: vi.fn() },
      mcpServers: { list: vi.fn(), refresh: vi.fn() },
      grants: { list: vi.fn(), revoke: vi.fn() },
      audit: { list: vi.fn() },
      health: vi.fn(),
      chats: { patch: vi.fn() },
      memory: { get: vi.fn(), save: vi.fn(), versions: vi.fn(), version: vi.fn(), restore: vi.fn(), updateNow: vi.fn() },
    },
  };
});

import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { Inspector } from './Inspector.js';

const m = vi.mocked(api.memory);

const noteFor = (name: string): string => `## Pinned\n\n## Goals\n- ${name} goal\n\n## Decisions\n\n## Current focus\n\n## Open questions`;
const project = (id: string, name: string): Project => ({ id, name, workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 });
const chatIn = (id: string, projectId: string): Chat => ({
  id,
  title: id,
  profileId: 'p1',
  headMessageId: null,
  workspace: null,
  runsOn: 'node-self',
  workspaceRoot: null,
  pinned: false,
  autoMode: false,
  projectId,
  memoryCursor: null,
  memoryExcluded: false,
  sortOrder: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
});
const profile: Profile = {
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
};
const viewFor = (projectId: string, name: string): ProjectMemoryView => ({
  memory: { projectId, body: noteFor(name), updatedAt: Date.now() - 60_000, updatedBy: 'summariser', sourceChatId: null },
  lastError: null,
});

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ projects: [project('A', 'Alpha'), project('B', 'Beta')] });
  vi.mocked(api.usage.get).mockReset().mockResolvedValue({ profiles: [], chats: [], buckets: [], totalMeasuredCost: 0, totalCancelledCount: 0, totalUnmeasuredErrorCount: 0 });
  vi.mocked(api.mcpServers.list).mockReset().mockResolvedValue([]);
  vi.mocked(api.grants.list).mockReset().mockResolvedValue([]);
  vi.mocked(api.audit.list).mockReset().mockResolvedValue([]);
  vi.mocked(api.health).mockReset().mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
  m.get.mockReset().mockImplementation(async (id: string) => viewFor(id, id === 'A' ? 'Alpha' : 'Beta'));
  m.save.mockReset();
  m.versions.mockReset().mockResolvedValue([]);
  m.updateNow.mockReset();
});

afterEach(cleanup);

describe('Inspector project memory across a project switch', () => {
  it("a stale Update now response from project A never lands in project B's panel", async () => {
    const user = userEvent.setup();
    let release!: (o: MemoryUpdateOutcome) => void;
    m.updateNow.mockReturnValue(new Promise<MemoryUpdateOutcome>((r) => (release = r)));
    const props = { profile, collapsed: false, onToggleCollapsed: vi.fn() };
    const { rerender } = render(<Inspector chat={chatIn('chat-a', 'A')} {...props} />);
    await user.click(await screen.findByRole('button', { name: 'Update now' }));

    rerender(<Inspector chat={chatIn('chat-b', 'B')} {...props} />);
    expect(await screen.findByText('Beta goal')).toBeInTheDocument();

    release({ status: 'updated', memory: viewFor('A', 'Alpha').memory });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Beta goal')).toBeInTheDocument();
    expect(screen.queryByText('Alpha goal')).toBeNull();
    // B's panel is idle, not stuck on A's "Updating..." state.
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();

    m.save.mockResolvedValue({ ...viewFor('B', 'Beta'), memory: { ...viewFor('B', 'Beta').memory, updatedBy: 'user' } });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Project memory' })).toHaveValue(noteFor('Beta')));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(m.save).toHaveBeenCalledWith('B', noteFor('Beta'));
  });
});
