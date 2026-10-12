import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactVersion } from '@grunt/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/api.js')>()),
  api: { artifacts: { get: vi.fn(), version: vi.fn(), edit: vi.fn(), save: vi.fn(), live: { status: vi.fn(), allow: vi.fn(), revoke: vi.fn(), call: vi.fn() } }, view: { openArtifact: vi.fn() } },
}));

vi.mock('../lib/saveFile.js', () => ({ saveFile: vi.fn() }));

import { saveFile } from '../lib/saveFile.js';
import { ApiError, api, type ArtifactDetail } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { ArtifactView } from './ArtifactView.js';

const version = (id: string, number: number, content: string, madeBy: 'model' | 'user' = 'model', kind: ArtifactVersion['kind'] = 'html'): ArtifactVersion => ({
  id, artifactId: 'art', number, title: 'Calc', content, kind, language: kind === 'code' ? 'ts' : null, live: null, madeBy, messageId: 'm', parentVersionId: null, createdAt: number,
});
const detail = (kind: 'html' | 'markdown' | 'code' = 'html'): ArtifactDetail => {
  const fileName = kind === 'html' ? 'calc.html' : kind === 'markdown' ? 'calc.md' : 'calc.ts';
  const each = { title: 'Calc', madeBy: 'model' as const, kind, language: kind === 'code' ? 'ts' : null, fileName, live: 0 };
  return {
    artifact: { id: 'art', chatId: 'c1', slug: 'calc', kind, language: kind === 'code' ? 'ts' : null, createdAt: 1 },
    fileName,
    currentVersionId: 'v2',
    versions: [
      { ...each, id: 'v1', number: 1, createdAt: 1, onBranch: true },
      { ...each, id: 'v2', number: 2, createdAt: 2, onBranch: true },
      { ...each, id: 'v9', number: 3, createdAt: 3, onBranch: false },
    ],
  };
};
const item = { kind: 'artifact' as const, artifactId: 'art', title: 'Calc' };

beforeEach(() => {
  vi.mocked(api.artifacts.get).mockReset().mockResolvedValue(detail());
  vi.mocked(api.artifacts.version).mockReset().mockImplementation(async (_c, _a, id) => version(id, id === 'v1' ? 1 : 2, `<p>${id}</p>`));
  vi.mocked(api.view.openArtifact).mockReset().mockImplementation(async (_c, id) => ({ path: '', name: 'calc.html', kind: 'html', url: `/view/x-${id}/calc.html`, size: 1 }));
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ chats: [{ id: 'c1', workspaceStatus: { status: 'ok', root: 'C:\\ws' } } as never] });
});
afterEach(cleanup);

