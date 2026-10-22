import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditDiff } from './EditDiff.js';
import type { EditDiffInfo } from '../lib/editDiff.js';

afterEach(cleanup);

const info: EditDiffInfo = {
  path: 'src/a.ts',
  lines: [
    { kind: 'ctx', text: 'keep' },
    { kind: 'del', text: 'old line' },
    { kind: 'add', text: 'new line' },
  ],
  added: 1,
  removed: 1,
  isNewFile: false,
};

describe('EditDiff', () => {
  it('shows the path, counts and distinct del/add rows', () => {
    render(<EditDiff info={info} />);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('+1 −1')).toBeInTheDocument();
    const del = screen.getByText('old line').closest('[data-diff]');
    const add = screen.getByText('new line').closest('[data-diff]');
    expect(del).toHaveAttribute('data-diff', 'del');
    expect(add).toHaveAttribute('data-diff', 'add');
    expect(del!.className).not.toBe(add!.className);
  });

  it('marks a failed and a pending edit', () => {
    const { rerender } = render(<EditDiff info={info} status="failed" />);
    expect(screen.getByText('failed')).toBeInTheDocument();
    rerender(<EditDiff info={info} status="pending" />);
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('shows the cut-off row', () => {
    render(<EditDiff info={{ ...info, truncated: 50 }} />);
    expect(screen.getByText('+50 more lines')).toBeInTheDocument();
  });

  it('says added and removed in text for a screen reader', () => {
    render(<EditDiff info={info} />);
    expect(screen.getByText('removed')).toHaveClass('sr-only');
    expect(screen.getByText('added')).toHaveClass('sr-only');
  });

  it("clips its rows' sr-only labels in its own scroll box, so a long diff can't stretch the thread with empty space", () => {
    render(<EditDiff info={info} defaultOpen />);
    // An absolute label escapes an overflow box that isn't positioned; jsdom has no layout, so the class is what's checked.
    expect(screen.getByText('added').parentElement!.parentElement).toHaveClass('relative', 'overflow-auto');
  });

  it('starts folded to its header, and expands when the header is clicked', () => {
    render(<EditDiff info={info} />);
    const diff = screen.getByTestId('edit-diff');
    expect(diff).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(diff).toHaveAttribute('open');
  });

  it('starts open with defaultOpen', () => {
    render(<EditDiff info={info} defaultOpen />);
    expect(screen.getByTestId('edit-diff')).toHaveAttribute('open');
  });

  it('labels a Write as wrote, not new file, and shows a muted gap row', () => {
    render(<EditDiff info={{ ...info, isNewFile: true, lines: [...info.lines, { kind: 'gap', text: '' }] }} />);
    expect(screen.getByText('wrote')).toBeInTheDocument();
    expect(screen.queryByText('new file')).toBeNull();
    expect(screen.getByText('…').closest('[data-diff]')).toHaveAttribute('data-diff', 'gap');
  });
});
