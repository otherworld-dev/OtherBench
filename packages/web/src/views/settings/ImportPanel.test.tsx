import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreview, ImportReport, ImportStatus } from '@grunt/core/types/claude-import.js';
import type { Connection, Profile } from '@grunt/core/types/config.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { claudeImport: { status: vi.fn(), preview: vi.fn(), start: vi.fn() }, memory: { global: { saveAbout: vi.fn() } } } };
});

import { ApiError, api } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';
import { defaultImportProfileId, IMPORT_POLL_MS, ImportPanel } from './ImportPanel.js';

const claudeImport = vi.mocked(api.claudeImport);

function profile(id: string, name: string, connectionId: string, over: Partial<Profile> = {}): Profile {
  return {
    id,
    name,
    description: null,
    colour: null,
    connectionId,
    modelId: 'm',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...over,
  };
}

function connection(id: string, kind: Connection['kind']): Connection {
  return { id, name: id, kind, baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };
}

const IDLE: ImportStatus = { state: 'idle', phase: null, done: 0, total: 0, startedAt: null, finishedAt: null, report: null, error: null };

function preview(over: Partial<ImportPreview> = {}): ImportPreview {
  return {
    folder: '/exports/claude',
    sources: ['conversations-000.zip: conversations.json'],
    chats: { total: 442, existing: 2, newer: 1, messages: 6267, branched: 24 },
    emptyChats: 44,
    artifacts: [{ title: 'Flank Wear', versions: 2, existing: false }],
    projects: [
      { id: 'p1', name: 'Home Stuff', action: 'create', mergeInto: null, docs: 2, hasInstructions: true, hasMemory: true },
      { id: 'p2', name: 'PhD', action: 'merge', mergeInto: 'PhD', docs: 0, hasInstructions: false, hasMemory: true },
    ],
    projectsSkipped: 5,
    memory: { about: true, aboutTaken: false, note: true, projectNotes: 2, files: 49 },
    memoryModel: 'Claude Opus',
    filesNotIncluded: 672,
    dropped: {},
    importFolder: '/data/grunt.db.imported/claude',
    ...over,
  };
}

function report(over: Partial<ImportReport> = {}): ImportReport {
  return {
    chats: { imported: 440, existing: 2, newer: 0, messages: 6200, failed: [] },
    emptyChats: 44,
    artifacts: { imported: 1, existing: 0, failed: [] },
    projects: { created: ['Home Stuff'], merged: ['PhD'], existing: [], failed: [], skipped: 5 },
    docs: { written: 2, folders: [{ project: 'Home Stuff', path: '/data/grunt.db.imported/claude/Home Stuff-019f3c80', attached: true, workspace: false }] },
    fileErrors: [{ title: '/people/x.md', error: 'EACCES' }],
    memory: { model: 'Claude Opus', about: { status: 'drafted', text: 'I run a small company.' }, note: { status: 'failed', reason: 'cut off' }, projects: [] },
    memoryFiles: '/data/grunt.db.imported/claude/memory',
    filesNotIncluded: 672,
    dropped: {},
    importFolder: '/data/grunt.db.imported/claude',
    ...over,
  };
}

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({
    connections: [connection('ollama', 'ollama'), connection('cc', 'claude_code')],
    profiles: [profile('qwen', 'Qwen', 'ollama', { isDefault: true }), profile('opus', 'Claude Opus', 'cc'), profile('old', 'Old', 'cc', { archivedAt: 1 })],
  });
  for (const fn of Object.values(claudeImport)) fn.mockReset();
  claudeImport.status.mockResolvedValue(IDLE);
  claudeImport.preview.mockResolvedValue(preview());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('defaultImportProfileId', () => {
  it('prefers a Claude profile, then the default, then the first live one', () => {
    const { profiles, connections } = useGruntStore.getState();
    expect(defaultImportProfileId(profiles, connections)).toBe('opus');
    expect(defaultImportProfileId(profiles.filter((p) => p.id !== 'opus'), connections)).toBe('qwen');
    expect(defaultImportProfileId([profile('x', 'X', 'ollama')], connections)).toBe('x');
    expect(defaultImportProfileId([], connections)).toBe('');
  });
});

