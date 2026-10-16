import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreview, ImportReport, ImportStatus } from '@otherbench/core/types/claude-import.js';
import type { Project } from '@otherbench/core/ports/store.js';
import type { Connection, Profile } from '@otherbench/core/types/config.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      claudeImport: { status: vi.fn(), preview: vi.fn(), start: vi.fn() },
      memory: { global: { saveAbout: vi.fn() } },
      projects: { list: vi.fn(async () => []) },
      chats: { list: vi.fn(async () => []) },
    },
  };
});

import { ApiError, api } from '../../state/api.js';
import { useOtherBenchStore } from '../../state/store.js';
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
    export: true,
    sources: ['conversations-000.zip: conversations.json'],
    chats: { total: 442, existing: 2, updates: 0, newer: 1, filed: 0, messages: 6267, branched: 24 },
    chatList: { found: false, url: 'https://claude.ai/api/organizations/org-1/chat_conversations' },
    cowork: null,
    emptyChats: 44,
    artifacts: [{ title: 'Flank Wear', versions: 2, existing: false }],
    projects: [
      { id: 'p1', name: 'Home Stuff', action: 'create', mergeInto: null, docs: 2, hasInstructions: true, hasMemory: true },
      { id: 'p2', name: 'PhD', action: 'merge', mergeInto: 'PhD', docs: 0, hasInstructions: false, hasMemory: true },
    ],
    projectsSkipped: 5,
    memory: { about: true, aboutTaken: false, note: true, projectNotes: 2, files: 49 },
    memoryModel: 'Claude Opus',
    memoryChat: { title: 'What claude.ai remembered', notes: 49, existing: false },
    filesNotIncluded: 672,
    dropped: {},
    importFolder: '/data/otherbench.db.imported/claude',
    ...over,
  };
}

function report(over: Partial<ImportReport> = {}): ImportReport {
  return {
    chats: { imported: 440, existing: 2, updated: 0, newer: 0, filed: 0, messages: 6200, failed: [] },
    cowork: null,
    emptyChats: 44,
    artifacts: { imported: 1, existing: 0, failed: [] },
    projects: { created: ['Home Stuff'], merged: ['PhD'], existing: [], failed: [], skipped: 5 },
    docs: { written: 2, folders: [{ project: 'Home Stuff', path: '/data/otherbench.db.imported/claude/Home Stuff-019f3c80', attached: true, workspace: false }] },
    fileErrors: [{ title: '/people/x.md', error: 'EACCES' }],
    memory: { model: 'Claude Opus', about: { status: 'drafted', text: 'I run a small company.' }, note: { status: 'failed', reason: 'cut off' }, projects: [] },
    memoryFiles: '/data/otherbench.db.imported/claude/memory',
    memoryChat: { title: 'What claude.ai remembered', notes: 49, imported: true },
    filesNotIncluded: 672,
    dropped: {},
    importFolder: '/data/otherbench.db.imported/claude',
    ...over,
  };
}

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({
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
    const { profiles, connections } = useOtherBenchStore.getState();
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
    expect(screen.getByRole('button', { name: 'Check Cowork sessions' })).toBeEnabled();
    await user.type(screen.getByLabelText('Export folder'), '/exports/claude');
    await user.click(screen.getByRole('button', { name: 'Check folder' }));

    expect(claudeImport.preview).toHaveBeenCalledWith('/exports/claude', 'opus');
    const panel = await screen.findByTestId('import-preview');
    expect(panel).toHaveTextContent('442 chats (6,267 messages, 24 with more than one branch); 2 already imported');
    expect(panel).toHaveTextContent('1 imported chat was carried on here, so its newer messages on claude.ai aren’t added');
    expect(panel).toHaveTextContent("About you is drafted from claude.ai's notes for you to read and accept.");
    expect(panel).toHaveTextContent('44 empty conversations left out');
    expect(panel).toHaveTextContent('1 published artifact, each in a chat of its own');
    expect(panel).toHaveTextContent('Project “Home Stuff”: new, 2 docs, instructions, memory');
    expect(panel).toHaveTextContent('Project “PhD”: merges into your project “PhD”, memory');
    expect(panel).toHaveTextContent("672 images and files aren’t in the export");
    expect(panel).toHaveTextContent('claude.ai’s 49 memory notes go into a chat of their own, “What claude.ai remembered”, which recall can search');
    expect(screen.getByLabelText('Profile for imported chats')).toHaveValue('opus');
    expect(screen.queryByRole('option', { name: 'Old' })).toBeNull();
    expect(screen.getByLabelText('Condense memory')).toBeChecked();
    expect(panel).toHaveTextContent("Condense claude.ai's memory into OtherBench's with Claude Opus");
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

    expect(claudeImport.start).toHaveBeenCalledWith({ folder: '/exports/claude', profileId: 'qwen', memory: false, cowork: false, spaces: {} });
    expect(await screen.findByRole('status')).toHaveTextContent('Importing chats… 10 of 451');
    expect(screen.queryByLabelText('Export folder')).toBeNull();

    status = { ...status, state: 'done', phase: null, done: 451, finishedAt: 2, report: report({ chats: { imported: 439, existing: 2, updated: 0, newer: 0, filed: 0, messages: 6200, failed: [{ title: 'Clash', error: 'UNIQUE constraint failed' }] } }) };
    const reportView = await screen.findByTestId('import-report', {}, { timeout: IMPORT_POLL_MS * 3 });
    expect(reportView).toHaveTextContent('Import finished');
    expect(reportView).toHaveTextContent('Imported 439 chats (6,200 messages); 2 were already here');
    expect(reportView).toHaveTextContent('New projects: Home Stuff');
    expect(reportView).toHaveTextContent('claude.ai’s 49 memory notes are in the chat “What claude.ai remembered”, which recall searches');
    expect(reportView).toHaveTextContent('Merged into your projects: PhD');
    expect(reportView).toHaveTextContent('Home Stuff’s docs are in /data/otherbench.db.imported/claude/Home Stuff-019f3c80, attached to the project read-only; its chats see them once the project or chat has a workspace folder');
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
    claudeImport.status.mockResolvedValue({ ...IDLE, state: 'failed', error: 'OtherBench was shut down during the import.', report: report() });
    render(<ImportPanel />);
    const view = await screen.findByTestId('import-report');
    expect(view).toHaveTextContent('The import stopped');
    expect(view).toHaveTextContent('OtherBench was shut down during the import.');
    await waitFor(() => expect(screen.getByLabelText('Export folder')).toBeInTheDocument());
  });
});

