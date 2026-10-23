import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      mediaWorkflows: { list: vi.fn(), detect: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      connections: { mediaModels: vi.fn() },
    },
  };
});

import { api, ApiError } from '../../state/api.js';
import { WorkflowsSection } from './WorkflowsSection.js';

const list = vi.mocked(api.mediaWorkflows.list);
const detect = vi.mocked(api.mediaWorkflows.detect);
const create = vi.mocked(api.mediaWorkflows.create);
const update = vi.mocked(api.mediaWorkflows.update);
const del = vi.mocked(api.mediaWorkflows.delete);
const mediaModels = vi.mocked(api.connections.mediaModels);

const builtin: MediaWorkflow = { id: 'builtin:sdxl-txt2img', name: 'SDXL text to image', media: 'image', graph: {}, bindings: {}, builtin: true };
const mine: MediaWorkflow = { id: 'w1', name: 'My flow', media: 'image', graph: {}, bindings: {}, builtin: false };

const graph = {
  '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, model: ['4', 0], positive: ['6', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'hello', clip: ['4', 1] } },
};

function file(content: string, name = 'flow.json'): File {
  return new File([content], name, { type: 'application/json' });
}

beforeEach(() => {
  list.mockReset().mockResolvedValue([builtin, mine]);
  detect.mockReset();
  create.mockReset();
  update.mockReset();
  del.mockReset();
  mediaModels.mockReset().mockResolvedValue({ models: [], checkpoints: ['a.safetensors', 'b.safetensors'] });
});
afterEach(cleanup);

