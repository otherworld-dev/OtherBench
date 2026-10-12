import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../state/api.js';
import { PlanCard } from './PlanCard.js';

const ask = { kind: 'plan' as const, toolName: 'propose_plan', plan: '1. Write **planned.txt**', id: 'p1', chatId: 'c1', messageId: 'm1' };

describe('PlanCard', () => {
  afterEach(cleanup);
  it('shows the plan as Markdown and approves it', async () => {
    const onAnswer = vi.fn(async () => {});
    render(<PlanCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    expect(screen.getByText('planned.txt').tagName).toBe('STRONG');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve plan' }));
    expect(onAnswer).toHaveBeenCalledWith('p1', { approve: true });
  });
  it('asks for changes with a note', async () => {
    const onAnswer = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<PlanCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await user.click(screen.getByRole('button', { name: 'Ask for changes' }));
    const send = screen.getByRole('button', { name: 'Send changes' });
    expect(send).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Changes to the plan' }), 'smaller');
    await user.click(send);
    expect(onAnswer).toHaveBeenCalledWith('p1', { changes: 'smaller' });
  });
  it('moves keyboard focus to the note, and back to Ask for changes on Cancel', async () => {
    const user = userEvent.setup();
    render(<PlanCard ask={ask} profileName="Sonnet" onAnswer={vi.fn(async () => {})} />);
    await user.click(screen.getByRole('button', { name: 'Ask for changes' }));
    expect(screen.getByRole('textbox', { name: 'Changes to the plan' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toHaveFocus();
  });
  it('shows the generic error and re-enables the buttons when sending fails', async () => {
    const onAnswer = vi.fn(async () => { throw new Error('offline'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PlanCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve plan' }));
    expect(await screen.findByText('Could not send that answer. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeEnabled();
  });
  it("shows the server's reason when it refuses with a 400", async () => {
    const onAnswer = vi.fn(async () => { throw new ApiError(400, 'An answer can be at most 4000 characters.'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PlanCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve plan' }));
    expect(await screen.findByText('An answer can be at most 4000 characters.')).toBeInTheDocument();
    expect(screen.queryByText('Could not send that answer. Please try again.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeEnabled();
  });
});
