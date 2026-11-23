import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useOtherBenchStore } from '../state/store.js';
import { ChatStatusCard } from './ChatStatusCard.js';

beforeEach(() => useOtherBenchStore.setState({ composerPrefills: {} }));
afterEach(cleanup);

const TOKEN = { text: 'set the token', who: 'you' as const, ask: 'Give it **read and write**, then save.' };
const VAT = { text: 'close the VAT page', who: 'you' as const, ask: 'Close it anywhere it is open.' };
const RETRY = { text: 'retry locked pages', who: 'you' as const, when: 'optional' as const, ask: 'Retry a locked page once by itself?', options: ['Yes', 'No'] };
const ISSUE = { text: 'first Budget issue', who: 'you' as const, when: 'later' as const, ask: 'Tap Work on it now.' };

describe('ChatStatusCard', () => {
  it('lists every group in full when nothing needs the user', () => {
    render(<ChatStatusCard status={{ done: false, left: [{ text: 'docs', who: 'parked' }, { text: 'push', who: 'me' }] }} />);
    const groups = screen.getByTestId('chat-status-card').querySelectorAll('[data-group]');
    expect([...groups].map((g) => g.getAttribute('data-group'))).toEqual(['me', 'parked']);
    expect(within(screen.getByRole('list', { name: 'Next from me' })).getByText('push')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Parked' })).getByText('docs')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-status-rest')).toBeNull();
  });

  it('puts what needs the user first and folds the rest into one line', () => {
    render(<ChatStatusCard status={{ done: false, left: [{ text: 'docs', who: 'parked' }, ISSUE, { text: 'push', who: 'me' }, TOKEN, RETRY] }} />);
    expect(screen.getByText('Needs you now (1):')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Needs you now' })).getByText('set the token')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Optional' })).getByText('retry locked pages')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Parked' })).toBeNull();
    const fold = screen.getByRole('button', { name: /Not waiting on you: 1 for you later · 1 next from me · 1 parked/ });
    fireEvent.click(fold);
    expect(within(screen.getByRole('list', { name: 'For you later' })).getByText('first Budget issue')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Parked' })).getByText('docs')).toBeInTheDocument();
  });

  it('shows the only thing to do with its ask open, as Markdown', () => {
    render(<ChatStatusCard status={{ done: false, left: [{ text: 'sudo on the proxy', who: 'you', ask: 'Run this on the proxy, then reply `SUDO_READY`:\n\n```bash\nsudo visudo -c\n```' }, { text: 'push', who: 'me' }] }} />);
    const ask = within(screen.getByRole('list', { name: 'Needs you now' })).getByTestId('chat-status-ask');
    expect(ask).toHaveTextContent('Run this on the proxy, then reply SUDO_READY');
    expect(ask.querySelector('pre code')).toHaveTextContent('sudo visudo -c');
  });

  it('keeps several things to do to a line each, and opens one on a click', () => {
    render(<ChatStatusCard status={{ done: false, left: [TOKEN, VAT] }} />);
    expect(screen.queryByTestId('chat-status-ask')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'close the VAT page' }));
    expect(screen.getByTestId('chat-status-ask')).toHaveTextContent('Close it anywhere it is open.');
    fireEvent.click(screen.getByRole('button', { name: 'close the VAT page' }));
    expect(screen.queryByTestId('chat-status-ask')).toBeNull();
  });

  it("puts the ticks and answers into the chat's message box as one message", () => {
    render(<ChatStatusCard status={{ done: false, left: [TOKEN, VAT, RETRY] }} chatId="c1" active />);
    expect(screen.queryByTestId('chat-status-reply')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done: set the token' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Answer: retry locked pages' })).getByRole('button', { name: 'No' }));
    expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Reply with these 2' }));
    expect(useOtherBenchStore.getState().composerPrefills.c1).toBe('Done: set the token\nretry locked pages: No');
    // Handed over: the card starts again.
    expect(screen.getByRole('checkbox', { name: 'Done: set the token' })).not.toBeChecked();
    expect(screen.queryByTestId('chat-status-reply')).toBeNull();
  });

  it('takes an answer back when it is clicked again, and swaps it for another', () => {
    render(<ChatStatusCard status={{ done: false, left: [TOKEN, RETRY] }} chatId="c1" active />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Reply with this' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.queryByTestId('chat-status-reply')).toBeNull();
  });

  it("offers no ticks or answers on an earlier reply's card", () => {
    render(<ChatStatusCard status={{ done: false, left: [TOKEN, RETRY] }} chatId="c1" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry locked pages' }));
    expect(screen.getByTestId('chat-status-ask')).toHaveTextContent('Answers: Yes / No');
  });

  it('heads untagged items from older replies as Left', () => {
    render(<ChatStatusCard status={{ done: false, left: [{ text: 'push' }] }} />);
    expect(within(screen.getByRole('list', { name: 'Left' })).getByText('push')).toBeInTheDocument();
  });

  it('says Done when nothing is left', () => {
    render(<ChatStatusCard status={{ done: true, left: [] }} />);
    expect(screen.getByTestId('chat-status-card')).toHaveTextContent('Done: nothing left in this chat');
  });
});
