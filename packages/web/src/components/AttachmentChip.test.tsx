import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentChip } from './AttachmentChip.js';

describe('AttachmentChip', () => {
  afterEach(cleanup);

  it('shows the filename and a formatted size', () => {
    render(<AttachmentChip filename="notes.txt" mime="text/plain" size={2048} />);
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('renders no remove button when onRemove is omitted', () => {
    render(<AttachmentChip filename="notes.txt" mime="text/plain" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onRemove when the remove button is clicked', async () => {
    let removed = false;
    const user = userEvent.setup();
    render(<AttachmentChip filename="notes.txt" mime="text/plain" onRemove={() => (removed = true)} />);

    await user.click(screen.getByRole('button', { name: /remove notes.txt/i }));
    expect(removed).toBe(true);
  });

  it('disables (but still renders) the remove button when removeDisabled is true, and a click does not call onRemove', async () => {
    let removed = false;
    const user = userEvent.setup();
    render(<AttachmentChip filename="notes.txt" mime="text/plain" onRemove={() => (removed = true)} removeDisabled />);

    const button = screen.getByRole('button', { name: /remove notes.txt/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(removed).toBe(false);
  });

  it('renders a thumbnail for an image with a previewUrl, and a generic icon otherwise', () => {
    // The thumbnail is decorative (the filename text already conveys what
    // it is), so it's `alt=""` -- which the accessibility tree reports as
    // role "presentation", not "img". Queried by tag instead of role here.
    const { container, rerender } = render(<AttachmentChip filename="photo.png" mime="image/png" previewUrl="/api/attachments/1/content" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/attachments/1/content');

    rerender(<AttachmentChip filename="report.pdf" mime="application/pdf" />);
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('opens an image attachment full size, over the whole window, and closes on Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(<AttachmentChip filename="photo.png" mime="image/png" previewUrl="/api/attachments/1/content" />);

    await user.click(screen.getByRole('button', { name: 'Preview photo.png' }));
    expect(screen.getByTestId('image-lightbox-full')).toHaveAttribute('src', '/api/attachments/1/content');
    // Portalled: a chip sits in the composer, a message or a note, and none of their stacking contexts may cover it.
    expect(container).not.toContainElement(screen.getByTestId('image-lightbox'));
    expect(screen.getByTestId('image-lightbox').parentElement).toBe(document.body);

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('a click in the preview never reaches what is behind the chip', async () => {
    const behind = vi.fn();
    const user = userEvent.setup();
    render(
      <div onClick={behind}>
        <AttachmentChip filename="photo.png" mime="image/png" previewUrl="/api/attachments/1/content" />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Preview photo.png' }));
    behind.mockClear();
    await user.click(screen.getByTestId('image-lightbox-full'));
    await user.click(screen.getByTestId('image-lightbox'));
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
    expect(behind).not.toHaveBeenCalled();
  });

  it('keeps the remove button separate from the preview', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<AttachmentChip filename="photo.png" mime="image/png" previewUrl="/api/attachments/1/content" onRemove={onRemove} />);

    await user.click(screen.getByRole('button', { name: 'Remove photo.png' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('offers no preview for a file, or for an image with no previewable URL', () => {
    const { rerender } = render(<AttachmentChip filename="report.pdf" mime="application/pdf" previewUrl="/api/attachments/1/content" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<AttachmentChip filename="evil.svg" mime="image/svg+xml" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('falls back to the icon, with no preview, when the image is gone', () => {
    const { container } = render(<AttachmentChip filename="photo.png" mime="image/png" previewUrl="/api/attachments/1/content" />);

    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('photo.png')).toBeInTheDocument();
  });
});
