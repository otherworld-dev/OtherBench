import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
