import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTransport } from '../state/transport.js';
import { GeneratedMedia, GenerationProgress } from './GeneratedMedia.js';

const scope = { chatId: 'c1', messageId: 'm1' };
const line = 'Generated an image with prompt: "a barn"; negative: none; seed 7; 1024×1024; SDXL.';
const image = [
  { type: 'text', text: line },
  { type: 'image', attachmentId: 'a1', mimeType: 'image/png' },
];
const video = [
  { type: 'text', text: 'Generated a video with prompt: "waves"; seed 3; 832×480; Wan 2.2.' },
  { type: 'video', attachmentId: 'v1', mimeType: 'video/mp4' },
];

afterEach(() => {
  cleanup();
  configureTransport({ baseUrl: '', token: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GeneratedMedia', () => {
  it('shows an image through the scoped route, with the result line and a Download link', () => {
    render(<GeneratedMedia result={image} scope={scope} />);
    const img = screen.getByTestId('generated-image');
    expect(img.getAttribute('src')).toBe('/api/chats/c1/messages/m1/tool-images/a1');
    expect(img.className).toContain('max-h-[28rem]');
    expect(screen.getByText(line)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', '/api/chats/c1/messages/m1/tool-images/a1');
    expect(link).toHaveAttribute('download', 'generated-image.png');
  });

  it('opens the image full size on click and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<GeneratedMedia result={image} scope={scope} />);
    await user.click(screen.getByTestId('generated-image'));
    expect(screen.getByTestId('image-lightbox-full')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('keeps Escape to itself, so a Quick Chat window stays open', async () => {
    const user = userEvent.setup();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    try {
      render(<GeneratedMedia result={image} scope={scope} />);
      await user.click(screen.getByTestId('generated-image'));
      await user.keyboard('{Escape}');
      expect(screen.queryByTestId('image-lightbox')).toBeNull();
      expect(outside).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outside);
    }
  });

  it('moves focus into the dialog when it opens and back to the image when it closes', async () => {
    const user = userEvent.setup();
    render(<GeneratedMedia result={image} scope={scope} />);
    const trigger = screen.getByRole('button', { name: 'View full size' });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('shows a video with controls', () => {
    render(<GeneratedMedia result={video} scope={scope} />);
    const el = screen.getByTestId('generated-video') as HTMLVideoElement;
    expect(el.controls).toBe(true);
    expect(el.getAttribute('src')).toBe('/api/chats/c1/messages/m1/tool-images/v1');
    expect(screen.getByText(/Generated a video/)).toBeInTheDocument();
  });

  it('with a token, loads the video through an object URL and revokes it on unmount', async () => {
    configureTransport({ baseUrl: 'http://127.0.0.1:5000', token: 'tok' });
    const fetchSpy = vi.fn(async () => new Response(new Blob(['mp4'], { type: 'video/mp4' })));
    vi.stubGlobal('fetch', fetchSpy);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:vid-1'), revokeObjectURL }));
    const { unmount } = render(<GeneratedMedia result={video} scope={scope} />);
    await waitFor(() => expect(screen.getByTestId('generated-video').getAttribute('src')).toBe('blob:vid-1'));
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:vid-1');
  });

  it('never shows an unstored media item as data', () => {
    render(<GeneratedMedia result={[{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]} scope={scope} />);
    expect(screen.queryByTestId('generated-image')).toBeNull();
    expect(screen.queryByText('AAAA')).toBeNull();
  });
});

describe('GenerationProgress', () => {
  it('shows the step count and a progress bar', () => {
    render(<GenerationProgress progress={{ stage: 'generating', step: 12, steps: 30 }} />);
    expect(screen.getByText('Generating… step 12 of 30')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('value', '12');
    expect(bar).toHaveAttribute('max', '30');
  });

  it('says Queued', () => {
    render(<GenerationProgress progress={{ stage: 'queued' }} />);
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('counts elapsed time when no steps are known', () => {
    vi.useFakeTimers();
    render(<GenerationProgress progress={{ stage: 'generating' }} />);
    expect(screen.getByText('Generating… 0:00')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(42_000);
    });
    expect(screen.getByText('Generating… 0:42')).toBeInTheDocument();
  });

  it('counts elapsed time before any progress arrives', () => {
    render(<GenerationProgress />);
    expect(screen.getByText('Generating… 0:00')).toBeInTheDocument();
  });
});
