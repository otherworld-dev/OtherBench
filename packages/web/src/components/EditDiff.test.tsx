import { cleanup, render, screen } from '@testing-library/react';
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
});