describe('ArtifactView', () => {
  it('picks up a change the reply makes as it streams, with the head on your message as an ordinary send leaves it', async () => {
    const reply = (parts: unknown[], status = 'streaming') => ({ id: 'r1', chatId: 'c1', parentId: 'u1', role: 'assistant', parts, status, error: null, producedBy: null, createdAt: 2 });
    const mine = { id: 'u1', chatId: 'c1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'make it blue' }], status: 'complete', error: null, producedBy: null, createdAt: 1 };
    useGruntStore.setState({ chats: [{ id: 'c1', headMessageId: 'u1', workspaceStatus: { status: 'ok', root: 'C:\\ws' } } as never], messages: { u1: mine, r1: reply([]) } as never });
    render(<ArtifactView chatId="c1" item={item} />);
    await screen.findByTitle('calc.html');
    vi.mocked(api.artifacts.get).mockResolvedValue({ ...detail(), currentVersionId: 'v1' });
    act(() => useGruntStore.setState({ messages: { u1: mine, r1: reply([{ type: 'tool-result', id: 'a', name: 'artifact', result: '{}', isError: false }]) } as never }));
    await waitFor(() => expect(screen.getByTitle('calc.html')).toHaveAttribute('src', '/view/x-v1/calc.html'));
  });

  it("recovers from a failed load on the next change, e.g. a version that hadn't synced yet", async () => {
    const mine = { id: 'u1', chatId: 'c1', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 1 };
    useGruntStore.setState({ chats: [{ id: 'c1', headMessageId: 'u1', workspaceStatus: { status: 'ok', root: 'C:\\ws' } } as never], messages: { u1: mine } as never });
    vi.mocked(api.artifacts.get).mockRejectedValueOnce(new ApiError(404, 'Artifact not found in this chat.'));
    render(<ArtifactView chatId="c1" item={item} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Artifact not found in this chat.');
    act(() => useGruntStore.setState({ messages: { u1: mine, r1: { ...mine, id: 'r1', parentId: 'u1', role: 'assistant', createdAt: 2 } } as never }));
    expect(await screen.findByTitle('calc.html')).toHaveAttribute('src', '/view/x-v2/calc.html');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("shows the branch's current version in the sandbox, and switches versions, other branches included", async () => {
    render(<ArtifactView chatId="c1" item={item} />);
    const frame = await screen.findByTitle('calc.html');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    expect(frame).toHaveAttribute('src', '/view/x-v2/calc.html');
    const picker = screen.getByRole('combobox', { name: 'Version' });
    expect(screen.getByRole('option', { name: 'v3 (other branch)' })).toBeInTheDocument();
    await userEvent.setup().selectOptions(picker, 'v1');
    await waitFor(() => expect(screen.getByTitle('calc.html')).toHaveAttribute('src', '/view/x-v1/calc.html'));
  });

  it("follows the branch when no version is pinned: a new head reloads it, in the panel or a popped-out tab", async () => {
    render(<ArtifactView chatId="c1" item={item} />);
    await screen.findByTitle('calc.html');
    vi.mocked(api.artifacts.get).mockResolvedValue({ ...detail(), currentVersionId: 'v1' });
    act(() => useGruntStore.setState({ chats: [{ id: 'c1', headMessageId: 'other-branch', workspaceStatus: { status: 'ok', root: 'C:\\ws' } } as never] }));
    await waitFor(() => expect(screen.getByTitle('calc.html')).toHaveAttribute('src', '/view/x-v1/calc.html'));
  });

  it('shows each version as its own kind, and downloads it under its own name: v1 a note, v2 a page made from it', async () => {
    const both = detail('markdown');
    vi.mocked(api.artifacts.get).mockResolvedValue({
      ...both,
      fileName: 'calc.html',
      versions: [
        { ...both.versions[0]!, kind: 'markdown', fileName: 'calc.md' },
        { ...both.versions[1]!, kind: 'html', fileName: 'calc.html' },
      ],
    });
    vi.mocked(api.artifacts.version).mockImplementation(async (_c, _a, id) => (id === 'v1' ? version('v1', 1, '# Note', 'model', 'markdown') : version('v2', 2, '<p>page</p>')));
    const user = userEvent.setup();
    render(<ArtifactView chatId="c1" item={item} />);
    expect(await screen.findByTitle('calc.html')).toHaveAttribute('src', '/view/x-v2/calc.html');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Version' }), 'v1');
    expect(await screen.findByRole('heading', { name: 'Note' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(saveFile).toHaveBeenLastCalledWith(expect.any(Blob), 'calc.md');
  });

  it('shows Markdown formatted and code highlighted, each with its source', async () => {
    vi.mocked(api.artifacts.get).mockResolvedValue(detail('markdown'));
    vi.mocked(api.artifacts.version).mockResolvedValue(version('v2', 2, '# Heading'));
    render(<ArtifactView chatId="c1" item={item} />);
    expect(await screen.findByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Source' }));
    await waitFor(() => expect(document.querySelector('pre code')?.textContent).toBe('# Heading'));
  });

  it('saves your edit as a new version and shows it', async () => {
    vi.mocked(api.artifacts.edit).mockResolvedValue(version('v4', 4, '<p>mine</p>', 'user'));
    const user = userEvent.setup();
    render(<ArtifactView chatId="c1" item={item} />);
    await screen.findByTitle('calc.html');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Artifact source' });
    await waitFor(() => expect(box).toHaveValue('<p>v2</p>'));
    await user.clear(box);
    await user.type(box, '<p>mine</p>');
    vi.mocked(api.artifacts.get).mockResolvedValue({ ...detail(), currentVersionId: 'v4', versions: [...detail().versions, { id: 'v4', number: 4, title: 'Calc', madeBy: 'user', createdAt: 4, onBranch: true, kind: 'html', language: null, fileName: 'calc.html', live: 0 }] });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.artifacts.edit).toHaveBeenCalledWith('c1', 'art', { content: '<p>mine</p>', fromVersionId: 'v2' });
    await waitFor(() => expect(screen.getByTitle('calc.html')).toHaveAttribute('src', '/view/x-v4/calc.html'));
  });

  it('copies, downloads, and saves to the workspace, asking before it replaces a file', async () => {
    const user = userEvent.setup();
    render(<ArtifactView chatId="c1" item={item} />);
    await screen.findByTitle('calc.html');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('<p>v2</p>');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), 'calc.html');

    vi.mocked(api.artifacts.save).mockRejectedValueOnce(new ApiError(409, 'C:\\ws\\calc.html already exists.')).mockResolvedValueOnce({ path: 'C:\\ws\\calc.html' });
    await user.click(screen.getByRole('button', { name: 'Save to workspace' }));
    expect(screen.getByRole('textbox', { name: 'Save as' })).toHaveValue('calc.html');
    await user.click(screen.getByRole('button', { name: 'Save file' }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace it' }));
    expect(api.artifacts.save).toHaveBeenLastCalledWith('c1', 'art', { versionId: 'v2', path: 'calc.html', replace: true });
    expect(await screen.findByText('Saved to C:\\ws\\calc.html')).toBeInTheDocument();
  });

  it("offers no Save to workspace when the chat's folder isn't on this machine", async () => {
    useGruntStore.setState({ chats: [{ id: 'c1', workspaceStatus: { status: 'unresolved', reason: 'other-machine' } } as never] });
    render(<ArtifactView chatId="c1" item={item} />);
    await screen.findByTitle('calc.html');
    expect(screen.queryByRole('button', { name: 'Save to workspace' })).toBeNull();
  });
});
