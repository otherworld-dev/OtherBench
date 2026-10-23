import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../state/api.js';
import { GenerationCard } from './GenerationCard.js';

const ask = {
  kind: 'generation' as const,
  toolName: 'generate_image',
  media: 'image' as const,
  prompt: 'a lighthouse at dusk',
  negativePrompt: 'blurry' as string | null,
  settings: '1024×1024 · seed 42 · SDXL (ComfyUI)',
  id: 'g1',
  chatId: 'c1',
  messageId: 'm1',
};

describe('GenerationCard', () => {
  afterEach(cleanup);

  it('shows the heading, prompt, negative prompt and settings', () => {
    render(<GenerationCard ask={ask} profileName="Sonnet" onAnswer={vi.fn(async () => {})} />);
    expect(screen.getByText('Sonnet wants to generate an image')).toBeInTheDocument();
    expect(screen.getByText('a lighthouse at dusk')).toBeInTheDocument();
    expect(screen.getByText('blurry')).toBeInTheDocument();
    expect(screen.getByText('1024×1024 · seed 42 · SDXL (ComfyUI)')).toBeInTheDocument();
    expect(screen.getByTestId('ask-card-g1')).toHaveAttribute('data-kind', 'generation');
  });

  it('says "a video" for video and omits the negative prompt when unset', () => {
    render(<GenerationCard ask={{ ...ask, media: 'video', negativePrompt: null }} profileName="Sonnet" onAnswer={vi.fn(async () => {})} />);
    expect(screen.getByText('Sonnet wants to generate a video')).toBeInTheDocument();
    expect(screen.queryByText('Negative prompt')).toBeNull();
  });

  it('Generate sends the prompt unchanged', async () => {
    const onAnswer = vi.fn(async () => {});
    render(<GenerationCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Generate' }));
    expect(onAnswer).toHaveBeenCalledWith('g1', { generate: { prompt: 'a lighthouse at dusk', negativePrompt: 'blurry' } });
  });

  it('Edit turns the prompt into a textarea; Generate is disabled while blank and sends the edit', async () => {
    const onAnswer = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<GenerationCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Prompt' });
    expect(box).toHaveAttribute('maxlength', '4000');
    await user.clear(box);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await user.type(box, 'a red barn');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onAnswer).toHaveBeenCalledWith('g1', { generate: { prompt: 'a red barn', negativePrompt: 'blurry' } });
  });

  it('Cancel declines', async () => {
    const onAnswer = vi.fn(async () => {});
    render(<GenerationCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAnswer).toHaveBeenCalledWith('g1', { declined: true });
  });

  it("shows the server's reason on a 400", async () => {
    const onAnswer = vi.fn(async () => {
      throw new ApiError(400, 'A prompt can be at most 4000 characters.');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<GenerationCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('A prompt can be at most 4000 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });
});