describe('WorkflowsSection', () => {
  it("edits an imported workflow's name, bindings and model file through PATCH; built-in ones have no Edit", async () => {
    const imported: MediaWorkflow = {
      id: 'w2', name: 'Imported', media: 'image', graph, builtin: false, checkpoint: 'a.safetensors',
      bindings: { prompt: { nodeId: '6', input: 'text' }, seed: { nodeId: '3', input: 'seed' }, checkpoint: { nodeId: '4', input: 'ckpt_name' } },
    };
    list.mockResolvedValue([builtin, imported]);
    update.mockResolvedValue(imported);
    const user = userEvent.setup();
    render(<WorkflowsSection connectionId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit workflow Imported' }));
    expect(screen.queryByRole('button', { name: 'Edit workflow SDXL text to image' })).toBeNull();
    expect(screen.getByLabelText('Workflow name')).toHaveValue('Imported');
    expect(screen.getByLabelText('Input for Seed')).toHaveDisplayValue('3 · KSampler · seed');
    await waitFor(() => expect(screen.getByLabelText('Model file')).toHaveValue('a.safetensors'));
    await user.clear(screen.getByLabelText('Workflow name'));
    await user.type(screen.getByLabelText('Workflow name'), 'Renamed');
    await user.selectOptions(screen.getByLabelText('Input for Seed'), '');
    await user.selectOptions(screen.getByLabelText('Model file'), 'b.safetensors');
    await user.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('w2', {
        name: 'Renamed',
        media: 'image',
        bindings: { prompt: { nodeId: '6', input: 'text' }, checkpoint: { nodeId: '4', input: 'ckpt_name' } },
        checkpoint: 'b.safetensors',
      }),
    );
    expect(create).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('workflow-review')).toBeNull());
  });

  it("clears an imported workflow's model file back to its own with null", async () => {
    const imported: MediaWorkflow = {
      id: 'w2', name: 'Imported', media: 'image', graph, builtin: false, checkpoint: 'a.safetensors',
      bindings: { prompt: { nodeId: '6', input: 'text' }, checkpoint: { nodeId: '4', input: 'ckpt_name' } },
    };
    list.mockResolvedValue([imported]);
    update.mockResolvedValue(imported);
    const user = userEvent.setup();
    render(<WorkflowsSection connectionId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit workflow Imported' }));
    await waitFor(() => expect(screen.getByLabelText('Model file')).toHaveValue('a.safetensors'));
    await user.selectOptions(screen.getByLabelText('Model file'), '');
    await user.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('w2', expect.objectContaining({ checkpoint: null })));
  });

  it('lists workflows, with Delete only on imported ones', async () => {
    render(<WorkflowsSection connectionId="c1" />);
    expect(await screen.findByText('SDXL text to image')).toBeInTheDocument();
    expect(screen.getByText('built in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete workflow SDXL text to image' })).toBeNull();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    del.mockResolvedValue(undefined);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete workflow My flow' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('w1'));
  });

  it("shows the server's Export (API) message for a UI-format file", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    detect.mockRejectedValue(new ApiError(400, "That's the UI format. In ComfyUI use Workflow → Export (API)."));
    render(<WorkflowsSection connectionId="c1" />);
    await userEvent.setup().upload(await screen.findByLabelText('Import workflow file'), file(JSON.stringify({ nodes: [] })));
    expect(await screen.findByText(/Export \(API\)\./)).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-review')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a file that is not JSON', async () => {
    render(<WorkflowsSection connectionId="c1" />);
    await userEvent.setup().upload(await screen.findByLabelText('Import workflow file'), file('not json'));
    expect(await screen.findByText("That file isn't valid JSON.")).toBeInTheDocument();
    expect(detect).not.toHaveBeenCalled();
  });

  it('shows the detected bindings for confirmation and saves only on Save', async () => {
    detect.mockResolvedValue({ bindings: { prompt: { nodeId: '6', input: 'text' }, seed: { nodeId: '3', input: 'seed' }, checkpoint: { nodeId: '4', input: 'ckpt_name' } }, problem: null });
    create.mockResolvedValue(mine);
    const user = userEvent.setup();
    render(<WorkflowsSection connectionId="c1" />);
    await user.upload(await screen.findByLabelText('Import workflow file'), file(JSON.stringify(graph), 'portrait.json'));

    const review = await screen.findByTestId('workflow-review');
    expect(review).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Workflow name')).toHaveValue('portrait');
    const promptSelect = screen.getByLabelText('Input for Prompt') as HTMLSelectElement;
    expect(promptSelect.selectedOptions[0]?.textContent).toBe('6 · CLIPTextEncode · text');
    // Wired inputs are not offered.
    expect(screen.queryByRole('option', { name: /· model$/ })).toBeNull();

    await user.selectOptions(await screen.findByLabelText('Model file'), 'b.safetensors');
    await user.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'portrait',
        media: 'image',
        graph,
        bindings: { prompt: { nodeId: '6', input: 'text' }, seed: { nodeId: '3', input: 'seed' }, checkpoint: { nodeId: '4', input: 'ckpt_name' } },
        checkpoint: 'b.safetensors',
      })
    );
  });

  it('lets a role be changed or cleared before saving', async () => {
    detect.mockResolvedValue({ bindings: { prompt: { nodeId: '6', input: 'text' }, seed: { nodeId: '3', input: 'seed' } }, problem: null });
    create.mockResolvedValue(mine);
    const user = userEvent.setup();
    render(<WorkflowsSection connectionId="c1" />);
    await user.upload(await screen.findByLabelText('Import workflow file'), file(JSON.stringify(graph)));
    await screen.findByTestId('workflow-review');
    await user.selectOptions(screen.getByLabelText('Input for Seed'), '');
    await user.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ bindings: { prompt: { nodeId: '6', input: 'text' } } })));
  });

  it("shows the server's reason when saving is refused, and the muted checkpoints note", async () => {
    mediaModels.mockResolvedValue({ models: [], checkpoints: [], checkpointsError: 'ComfyUI is not reachable.' });
    detect.mockResolvedValue({ bindings: { prompt: { nodeId: '6', input: 'text' }, checkpoint: { nodeId: '4', input: 'ckpt_name' } }, problem: null });
    create.mockRejectedValue(new ApiError(400, 'No input is marked as the prompt.'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<WorkflowsSection connectionId="c1" />);
    await user.upload(await screen.findByLabelText('Import workflow file'), file(JSON.stringify(graph)));
    expect(await screen.findByText('ComfyUI is not reachable.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save workflow' }));
    expect(await screen.findByText('No input is marked as the prompt.')).toBeInTheDocument();
  });
});