describe("ImportPanel: claude.ai's chat list and Cowork", () => {
  async function checkFolder(over: Partial<ImportPreview>) {
    claudeImport.preview.mockResolvedValue(preview(over));
    const user = userEvent.setup();
    render(<ImportPanel />);
    await user.type(screen.getByLabelText('Export folder'), '/exports/claude');
    await user.click(screen.getByRole('button', { name: 'Check folder' }));
    await screen.findByTestId('import-preview');
    return user;
  }

  it('says which imported chats get new messages, and counts them on the button', async () => {
    await checkFolder({ chats: { total: 442, existing: 442, updates: 3, newer: 0, filed: 0, messages: 6267, branched: 24 } });
    const panel = screen.getByTestId('import-preview');
    expect(panel).toHaveTextContent('3 imported chats get the messages added on claude.ai since');
    expect(panel).not.toHaveTextContent('carried on here');
    expect(screen.getByRole('button', { name: 'Update 3 chats' })).toBeEnabled();
  });

  it('says how to get the chat list when the folder has none, and how many chats it files when it has', async () => {
    await checkFolder({});
    expect(screen.getByTestId('chat-list-hint')).toHaveTextContent('open https://claude.ai/api/organizations/org-1/chat_conversations in a browser');
    cleanup();
    await checkFolder({ chatList: { found: true, url: null }, chats: { total: 442, existing: 0, updates: 0, newer: 0, filed: 300, messages: 6267, branched: 24 } });
    expect(screen.queryByTestId('chat-list-hint')).toBeNull();
    expect(screen.getByTestId('import-preview')).toHaveTextContent('300 chats filed into their projects, from claude.ai’s chat list');
  });

  it("imports the Cowork sessions when ticked, with each space's chosen project", async () => {
    useOtherBenchStore.setState({ projects: [{ id: 'proj-phd', name: 'PhD' } as Project, { id: 'proj-personal', name: 'Personal' } as Project] });
    claudeImport.start.mockResolvedValue({ ...IDLE, state: 'running', phase: 'projects', total: 10 });
    const user = await checkFolder({
      chats: { total: 2, existing: 0, updates: 0, newer: 0, filed: 0, messages: 4, branched: 0 },
      cowork: {
        sources: [{ path: 'C:/Users/a/AppData/Roaming/Claude/local-agent-mode-sessions', sessions: 29 }],
        sessions: 29,
        existing: 0,
        updates: 0,
        messages: 728,
        images: 73,
        spaces: [
          { id: 'space-biz', sessions: 7, titles: ['Finance Dept', 'Company Advisor'] },
          { id: 'space-phd', sessions: 5, titles: ['Chapter 1'] },
        ],
      },
    });
    const box = screen.getByLabelText('Import Cowork sessions');
    expect(box).not.toBeChecked();
    expect(screen.getByTestId('import-preview')).toHaveTextContent('Also import the 29 Cowork sessions');
    expect(screen.getByTestId('import-preview')).toHaveTextContent('728 messages and 73 images, from C:/Users/a/AppData/Roaming/Claude/local-agent-mode-sessions (29).');
    expect(screen.queryByLabelText('Project for the Cowork space with Finance Dept')).toBeNull();
    await user.click(box);
    expect(screen.getByTestId('import-preview')).toHaveTextContent('The space with “Finance Dept”, “Company Advisor” and 5 more goes into');
    await user.selectOptions(screen.getByLabelText('Project for the Cowork space with Finance Dept'), 'proj-personal');
    await user.selectOptions(screen.getByLabelText('Project for the Cowork space with Chapter 1'), 'proj-phd');
    await user.click(screen.getByRole('button', { name: 'Import 31 chats' }));
    expect(claudeImport.start).toHaveBeenCalledWith({ folder: '/exports/claude', profileId: 'opus', memory: true, cowork: true, spaces: { 'space-biz': 'proj-personal', 'space-phd': 'proj-phd' } });
  });

  it('checks just the Cowork sessions when the folder is left empty, ticked as they are all there is', async () => {
    const cowork = {
      sources: [
        { path: 'C:/Users/a/AppData/Roaming/Claude/local-agent-mode-sessions', sessions: 29 },
        { path: 'D:/laptop/local-agent-mode-sessions', sessions: 11 },
      ],
      sessions: 40,
      existing: 29,
      updates: 0,
      messages: 900,
      images: 80,
      spaces: [],
    };
    claudeImport.preview.mockResolvedValue(preview({ folder: '', export: false, chats: { total: 0, existing: 0, updates: 0, newer: 0, filed: 0, messages: 0, branched: 0 }, cowork, artifacts: [], projects: [], memoryChat: null, memory: { about: false, aboutTaken: false, note: false, projectNotes: 0, files: 0 } }));
    claudeImport.start.mockResolvedValue({ ...IDLE, state: 'running', phase: 'cowork', total: 40 });
    const user = userEvent.setup();
    render(<ImportPanel />);
    await user.click(screen.getByRole('button', { name: 'Check Cowork sessions' }));

    expect(claudeImport.preview).toHaveBeenCalledWith('', 'opus');
    const panel = await screen.findByTestId('import-preview');
    expect(panel).not.toHaveTextContent('0 chats');
    expect(screen.queryByTestId('chat-list-hint')).toBeNull();
    expect(panel).toHaveTextContent('Import the 40 Cowork sessions (29 already imported)');
    expect(panel).toHaveTextContent('from C:/Users/a/AppData/Roaming/Claude/local-agent-mode-sessions (29) and D:/laptop/local-agent-mode-sessions (11).');
    const box = screen.getByLabelText('Import Cowork sessions');
    expect(box).toBeChecked();
    await user.click(box);
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Import 11 chats' }));
    expect(claudeImport.start).toHaveBeenCalledWith({ folder: '', profileId: 'opus', memory: false, cowork: true, spaces: {} });
  });

  it('reloads the projects and chats once an import it watched ends, and reports the Cowork sessions', async () => {
    vi.mocked(api.projects.list).mockClear();
    vi.mocked(api.chats.list).mockClear();
    let status: ImportStatus = { ...IDLE, state: 'running', phase: 'cowork', done: 5, total: 10, startedAt: 1 };
    claudeImport.status.mockImplementation(async () => status);
    render(<ImportPanel />);
    await screen.findByRole('status');
    expect(api.projects.list).not.toHaveBeenCalled();
    status = { ...status, state: 'done', phase: null, done: 10, report: report({ chats: { imported: 2, existing: 0, updated: 0, newer: 0, filed: 1, messages: 4, failed: [] }, cowork: { imported: 29, existing: 0, updated: 0, filed: 12, messages: 728, images: 73, failed: [] } }) };
    const view = await screen.findByTestId('import-report', {}, { timeout: IMPORT_POLL_MS * 3 });
    expect(view).toHaveTextContent('Filed 1 chat into its project');
    expect(view).toHaveTextContent('Imported 29 Cowork sessions (728 messages, 73 images); 12 filed into projects');
    await waitFor(() => expect(api.projects.list).toHaveBeenCalled());
    expect(api.chats.list).toHaveBeenCalled();
  });
});
