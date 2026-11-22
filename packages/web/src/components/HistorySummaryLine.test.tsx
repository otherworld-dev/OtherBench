import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HistorySummaryLine } from './HistorySummaryLine.js';

describe('HistorySummaryLine', () => {
  afterEach(cleanup);

  it('says in plain words what the model is sent, with the summary closed', () => {
    render(<HistorySummaryLine text="- The user wants a CSV export." />);
    expect(screen.getByText('Earlier messages are summarised for the model from here up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show summary' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('The user wants a CSV export.')).toBeNull();
  });

  it('opens the summary, says the messages are still there, and closes it again', () => {
    render(<HistorySummaryLine text="- The user wants a CSV export." />);
    fireEvent.click(screen.getByRole('button', { name: 'Show summary' }));
    expect(screen.getByText('The user wants a CSV export.')).toBeInTheDocument();
    expect(screen.getByText('The model reads this in place of the messages above. They are all still in the chat.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide summary' }));
    expect(screen.queryByText('The user wants a CSV export.')).toBeNull();
  });
});
