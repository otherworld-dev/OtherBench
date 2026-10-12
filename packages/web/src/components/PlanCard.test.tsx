import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