describe('ImportPanel', () => {
  it('checks a folder and shows what the import would do', async () => {
    const user = userEvent.setup();
    render(<ImportPanel />);
    expect(screen.getByRole('button', { name: 'Check folder' })).toBeDisabled();
    await user.type(screen.getByLabelText('Export folder'), '/exports/claude');
    await user.click(screen.getByRole('button', { name: 'Check folder' }));

    expect(claudeImport.preview).toHaveBeenCalledWith('/exports/claude', 'opus');
    const panel = await screen.findByTestId('import-preview');
    expect(panel).toHaveTextContent('442 chats (6,267 messages, 24 with more than one branch); 2 already imported, which will be skipped');
    expect(panel).toHaveTextContent('1 imported chat has newer messages on claude.ai, which a second import doesn’t add');
    expect(panel).toHaveTextContent("About you is drafted from claude.ai's notes for you to read and accept.");
    expect(panel).toHaveTextContent('44 empty conversations left out');
    expect(panel).toHaveTextContent('1 published artifact, each in a chat of its own');
    expect(panel).toHaveTextContent('Project “Home Stuff”: new, 2 docs, instructions, memory');
    expect(panel).toHaveTextContent('Project “PhD”: merges into your project “PhD”, memory');
    expect(panel).toHaveTextContent("672 images and files aren’t in the export");
    expect(screen.getByLabelText('Profile for imported chats')).toHaveValue('opus');
    expect(screen.queryByRole('option', { name: 'Old' })).toBeNull();
    expect(screen.getByLabelText('Condense memory')).toBeChecked();
    expect(panel).toHaveTextContent("Condense claude.ai's memory into Grunt's with Claude Opus");
    expect(screen.getByRole('button', { name: 'Import 440 chats' })).toBeEnabled();
  });

  it('shows the reason when the folder can’t be read', async () => {
    claudeImport.preview.mockRejectedValue(new ApiError(400, "There's no conversations.json in /x."));
    const user = userEvent.setup();
    render(<ImportPanel />);
    await user.type(screen.getByLabelText('Export folder'), '/x');
    await user.click(screen.getByRole('button', { name: 'Check folder' }));
    expect(await screen.findByTestId('import-error')).toHaveTextContent("There's no conversations.json in /x.");
    expect(screen.queryByTestId('import-preview')).toBeNull();
  });

  it('turns memory off, and says why, when no model can condense it', async () => {
    claudeImport.preview.mockResolvedValue(preview({ memoryModel: null }));
    const user = userEvent.setup();
    render(<ImportPanel />);
    await user.type(screen.getByLabelText('Export folder'), '/exports/claude');
    await user.click(screen.getByRole('button', { name: 'Check folder' }));
    const box = await screen.findByLabelText('Condense memory');
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.getByText(/No model can do this/)).toBeInTheDocument();
  });

  it('starts the import with the chosen profile and memory setting, then follows it to the report', async () => {
    let status: ImportStatus = { ...IDLE, state: 'running', phase: 'chats', done: 10, total: 451, startedAt: 1 };
    claudeImport.start.mockImplementation(async () => status);
    claudeImport.status.mockResolvedValueOnce(IDLE).mockImplementation(async () => status);
    const user = userEvent.setup();
    render(<ImportPanel />);
    await user.type(screen.getByLabelText('Export folder'), '/exports/claude');
    await user.click(screen.getByRole('button', { name: 'Check folder' }));
    await screen.findByTestId('import-preview');
    await user.selectOptions(screen.getByLabelText('Profile for imported chats'), 'qwen');
    await user.click(screen.getByLabelText('Condense memory'));
    await user.click(screen.getByRole('button', { name: 'Import 440 chats' }));

    expect(claudeImport.start).toHaveBeenCalledWith({ folder: '/exports/claude', profileId: 'qwen', memory: false });
    expect(await screen.findByRole('status')).toHaveTextContent('Importing chats… 10 of 451');
    expect(screen.queryByLabelText('Export folder')).toBeNull();

    status = { ...status, state: 'done', phase: null, done: 451, finishedAt: 2, report: report({ chats: { imported: 439, existing: 2, newer: 0, messages: 6200, failed: [{ title: 'Clash', error: 'UNIQUE constraint failed' }] } }) };
    const reportView = await screen.findByTestId('import-report', {}, { timeout: IMPORT_POLL_MS * 3 });
    expect(reportView).toHaveTextContent('Import finished');
    expect(reportView).toHaveTextContent('Imported 439 chats (6,200 messages); 2 were already here');
    expect(reportView).toHaveTextContent('New projects: Home Stuff');
    expect(reportView).toHaveTextContent('Merged into your projects: PhD');
    expect(reportView).toHaveTextContent('Home Stuff’s docs are in /data/grunt.db.imported/claude/Home Stuff-019f3c80, attached to the project read-only; its chats see them once the project or chat has a workspace folder');
    expect(reportView).toHaveTextContent('Memory (with Claude Opus): About you drafted, below; learned note failed: cut off');
    expect(screen.getByRole('alert')).toHaveTextContent('Clash: UNIQUE constraint failed');
    expect(screen.getByRole('alert')).toHaveTextContent('/people/x.md: EACCES');

    // The drafted About you is saved only when the user chooses to.
    expect(api.memory.global.saveAbout).not.toHaveBeenCalled();
    expect(screen.getByTestId('about-draft')).toHaveTextContent('I run a small company.');
    vi.mocked(api.memory.global.saveAbout).mockResolvedValue({} as never);
    await user.click(screen.getByRole('button', { name: 'Save as About you' }));
    expect(api.memory.global.saveAbout).toHaveBeenCalledWith('I run a small company.');
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('shows a running import it finds when opened', async () => {
    claudeImport.status.mockResolvedValue({ ...IDLE, state: 'running', phase: 'memory', done: 450, total: 451, startedAt: 1 });
    render(<ImportPanel />);
    expect(await screen.findByRole('status')).toHaveTextContent('Condensing memory… 450 of 451');
    await act(async () => {});
    expect(screen.queryByLabelText('Export folder')).toBeNull();
  });

  it('shows why a failed import stopped', async () => {
    claudeImport.status.mockResolvedValue({ ...IDLE, state: 'failed', error: 'Grunt was shut down during the import.', report: report() });
    render(<ImportPanel />);
    const view = await screen.findByTestId('import-report');
    expect(view).toHaveTextContent('The import stopped');
    expect(view).toHaveTextContent('Grunt was shut down during the import.');
    await waitFor(() => expect(screen.getByLabelText('Export folder')).toBeInTheDocument());
  });
});
