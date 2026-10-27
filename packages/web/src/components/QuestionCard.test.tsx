import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../state/api.js';
import { QuestionCard } from './QuestionCard.js';

const ask = {
  kind: 'question' as const, toolName: 'ask_user', id: 'a1', chatId: 'c1', messageId: 'm1',
  questions: [
    { question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], multiSelect: false },
    { question: 'Which sizes?', header: 'Sizes', options: [{ label: 'S', description: '' }, { label: 'M', description: '' }], multiSelect: true },
  ],
};

describe('QuestionCard', () => {
  afterEach(cleanup);
  it('sends one answer per question, multi-select joined with ", ", only once every question has one', async () => {
    const onAnswer = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<QuestionCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    expect(screen.getByText('Sonnet asks')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /^Blue/ }));
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /^S$/ }));
    await user.click(screen.getByRole('checkbox', { name: /^M$/ }));
    await user.click(send);
    expect(onAnswer).toHaveBeenCalledWith('a1', { answers: ['Blue', 'S, M'] });
  });
  it('puts two or more questions on tabs, one showing at a time, and moves on after a single-select pick', async () => {
    const user = userEvent.setup();
    render(<QuestionCard ask={ask} profileName="Sonnet" onAnswer={vi.fn(async () => {})} />);
    const colour = screen.getByRole('tab', { name: 'Colour' });
    const sizes = screen.getByRole('tab', { name: 'Sizes' });
    expect(colour).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Which colour?')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /^S$/ })).toBeNull();
    expect(screen.getByText(/Answer all 2 questions to send/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /^Red/ }));
    expect(sizes).toHaveAttribute('aria-selected', 'true');
    expect(colour).toHaveAttribute('data-answered', 'true');
    expect(screen.queryByRole('radio', { name: /^Red/ })).toBeNull();

    await user.click(colour);
    expect(screen.getByRole('radio', { name: /^Red/ })).toBeChecked();
    colour.focus();
    await user.keyboard('{ArrowRight}');
    expect(sizes).toHaveFocus();
    expect(sizes).toHaveAttribute('aria-selected', 'true');
  });
  it('shows a lone question without tabs', () => {
    render(<QuestionCard ask={{ ...ask, questions: [ask.questions[0]!] }} profileName="Sonnet" onAnswer={vi.fn(async () => {})} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('Colour')).toBeInTheDocument();
  });
  it('takes a typed answer through Other', async () => {
    const onAnswer = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<QuestionCard ask={{ ...ask, questions: [ask.questions[0]!] }} profileName="Sonnet" onAnswer={onAnswer} />);
    await user.click(screen.getByRole('radio', { name: 'Other' }));
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Your answer to: Which colour?' }), 'Teal');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onAnswer).toHaveBeenCalledWith('a1', { answers: ['Teal'] });
  });
  it('Skip declines', async () => {
    const onAnswer = vi.fn(async () => {});
    render(<QuestionCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip' }));
    expect(onAnswer).toHaveBeenCalledWith('a1', { declined: true });
  });
  it('re-enables the buttons with an error when sending fails', async () => {
    const onAnswer = vi.fn(async () => { throw new Error('offline'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<QuestionCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText('Could not send that answer. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  });
  it("shows the server's reason when it refuses the answer with a 400", async () => {
    const onAnswer = vi.fn(async () => { throw new ApiError(400, 'An answer can be at most 4000 characters.'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<QuestionCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText('An answer can be at most 4000 characters.')).toBeInTheDocument();
    expect(screen.queryByText('Could not send that answer. Please try again.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  });
});
