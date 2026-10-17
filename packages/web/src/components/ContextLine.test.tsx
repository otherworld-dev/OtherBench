import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextLine } from './ContextLine.js';

describe('ContextLine', () => {
  afterEach(cleanup);

  it('is a separator labelled Context cleared', () => {
    render(<ContextLine kind="clear" at={0} />);
    expect(screen.getByRole('separator')).toHaveTextContent('Context cleared');
  });

  it('says Context compacted and shows the focus under it', () => {
    render(<ContextLine kind="compact" focus="keep the API decisions" at={0} />);
    expect(screen.getByRole('separator')).toHaveTextContent('Context compacted');
    expect(screen.getByText('keep the API decisions')).toBeInTheDocument();
  });
});
