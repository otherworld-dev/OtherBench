import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
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
});
