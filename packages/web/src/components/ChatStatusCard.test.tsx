import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ChatStatusCard } from './ChatStatusCard.js';

afterEach(cleanup);

describe('ChatStatusCard', () => {
  it('groups what is left by who it waits on: you first, then me, then parked', () => {
    render(<ChatStatusCard status={{ done: false, left: [{ text: 'docs', who: 'parked' }, { text: 'push', who: 'me' }, { text: 'try it live', who: 'you' }] }} />);
    const groups = screen.getByTestId('chat-status-card').querySelectorAll('[data-who]');
    expect([...groups].map((g) => g.getAttribute('data-who'))).toEqual(['you', 'me', 'parked']);
    expect(within(screen.getByRole('list', { name: 'Waiting on you' })).getByText('try it live')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Next from me' })).getByText('push')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Parked' })).getByText('docs')).toBeInTheDocument();
  });

  it('leaves out a group with nothing in it', () => {
    render(<ChatStatusCard status={{ done: false, left: [{ text: 'push', who: 'me' }] }} />);
    expect(screen.queryByText('Waiting on you:')).toBeNull();
    expect(screen.getByText('Next from me:')).toBeInTheDocument();
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
